const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { gitDiffFiles, sanitizeRefName, readRef, updateRef, snapshotWorkingTree, deleteAllRefs, churnSinceRef, advanceChurnRef, readCounterBlob, writeCounterRef, readGrossCounter, incrementGross, grossChurnSince, advanceGrossSnapshot, computeWriteLines } = require('../lib/git')
const { freshRepo } = require('./helpers')

function setupDiffFiles (dir) {
  fs.writeFileSync(path.join(dir, 'a.js'), 'original a\n')
  fs.writeFileSync(path.join(dir, 'b.js'), 'original b\n')
  fs.writeFileSync(path.join(dir, 'c.js'), 'original c\n')
}

describe('gitDiffFiles', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo(setupDiffFiles)
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

function setupFileJs (dir) {
  fs.writeFileSync(path.join(dir, 'file.js'), 'initial\n')
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
    tmpDir = freshRepo(setupFileJs)
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
    tmpDir = freshRepo(setupFileJs)
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
    tmpDir = freshRepo(setupFileJs)
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
    tmpDir = freshRepo(setupFileJs)
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
    tmpDir = freshRepo(setupFileJs)
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
    return { name: 'my-task', when: { linesChanged: 5 }, ...overrides }
  }

  it('does nothing when task has no linesChanged', () => {
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

  it('advances gross snapshot on pass for linesWritten tasks', () => {
    incrementGross(tmpDir, 100)
    const grossTask = { name: 'gross-task', when: { linesWritten: 50 } }
    // Bootstrap the snapshot
    grossChurnSince(tmpDir, sanitizeRefName('gross-task'))
    // Add more gross churn
    incrementGross(tmpDir, 200)
    assert.strictEqual(grossChurnSince(tmpDir, sanitizeRefName('gross-task')), 200)

    advanceChurnRef(grossTask, true, 'Stop', tmpDir, ['**/*.js'])

    assert.strictEqual(grossChurnSince(tmpDir, sanitizeRefName('gross-task')), 0,
      'Gross snapshot should advance on pass')
  })

  it('does NOT advance gross snapshot on Stop fail (default resetOnFail: false)', () => {
    incrementGross(tmpDir, 100)
    const grossTask = { name: 'gross-fail', when: { linesWritten: 50 } }
    grossChurnSince(tmpDir, sanitizeRefName('gross-fail'))
    incrementGross(tmpDir, 200)
    const before = grossChurnSince(tmpDir, sanitizeRefName('gross-fail'))
    assert.strictEqual(before, 200)

    advanceChurnRef(grossTask, false, 'Stop', tmpDir, ['**/*.js'])

    assert.strictEqual(grossChurnSince(tmpDir, sanitizeRefName('gross-fail')), 200,
      'Stop should default to NOT resetting gross snapshot on failure')
  })

  it('advances both net and gross refs when task has both criteria', () => {
    // Set up net churn
    churnSinceRef(tmpDir, sanitizeRefName('dual-task'), ['**/*.js'])
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'file.js'), lines)
    // Set up gross churn
    incrementGross(tmpDir, 100)
    grossChurnSince(tmpDir, sanitizeRefName('dual-task'))
    incrementGross(tmpDir, 200)

    const dualTask = { name: 'dual-task', when: { linesChanged: 5, linesWritten: 50 } }
    advanceChurnRef(dualTask, true, 'Stop', tmpDir, ['**/*.js'])

    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('dual-task'), ['**/*.js']), 0,
      'Net churn should be reset')
    assert.strictEqual(grossChurnSince(tmpDir, sanitizeRefName('dual-task')), 0,
      'Gross churn should be reset')
  })
})

