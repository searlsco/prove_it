const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { gitDiffFiles, sanitizeRefName, readRef, updateRef, snapshotWorkingTree, deleteAllRefs, churnSinceRef, advanceChurnRef } = require('../lib/git')

describe('gitDiffFiles', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_gdf_'))
    spawnSync('git', ['init'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'original a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'original b\n')
    fs.writeFileSync(path.join(tmpDir, 'c.js'), 'original c\n')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns diff scoped to specified files only', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'changed a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'changed b\n')

    // Only ask for a.js — should not include b.js changes
    const diff = gitDiffFiles(tmpDir, head, ['a.js'])
    assert.ok(diff.includes('changed a'), 'Should include a.js changes')
    assert.ok(!diff.includes('changed b'), 'Should NOT include b.js changes')
  })

  it('returns empty string when no changes in specified files', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'changed b\n')

    // Only ask for a.js — which hasn't changed
    const diff = gitDiffFiles(tmpDir, head, ['a.js'])
    assert.strictEqual(diff, '')
  })

  it('returns empty string when baseHead is null', () => {
    const diff = gitDiffFiles(tmpDir, null, ['a.js'])
    assert.strictEqual(diff, '')
  })

  it('returns empty string when files array is empty', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'changed\n')
    const diff = gitDiffFiles(tmpDir, head, [])
    assert.strictEqual(diff, '')
  })

  it('returns empty string when files is null', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    const diff = gitDiffFiles(tmpDir, head, null)
    assert.strictEqual(diff, '')
  })

  it('includes multiple specified files', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'changed a\n')
    fs.writeFileSync(path.join(tmpDir, 'c.js'), 'changed c\n')

    const diff = gitDiffFiles(tmpDir, head, ['a.js', 'c.js'])
    assert.ok(diff.includes('changed a'), 'Should include a.js changes')
    assert.ok(diff.includes('changed c'), 'Should include c.js changes')
  })
})

function initGitRepo (dir) {
  spawnSync('git', ['init'], { cwd: dir })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
}

function commit (dir, msg) {
  spawnSync('git', ['add', '.'], { cwd: dir })
  spawnSync('git', ['commit', '-m', msg], { cwd: dir })
}

function getHead (dir) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}

describe('sanitizeRefName', () => {
  it('passes through safe names', () => {
    assert.strictEqual(sanitizeRefName('my-task'), 'my-task')
    assert.strictEqual(sanitizeRefName('task_1.0'), 'task_1.0')
  })

  it('replaces spaces and special chars', () => {
    assert.strictEqual(sanitizeRefName('my task'), 'my_task')
    assert.strictEqual(sanitizeRefName('foo/bar:baz'), 'foo_bar_baz')
  })

  it('handles empty/null input', () => {
    assert.strictEqual(sanitizeRefName(''), '')
    assert.strictEqual(sanitizeRefName(null), '')
  })
})

describe('readRef / updateRef', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_ref_'))
    initGitRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'initial\n')
    commit(tmpDir, 'init')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readRef returns null when ref does not exist', () => {
    assert.strictEqual(readRef(tmpDir, 'nonexistent'), null)
  })

  it('updateRef creates ref and readRef reads it back', () => {
    const head = getHead(tmpDir)
    updateRef(tmpDir, 'my-task', head)
    assert.strictEqual(readRef(tmpDir, 'my-task'), head)
  })

  it('updateRef advances ref to a new commit', () => {
    const head1 = getHead(tmpDir)
    updateRef(tmpDir, 'my-task', head1)

    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'changed\n')
    commit(tmpDir, 'change')
    const head2 = getHead(tmpDir)

    updateRef(tmpDir, 'my-task', head2)
    assert.strictEqual(readRef(tmpDir, 'my-task'), head2)
    assert.notStrictEqual(head1, head2)
  })
})

describe('churnSinceRef', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_churn_'))
    initGitRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'initial\n')
    commit(tmpDir, 'init')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 0 on bootstrap (creates ref at HEAD)', () => {
    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.strictEqual(churn, 0)
    assert.strictEqual(readRef(tmpDir, 'my-task'), getHead(tmpDir))
  })

  it('counts additions and deletions for source globs', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'line1\nline2\nline3\n')
    commit(tmpDir, 'add lines')

    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    // original: 1 line "initial", new: 3 lines → 1 deletion + 3 additions = 4
    assert.ok(churn > 0, `Expected positive churn, got ${churn}`)
  })

  it('filters by source globs', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'lots\nof\nchanges\n')
    commit(tmpDir, 'add readme')

    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.strictEqual(churn, 0, 'Non-matching files should not count')
  })

  it('returns 0 in non-git directory', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
    try {
      assert.strictEqual(churnSinceRef(nonGitDir, 'my-task', ['**/*']), 0)
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }
  })

  it('returns 0 when ref matches HEAD (no new changes)', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', ['**/*.js']), 0)
  })

  it('counts churn from multiple commits', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'aaa\n')
    commit(tmpDir, 'add a')
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'bbb\nccc\n')
    commit(tmpDir, 'add b')

    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.ok(churn >= 3, `Expected at least 3, got ${churn}`)
  })

  it('resets churn after ref is advanced', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'changed\n')
    commit(tmpDir, 'change')

    const churn1 = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.ok(churn1 > 0, `Expected churn, got ${churn1}`)

    updateRef(tmpDir, 'my-task', getHead(tmpDir))

    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', ['**/*.js']), 0)
  })

  it('counts uncommitted (unstaged) working tree changes', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    // Write to a file but do NOT commit — simulates Write/Edit tool calls
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'line1\nline2\nline3\n')

    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.ok(churn > 0, `Expected uncommitted churn > 0, got ${churn}`)
  })

  it('counts staged but uncommitted changes', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'staged1\nstaged2\n')
    spawnSync('git', ['add', 'file.js'], { cwd: tmpDir })

    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.ok(churn > 0, `Expected staged churn > 0, got ${churn}`)
  })

  it('returns 0 when ref points to nonexistent commit (stale ref)', () => {
    // Create a ref pointing to a bogus SHA
    const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    updateRef(tmpDir, 'stale-task', getHead(tmpDir))
    // Manually overwrite to a nonexistent SHA via update-ref
    spawnSync('git', ['update-ref', 'refs/worktree/prove_it/stale-task', bogus], { cwd: tmpDir })

    // git diff will fail because the commit doesn't exist — should return 0
    const churn = churnSinceRef(tmpDir, 'stale-task', ['**/*.js'])
    assert.strictEqual(churn, 0, 'Should return 0 for stale/orphaned ref')
  })
})