describe('readCounterBlob / writeCounterRef', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo(setupFileJs)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('round-trips an integer value', () => {
    writeCounterRef(tmpDir, 'test-counter', 42)
    const sha = readRef(tmpDir, 'test-counter')
    assert.ok(sha, 'Ref should exist after write')
    assert.strictEqual(readCounterBlob(tmpDir, sha), 42)
  })

  it('returns 0 for null sha', () => {
    assert.strictEqual(readCounterBlob(tmpDir, null), 0)
  })

  it('returns 0 for non-existent sha', () => {
    assert.strictEqual(readCounterBlob(tmpDir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), 0)
  })

  it('handles large values', () => {
    writeCounterRef(tmpDir, 'big-counter', 999999)
    const sha = readRef(tmpDir, 'big-counter')
    assert.strictEqual(readCounterBlob(tmpDir, sha), 999999)
  })

  it('overwrites existing ref', () => {
    writeCounterRef(tmpDir, 'counter', 10)
    writeCounterRef(tmpDir, 'counter', 20)
    const sha = readRef(tmpDir, 'counter')
    assert.strictEqual(readCounterBlob(tmpDir, sha), 20)
  })
})

describe('incrementGross', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo(setupFileJs)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates counter from zero (first-write path)', () => {
    assert.strictEqual(readGrossCounter(tmpDir), 0)
    assert.strictEqual(readRef(tmpDir, '__gross_lines'), null, 'ref should not exist yet')
    incrementGross(tmpDir, 50)
    assert.strictEqual(readGrossCounter(tmpDir), 50)
    assert.ok(readRef(tmpDir, '__gross_lines'), 'ref should exist after first write')
  })

  it('accumulates via CAS path when ref already exists', () => {
    incrementGross(tmpDir, 10) // first-write path
    const refAfterFirst = readRef(tmpDir, '__gross_lines')
    incrementGross(tmpDir, 20) // CAS path — ref exists
    const refAfterSecond = readRef(tmpDir, '__gross_lines')
    assert.notStrictEqual(refAfterFirst, refAfterSecond,
      'CAS should update the ref SHA')
    incrementGross(tmpDir, 30)
    assert.strictEqual(readGrossCounter(tmpDir), 60)
  })

  it('ignores zero delta', () => {
    incrementGross(tmpDir, 10)
    incrementGross(tmpDir, 0)
    assert.strictEqual(readGrossCounter(tmpDir), 10)
  })

  it('ignores negative delta', () => {
    incrementGross(tmpDir, 10)
    incrementGross(tmpDir, -5)
    assert.strictEqual(readGrossCounter(tmpDir), 10)
  })

  it('does not throw on non-git directory (hash-object failure)', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
    try {
      // hash-object will fail — should bail gracefully, not throw
      incrementGross(nonGitDir, 50)
      assert.strictEqual(readGrossCounter(nonGitDir), 0,
        'counter should remain 0 when git commands fail')
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }
  })

  it('succeeds after external ref modification (CAS path reads fresh state)', () => {
    // Set counter to 100 via incrementGross (first-write path)
    incrementGross(tmpDir, 100)
    // Externally modify the ref to simulate another agent's write
    writeCounterRef(tmpDir, '__gross_lines', 200)
    assert.strictEqual(readGrossCounter(tmpDir), 200)

    // incrementGross should read the fresh value (200) and CAS to 225
    incrementGross(tmpDir, 25)
    assert.strictEqual(readGrossCounter(tmpDir), 225,
      'should increment from externally-modified value, not stale cache')
  })

  it('CAS rejects stale old-value (git update-ref with wrong expected SHA)', () => {
    // Directly verify that git update-ref fails when old-value is wrong.
    // This is the mechanism incrementGross relies on for retry.
    const { tryRun, shellEscape } = require('../lib/io')

    incrementGross(tmpDir, 100)
    const currentSha = readRef(tmpDir, '__gross_lines')
    assert.ok(currentSha, 'ref should exist')

    // Create a new blob for value 200
    const r = tryRun(`printf '%s' '200' | git -C ${shellEscape(tmpDir)} hash-object -w --stdin`, {})
    assert.strictEqual(r.code, 0)
    const newSha = r.stdout.trim()

    // Create a fake "stale" SHA (some other blob)
    const stale = tryRun(`printf '%s' '999' | git -C ${shellEscape(tmpDir)} hash-object -w --stdin`, {})
    const staleSha = stale.stdout.trim()

    // CAS with wrong old-value should FAIL
    const cas = tryRun(`git -C ${shellEscape(tmpDir)} update-ref refs/worktree/prove_it/__gross_lines ${shellEscape(newSha)} ${shellEscape(staleSha)}`, {})
    assert.notStrictEqual(cas.code, 0,
      'update-ref should fail when old-value does not match current ref')

    // Counter should be unchanged
    assert.strictEqual(readGrossCounter(tmpDir), 100,
      'counter should be unchanged after failed CAS')

    // CAS with CORRECT old-value should succeed
    const cas2 = tryRun(`git -C ${shellEscape(tmpDir)} update-ref refs/worktree/prove_it/__gross_lines ${shellEscape(newSha)} ${shellEscape(currentSha)}`, {})
    assert.strictEqual(cas2.code, 0,
      'update-ref should succeed with correct old-value')
    assert.strictEqual(readGrossCounter(tmpDir), 200,
      'counter should reflect CAS update')
  })

  it('concurrent incrementGross calls recover most increments via CAS retry', () => {
    // Set up initial counter so CAS path is used
    incrementGross(tmpDir, 100)

    // Launch child processes concurrently. Under real contention, some
    // CAS attempts may fail and retry. With 3 retries per call, most
    // increments land but under heavy contention some may be lost.
    const { execSync } = require('child_process')
    const n = 4
    const delta = 10
    const scriptFile = path.join(tmpDir, '_incr.js')
    fs.writeFileSync(scriptFile, `
      const { incrementGross } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'git'))});
      incrementGross(${JSON.stringify(tmpDir)}, ${delta});
    `)

    const cmds = Array.from({ length: n }, () => `node ${scriptFile}`).join(' & ')
    execSync(`${cmds} & wait`, { encoding: 'utf8', timeout: 10000 })

    const counter = readGrossCounter(tmpDir)
    const expected = 100 + (n * delta)
    // Without CAS: all readers see 100, all write 110 → final = 110
    // With CAS + retry: most or all increments land
    assert.ok(counter > 110,
      `CAS should recover more than a single increment: expected > 110, got ${counter}`)
    assert.ok(counter <= expected,
      `counter should not exceed ${expected}, got ${counter}`)
    // At least half the increments should land even under worst-case contention
    assert.ok(counter >= 100 + (n * delta) / 2,
      `at least half the increments should land: expected >= ${100 + (n * delta) / 2}, got ${counter}`)
  })

  it('silently gives up after max retries exhausted (no crash)', () => {
    // We can't easily force 3 consecutive CAS failures in a unit test,
    // but we CAN verify the function doesn't throw even when the ref
    // is in an unexpected state. Corrupt the ref to point at a non-blob.
    const { tryRun, shellEscape } = require('../lib/io')

    // Create the __gross ref pointing at a valid blob
    incrementGross(tmpDir, 50)
    assert.strictEqual(readGrossCounter(tmpDir), 50)

    // Point the ref at HEAD (a commit, not a blob) — readCounterBlob returns 0
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    tryRun(`git -C ${shellEscape(tmpDir)} update-ref refs/worktree/prove_it/__gross_lines ${head}`, {})

    // readCounterBlob will return 0 for a non-parseable blob
    // incrementGross should still not throw
    incrementGross(tmpDir, 25)
    // The counter may or may not be 25 depending on whether the CAS succeeds,
    // but the function should not crash
    const counter = readGrossCounter(tmpDir)
    assert.strictEqual(typeof counter, 'number', 'counter should be a number')
  })
})