describe('snapshotWorkingTree', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_snap_'))
    initGitRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'initial\n')
    commit(tmpDir, 'init')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns HEAD when working tree is clean', () => {
    const snap = snapshotWorkingTree(tmpDir, ['**/*.js'])
    assert.strictEqual(snap, getHead(tmpDir))
  })

  it('returns a stash SHA (not HEAD) when working tree is dirty', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'modified\n')
    const snap = snapshotWorkingTree(tmpDir, ['**/*.js'])
    assert.ok(snap, 'Should return a SHA')
    assert.notStrictEqual(snap, getHead(tmpDir), 'Stash SHA should differ from HEAD')
  })

  it('diff from stash SHA to same working tree shows 0 changes', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'modified\n')
    const snap = snapshotWorkingTree(tmpDir, ['**/*.js'])
    const r = spawnSync('git', ['diff', '--numstat', snap], { cwd: tmpDir, encoding: 'utf8' })
    assert.strictEqual(r.stdout.trim(), '', 'Diff from stash to same working tree should be empty')
  })

  it('resets churn to 0 when ref is advanced to snapshot (deadlock fix)', () => {
    // Bootstrap the ref
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    // Simulate agent Write — uncommitted changes to a tracked file
    const lines = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'file.js'), lines)
    assert.ok(churnSinceRef(tmpDir, 'my-task', ['**/*.js']) >= 500,
      'Should see uncommitted churn')

    // Simulate resetOnFail: advance ref to working tree snapshot (not HEAD!)
    const snap = snapshotWorkingTree(tmpDir, ['**/*.js'])
    updateRef(tmpDir, 'my-task', snap)

    // Churn should now be 0 — the ref captures the working tree state
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', ['**/*.js']), 0,
      'Churn should be 0 after advancing ref to working tree snapshot')
  })

  it('resets churn to 0 for untracked files after snapshot (new-file deadlock fix)', () => {
    // Bootstrap the ref
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    // Simulate agent Write creating a brand new file (untracked)
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'brand_new.js'), lines)
    assert.ok(churnSinceRef(tmpDir, 'my-task', ['**/*.js']) >= 100,
      'Should see untracked file churn')

    // Simulate resetOnFail: snapshot captures untracked files via git add + stash
    const snap = snapshotWorkingTree(tmpDir, ['**/*.js'])
    updateRef(tmpDir, 'my-task', snap)

    // Churn should now be 0 — snapshot captured the untracked file
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', ['**/*.js']), 0,
      'Churn should be 0 after snapshot-advancing with untracked files')
  })

  it('only counts new changes after snapshot (pre-commit double-count fix)', () => {
    // Bootstrap
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    // Write + stage (simulating pre-commit)
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'line1\nline2\nline3\n')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })

    // Snapshot captures staged state, advance ref
    const snap = snapshotWorkingTree(tmpDir, ['**/*.js'])
    updateRef(tmpDir, 'my-task', snap)

    // Now commit (HEAD moves past the ref)
    spawnSync('git', ['commit', '-m', 'add lines'], { cwd: tmpDir })

    // Without new edits, churn should be 0 — the snapshot captured the pre-commit state
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', ['**/*.js']), 0,
      'Churn should be 0 after commit when ref was snapshot-advanced')

    // Add a small new edit — only THIS should count
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'line1\nline2\nline3\nnew_line\n')
    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.strictEqual(churn, 1, 'Only the new line should count as churn')
  })

  it('counts untracked new files as churn', () => {
    // Bootstrap
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    // Create a brand new file (untracked) — simulates Write creating a new source file
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'brand_new.js'), lines)

    // Untracked source files MUST count as churn (via temporary git add -N)
    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.strictEqual(churn, 100, 'Untracked source files should count as churn')
  })

  it('leaves untracked files untracked after churn counting', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    fs.writeFileSync(path.join(tmpDir, 'brand_new.js'), 'content\n')

    // Count churn (internally does git add -N + git reset)
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    // File should still be untracked — git add -N was undone
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf8' })
    assert.ok(r.stdout.includes('?? brand_new.js'), 'File should remain untracked after churn counting')
  })

  it('leaves untracked files untracked after snapshot', () => {
    fs.writeFileSync(path.join(tmpDir, 'brand_new.js'), 'content\n')

    // Snapshot (internally does git add + stash create + git reset)
    snapshotWorkingTree(tmpDir, ['**/*.js'])

    // File should still be untracked
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf8' })
    assert.ok(r.stdout.includes('?? brand_new.js'), 'File should remain untracked after snapshot')
  })

  it('filters untracked files by source globs', () => {
    churnSinceRef(tmpDir, 'my-task', ['**/*.js'])

    // Create files matching and not matching the glob
    fs.writeFileSync(path.join(tmpDir, 'source.js'), 'line1\nline2\n')
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'lots\nof\ntext\n')

    const churn = churnSinceRef(tmpDir, 'my-task', ['**/*.js'])
    assert.strictEqual(churn, 2, 'Only .js untracked file should count')
  })
})

describe('deleteAllRefs', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_delrefs_'))
    initGitRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'initial\n')
    commit(tmpDir, 'init')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deletes all prove_it refs and returns count', () => {
    const head = getHead(tmpDir)
    updateRef(tmpDir, 'task-a', head)
    updateRef(tmpDir, 'task-b', head)
    updateRef(tmpDir, 'task-c', head)

    assert.strictEqual(readRef(tmpDir, 'task-a'), head)
    assert.strictEqual(readRef(tmpDir, 'task-b'), head)

    const count = deleteAllRefs(tmpDir)
    assert.strictEqual(count, 3)

    assert.strictEqual(readRef(tmpDir, 'task-a'), null)
    assert.strictEqual(readRef(tmpDir, 'task-b'), null)
    assert.strictEqual(readRef(tmpDir, 'task-c'), null)
  })

  it('returns 0 when no refs exist', () => {
    assert.strictEqual(deleteAllRefs(tmpDir), 0)
  })

  it('returns 0 in non-git directory', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
    try {
      assert.strictEqual(deleteAllRefs(nonGitDir), 0)
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }
  })
})

describe('advanceChurnRef', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_acr_'))
    initGitRepo(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'initial\n')
    commit(tmpDir, 'init')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeChurn () {
    churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js'])
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'file.js'), lines)
  }

  function task (overrides) {
    return { name: 'my-task', when: { linesWrittenSinceLastRun: 5 }, ...overrides }
  }

  it('does nothing when task has no linesWrittenSinceLastRun', () => {
    const refBefore = readRef(tmpDir, sanitizeRefName('no-churn'))
    advanceChurnRef({ name: 'no-churn', when: { fileExists: 'x' } }, true, 'PreToolUse', tmpDir, ['**/*.js'])
    assert.strictEqual(readRef(tmpDir, sanitizeRefName('no-churn')), refBefore)
  })

  it('always advances ref on pass regardless of event', () => {
    makeChurn()
    assert.ok(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']) > 0)

    advanceChurnRef(task(), true, 'Stop', tmpDir, ['**/*.js'])

    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']), 0,
      'Ref should advance on pass even for Stop event')
  })

  it('advances ref on PreToolUse fail (default resetOnFail: true)', () => {
    makeChurn()
    assert.ok(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']) > 0)

    advanceChurnRef(task(), false, 'PreToolUse', tmpDir, ['**/*.js'])

    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']), 0,
      'PreToolUse should default to resetting churn on failure')
  })

  it('does NOT advance ref on Stop fail (default resetOnFail: false)', () => {
    makeChurn()
    const churnBefore = churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js'])
    assert.ok(churnBefore > 0)

    advanceChurnRef(task(), false, 'Stop', tmpDir, ['**/*.js'])

    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']), churnBefore,
      'Stop should default to NOT resetting churn on failure')
  })

  it('does NOT advance ref on pre-commit fail (default resetOnFail: false)', () => {
    makeChurn()
    const churnBefore = churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js'])
    assert.ok(churnBefore > 0)

    advanceChurnRef(task(), false, 'pre-commit', tmpDir, ['**/*.js'])

    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']), churnBefore,
      'Git hooks should default to NOT resetting churn on failure')
  })

  it('explicit resetOnFail: false overrides PreToolUse default', () => {
    makeChurn()
    const churnBefore = churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js'])
    assert.ok(churnBefore > 0)

    advanceChurnRef(task({ resetOnFail: false }), false, 'PreToolUse', tmpDir, ['**/*.js'])

    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']), churnBefore,
      'Explicit resetOnFail: false should prevent reset even on PreToolUse')
  })

  it('explicit resetOnFail: true overrides Stop default', () => {
    makeChurn()
    assert.ok(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']) > 0)

    advanceChurnRef(task({ resetOnFail: true }), false, 'Stop', tmpDir, ['**/*.js'])

    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), ['**/*.js']), 0,
      'Explicit resetOnFail: true should reset churn even on Stop')
  })
})