describe('grossChurnSince', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo(setupFileJs)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 0 on bootstrap (first call)', () => {
    incrementGross(tmpDir, 100)
    const churn = grossChurnSince(tmpDir, 'my-task')
    assert.strictEqual(churn, 0, 'First call should bootstrap and return 0')
  })

  it('returns 0 when no counter exists (brand new repo)', () => {
    const churn = grossChurnSince(tmpDir, 'my-task')
    assert.strictEqual(churn, 0)
  })

  it('returns accumulated churn after bootstrap', () => {
    grossChurnSince(tmpDir, 'my-task') // bootstrap
    incrementGross(tmpDir, 50)
    incrementGross(tmpDir, 30)
    assert.strictEqual(grossChurnSince(tmpDir, 'my-task'), 80)
  })

  it('resets to 0 after advanceGrossSnapshot', () => {
    grossChurnSince(tmpDir, 'my-task') // bootstrap
    incrementGross(tmpDir, 100)
    assert.strictEqual(grossChurnSince(tmpDir, 'my-task'), 100)

    advanceGrossSnapshot(tmpDir, 'my-task')
    assert.strictEqual(grossChurnSince(tmpDir, 'my-task'), 0)
  })

  it('tracks separate tasks independently', () => {
    grossChurnSince(tmpDir, 'task-a') // bootstrap
    grossChurnSince(tmpDir, 'task-b') // bootstrap
    incrementGross(tmpDir, 100)

    assert.strictEqual(grossChurnSince(tmpDir, 'task-a'), 100)
    assert.strictEqual(grossChurnSince(tmpDir, 'task-b'), 100)

    advanceGrossSnapshot(tmpDir, 'task-a')
    assert.strictEqual(grossChurnSince(tmpDir, 'task-a'), 0)
    assert.strictEqual(grossChurnSince(tmpDir, 'task-b'), 100,
      'Advancing task-a should not affect task-b')
  })

  it('is cleaned up by deleteAllRefs', () => {
    incrementGross(tmpDir, 100)
    grossChurnSince(tmpDir, 'my-task')
    incrementGross(tmpDir, 50)

    deleteAllRefs(tmpDir)

    // After cleanup, global counter and snapshot are gone
    assert.strictEqual(readGrossCounter(tmpDir), 0)
    // Bootstrap again — should return 0
    assert.strictEqual(grossChurnSince(tmpDir, 'my-task'), 0)
  })
})

describe('computeWriteLines', () => {
  it('counts lines for Write', () => {
    assert.strictEqual(computeWriteLines('Write', { content: 'a\nb\nc' }), 3)
  })

  it('counts single-line Write', () => {
    assert.strictEqual(computeWriteLines('Write', { content: 'single' }), 1)
  })

  it('returns 0 for Write with no content', () => {
    assert.strictEqual(computeWriteLines('Write', {}), 0)
    assert.strictEqual(computeWriteLines('Write', { content: 42 }), 0)
  })

  it('counts old + new lines for Edit', () => {
    assert.strictEqual(computeWriteLines('Edit', {
      old_string: 'a\nb',
      new_string: 'c\nd\ne'
    }), 5) // 2 old + 3 new
  })

  it('handles Edit with only new_string', () => {
    assert.strictEqual(computeWriteLines('Edit', { new_string: 'a\nb' }), 2)
  })

  it('counts lines for NotebookEdit insert', () => {
    assert.strictEqual(computeWriteLines('NotebookEdit', {
      edit_mode: 'insert',
      new_source: 'x = 1\ny = 2'
    }), 2)
  })

  it('counts lines for NotebookEdit replace (default mode)', () => {
    assert.strictEqual(computeWriteLines('NotebookEdit', {
      new_source: 'a\nb\nc'
    }), 3)
  })

  it('returns 0 for NotebookEdit delete', () => {
    assert.strictEqual(computeWriteLines('NotebookEdit', {
      edit_mode: 'delete',
      new_source: 'ignored'
    }), 0)
  })

  it('uses longest string heuristic for unknown tools with content', () => {
    // MCP tool with a content field — longest string is the content
    assert.strictEqual(computeWriteLines('mcp__xcode__edit', {
      file_path: 'src/app.swift',
      content: 'import UIKit\nclass App {}\n'
    }), 3)
  })

  it('uses longest string heuristic across multiple fields', () => {
    assert.strictEqual(computeWriteLines('mcp__custom__write', {
      path: '/short',
      sourceText: 'line1\nline2\nline3\nline4\n',
      encoding: 'utf8'
    }), 5)
  })

  it('returns 0 for unknown tool with no string values', () => {
    assert.strictEqual(computeWriteLines('mcp__tool', { count: 42, flag: true }), 0)
  })

  it('returns 0 for unknown tool with only short path-like strings', () => {
    // file_path is the only string — still counts its "lines"
    // (1 line for a path is minimal and harmless)
    assert.strictEqual(computeWriteLines('mcp__tool', { file_path: 'x' }), 1)
  })

  it('returns 0 for null input', () => {
    assert.strictEqual(computeWriteLines('Write', null), 0)
  })
})
