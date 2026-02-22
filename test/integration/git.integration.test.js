const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const {
  readRef, updateRef, snapshotWorkingTree, deleteAllRefs,
  churnSinceRef, advanceTaskRef, sanitizeRefName,
  readCounterBlob, writeCounterRef, readGrossCounter,
  incrementGross, grossChurnSince, advanceGrossSnapshot
} = require('../../lib/git')
const { freshRepo } = require('../helpers')

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

const GLOBS = ['**/*.js']

// ---------- Story: net churn lifecycle ----------
// bootstrap → accumulate (committed, staged, unstaged, untracked) →
// glob filtering → threshold check → ref advance → reset → stale ref
describe('net churn lifecycle', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('walks through bootstrap, accumulation, filtering, advance, and reset', () => {
    // Bootstrap: first call creates ref at HEAD, returns 0
    const churn0 = churnSinceRef(tmpDir, 'my-task', GLOBS)
    assert.strictEqual(churn0, 0)
    assert.strictEqual(readRef(tmpDir, 'my-task'), getHead(tmpDir))

    // No-change: ref matches HEAD → 0
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', GLOBS), 0)

    // Committed changes: additions + deletions
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'line1\nline2\nline3\n')
    commit(tmpDir, 'add lines')
    const churnCommitted = churnSinceRef(tmpDir, 'my-task', GLOBS)
    assert.ok(churnCommitted > 0, `Expected committed churn, got ${churnCommitted}`)

    // Advance ref → resets churn to 0
    updateRef(tmpDir, 'my-task', getHead(tmpDir))
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', GLOBS), 0)

    // Multi-commit accumulation
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'aaa\n')
    commit(tmpDir, 'add a')
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'bbb\nccc\n')
    commit(tmpDir, 'add b')
    assert.ok(churnSinceRef(tmpDir, 'my-task', GLOBS) >= 3)

    // Advance again
    updateRef(tmpDir, 'my-task', getHead(tmpDir))

    // Unstaged working tree changes count
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'unstaged1\nunstaged2\n')
    assert.ok(churnSinceRef(tmpDir, 'my-task', GLOBS) > 0, 'unstaged changes should count')

    // Staged but uncommitted changes count
    spawnSync('git', ['add', 'file.js'], { cwd: tmpDir })
    assert.ok(churnSinceRef(tmpDir, 'my-task', GLOBS) > 0, 'staged changes should count')
  })

  it('counts untracked files, filters by glob, and preserves untracked status', () => {
    churnSinceRef(tmpDir, 'my-task', GLOBS)

    // Untracked .js file counts
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'brand_new.js'), lines)
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', GLOBS), 100)

    // Non-matching glob doesn't count
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'lots\nof\ntext\n')
    // Still only the .js file counts (re-measured against same ref)
    const churn = churnSinceRef(tmpDir, 'my-task', GLOBS)
    assert.strictEqual(churn, 100, 'Only .js untracked file should count')

    // File remains untracked after counting (git add -N was undone)
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf8' })
    assert.ok(r.stdout.includes('?? brand_new.js'), 'File should remain untracked')
  })

  it('returns 0 for non-git directory and stale refs', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
    try {
      assert.strictEqual(churnSinceRef(nonGitDir, 'my-task', ['**/*']), 0)
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }

    // Stale ref (bogus SHA) → 0
    updateRef(tmpDir, 'stale-task', getHead(tmpDir))
    spawnSync('git', ['update-ref', 'refs/worktree/prove_it/stale-task',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'], { cwd: tmpDir })
    assert.strictEqual(churnSinceRef(tmpDir, 'stale-task', GLOBS), 0)
  })
})

// ---------- Story: snapshot semantics ----------
// clean tree → dirty tree → stash → untracked → verify churn reset
describe('snapshot semantics', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('captures working tree state for tracked and untracked files', () => {
    // Clean tree: snapshot == HEAD
    assert.strictEqual(snapshotWorkingTree(tmpDir, GLOBS), getHead(tmpDir))

    // Dirty tree: snapshot != HEAD, diff from snapshot is empty
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'modified\n')
    const snap = snapshotWorkingTree(tmpDir, GLOBS)
    assert.notStrictEqual(snap, getHead(tmpDir))
    const r = spawnSync('git', ['diff', '--numstat', snap], { cwd: tmpDir, encoding: 'utf8' })
    assert.strictEqual(r.stdout.trim(), '', 'Diff from stash to working tree should be empty')

    // Untracked files remain untracked after snapshot
    fs.writeFileSync(path.join(tmpDir, 'brand_new.js'), 'content\n')
    snapshotWorkingTree(tmpDir, GLOBS)
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf8' })
    assert.ok(status.stdout.includes('?? brand_new.js'), 'Untracked after snapshot')
  })

  it('resets churn for tracked files (deadlock fix)', () => {
    churnSinceRef(tmpDir, 'my-task', GLOBS)
    const lines = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'file.js'), lines)
    assert.ok(churnSinceRef(tmpDir, 'my-task', GLOBS) >= 500)

    const snap = snapshotWorkingTree(tmpDir, GLOBS)
    updateRef(tmpDir, 'my-task', snap)
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', GLOBS), 0)
  })

  it('resets churn for untracked files (new-file deadlock fix)', () => {
    churnSinceRef(tmpDir, 'my-task', GLOBS)
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'brand_new.js'), lines)
    assert.ok(churnSinceRef(tmpDir, 'my-task', GLOBS) >= 100)

    const snap = snapshotWorkingTree(tmpDir, GLOBS)
    updateRef(tmpDir, 'my-task', snap)
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', GLOBS), 0)
  })

  it('only counts new changes after snapshot (pre-commit double-count fix)', () => {
    churnSinceRef(tmpDir, 'my-task', GLOBS)

    // Write + stage → snapshot → commit
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'line1\nline2\nline3\n')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    const snap = snapshotWorkingTree(tmpDir, GLOBS)
    updateRef(tmpDir, 'my-task', snap)
    spawnSync('git', ['commit', '-m', 'add lines'], { cwd: tmpDir })

    // No new edits → churn 0
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', GLOBS), 0)

    // One new line → churn 1
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'line1\nline2\nline3\nnew_line\n')
    assert.strictEqual(churnSinceRef(tmpDir, 'my-task', GLOBS), 1)
  })
})

// ---------- Story: advanceTaskRef behavior ----------
// resetOnFail defaults per event type, explicit overrides, dual task, agent tasks
describe('advanceTaskRef', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  function makeChurn () {
    churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS)
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'file.js'), lines)
  }

  function task (overrides) {
    return { name: 'my-task', when: { linesChanged: 5 }, ...overrides }
  }

  it('no-ops when script task has no churn criteria', () => {
    const refBefore = readRef(tmpDir, sanitizeRefName('no-churn'))
    advanceTaskRef({ name: 'no-churn', type: 'script', when: { fileExists: 'x' } }, true, 'PreToolUse', tmpDir, GLOBS)
    assert.strictEqual(readRef(tmpDir, sanitizeRefName('no-churn')), refBefore)
  })

  it('advances ref for agent tasks even without churn criteria', () => {
    advanceTaskRef({ name: 'agent-task', type: 'agent', when: { signal: 'done' } }, true, 'Stop', tmpDir, GLOBS)
    assert.ok(readRef(tmpDir, sanitizeRefName('agent-task')), 'Agent task should get a ref on pass')
  })

  it('always advances on pass regardless of event type', () => {
    makeChurn()
    assert.ok(churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS) > 0)
    advanceTaskRef(task(), true, 'Stop', tmpDir, GLOBS)
    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS), 0)
  })

  it('applies per-event resetOnFail defaults and explicit overrides', () => {
    // PreToolUse defaults to resetting on fail
    makeChurn()
    advanceTaskRef(task(), false, 'PreToolUse', tmpDir, GLOBS)
    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS), 0,
      'PreToolUse default: reset on fail')

    // Stop defaults to NOT resetting on fail
    makeChurn()
    const churnBefore = churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS)
    advanceTaskRef(task(), false, 'Stop', tmpDir, GLOBS)
    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS), churnBefore,
      'Stop default: keep churn on fail')

    // pre-commit defaults to NOT resetting on fail
    makeChurn()
    const churnBefore2 = churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS)
    advanceTaskRef(task(), false, 'pre-commit', tmpDir, GLOBS)
    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS), churnBefore2,
      'pre-commit default: keep churn on fail')

    // Explicit resetOnFail: false overrides PreToolUse
    makeChurn()
    const churnBefore3 = churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS)
    advanceTaskRef(task({ resetOnFail: false }), false, 'PreToolUse', tmpDir, GLOBS)
    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS), churnBefore3,
      'explicit resetOnFail:false overrides PreToolUse')

    // Explicit resetOnFail: true overrides Stop
    makeChurn()
    advanceTaskRef(task({ resetOnFail: true }), false, 'Stop', tmpDir, GLOBS)
    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('my-task'), GLOBS), 0,
      'explicit resetOnFail:true overrides Stop')
  })

  it('advances both net and gross refs for dual-criteria tasks', () => {
    // Net churn
    churnSinceRef(tmpDir, sanitizeRefName('dual-task'), GLOBS)
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'file.js'), lines)
    // Gross churn
    incrementGross(tmpDir, 100)
    grossChurnSince(tmpDir, sanitizeRefName('dual-task'))
    incrementGross(tmpDir, 200)

    advanceTaskRef(
      { name: 'dual-task', when: { linesChanged: 5, linesWritten: 50 } },
      true, 'Stop', tmpDir, GLOBS
    )

    assert.strictEqual(churnSinceRef(tmpDir, sanitizeRefName('dual-task'), GLOBS), 0)
    assert.strictEqual(grossChurnSince(tmpDir, sanitizeRefName('dual-task')), 0)
  })

  it('handles gross churn pass/fail correctly', () => {
    // Pass → advances
    incrementGross(tmpDir, 100)
    const grossTask = { name: 'gross-task', when: { linesWritten: 50 } }
    grossChurnSince(tmpDir, sanitizeRefName('gross-task'))
    incrementGross(tmpDir, 200)
    advanceTaskRef(grossTask, true, 'Stop', tmpDir, GLOBS)
    assert.strictEqual(grossChurnSince(tmpDir, sanitizeRefName('gross-task')), 0)

    // Fail on Stop → does NOT advance
    incrementGross(tmpDir, 300)
    const before = grossChurnSince(tmpDir, sanitizeRefName('gross-task'))
    assert.strictEqual(before, 300)
    advanceTaskRef(grossTask, false, 'Stop', tmpDir, GLOBS)
    assert.strictEqual(grossChurnSince(tmpDir, sanitizeRefName('gross-task')), 300)
  })
})

// ---------- Story: deleteAllRefs ----------
describe('deleteAllRefs', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('deletes all prove_it refs and handles edge cases', () => {
    // Empty → 0
    assert.strictEqual(deleteAllRefs(tmpDir), 0)

    // Create 3 refs → deletes 3
    const head = getHead(tmpDir)
    updateRef(tmpDir, 'task-a', head)
    updateRef(tmpDir, 'task-b', head)
    updateRef(tmpDir, 'task-c', head)
    assert.strictEqual(deleteAllRefs(tmpDir), 3)
    assert.strictEqual(readRef(tmpDir, 'task-a'), null)
    assert.strictEqual(readRef(tmpDir, 'task-b'), null)
    assert.strictEqual(readRef(tmpDir, 'task-c'), null)

    // Non-git directory → 0
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
    try {
      assert.strictEqual(deleteAllRefs(nonGitDir), 0)
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }
  })
})

// ---------- Story: counter blob round-trip ----------
describe('readCounterBlob / writeCounterRef', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('round-trips values and handles edge cases', () => {
    // Basic round-trip
    writeCounterRef(tmpDir, 'test-counter', 42)
    const sha = readRef(tmpDir, 'test-counter')
    assert.ok(sha)
    assert.strictEqual(readCounterBlob(tmpDir, sha), 42)

    // Large values
    writeCounterRef(tmpDir, 'big-counter', 999999)
    assert.strictEqual(readCounterBlob(tmpDir, readRef(tmpDir, 'big-counter')), 999999)

    // Overwrite
    writeCounterRef(tmpDir, 'test-counter', 99)
    assert.strictEqual(readCounterBlob(tmpDir, readRef(tmpDir, 'test-counter')), 99)

    // Null/bad sha → 0
    assert.strictEqual(readCounterBlob(tmpDir, null), 0)
    assert.strictEqual(readCounterBlob(tmpDir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), 0)
  })
})

// ---------- Story: gross churn lifecycle ----------
// first write → CAS accumulation → ignore zero/negative → external mod → cleanup
describe('gross churn lifecycle', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('creates, accumulates, and reads back via incrementGross', () => {
    // First-write path: zero → 50
    assert.strictEqual(readGrossCounter(tmpDir), 0)
    assert.strictEqual(readRef(tmpDir, '__gross_lines'), null)
    incrementGross(tmpDir, 50)
    assert.strictEqual(readGrossCounter(tmpDir), 50)
    assert.ok(readRef(tmpDir, '__gross_lines'))

    // CAS accumulation path
    const refAfterFirst = readRef(tmpDir, '__gross_lines')
    incrementGross(tmpDir, 20)
    assert.notStrictEqual(readRef(tmpDir, '__gross_lines'), refAfterFirst)
    incrementGross(tmpDir, 30)
    assert.strictEqual(readGrossCounter(tmpDir), 100)

    // Ignores zero and negative deltas
    incrementGross(tmpDir, 0)
    assert.strictEqual(readGrossCounter(tmpDir), 100)
    incrementGross(tmpDir, -5)
    assert.strictEqual(readGrossCounter(tmpDir), 100)
  })

  it('reads fresh state after external ref modification', () => {
    incrementGross(tmpDir, 100)
    writeCounterRef(tmpDir, '__gross_lines', 200)
    assert.strictEqual(readGrossCounter(tmpDir), 200)
    incrementGross(tmpDir, 25)
    assert.strictEqual(readGrossCounter(tmpDir), 225)
  })

  it('does not throw on non-git directory', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
    try {
      incrementGross(nonGitDir, 50)
      assert.strictEqual(readGrossCounter(nonGitDir), 0)
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }
  })

  it('does not crash with corrupted ref (max retries)', () => {
    const { tryRun, shellEscape } = require('../../lib/io')
    incrementGross(tmpDir, 50)
    const head = getHead(tmpDir)
    tryRun(`git -C ${shellEscape(tmpDir)} update-ref refs/worktree/prove_it/__gross_lines ${head}`, {})
    incrementGross(tmpDir, 25) // should not throw
    assert.strictEqual(typeof readGrossCounter(tmpDir), 'number')
  })
})

// ---------- Story: incrementGross CAS ----------
describe('incrementGross CAS', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('rejects stale old-value and accepts correct old-value', () => {
    const { tryRun, shellEscape } = require('../../lib/io')

    incrementGross(tmpDir, 100)
    const currentSha = readRef(tmpDir, '__gross_lines')

    const r = tryRun(`printf '%s' '200' | git -C ${shellEscape(tmpDir)} hash-object -w --stdin`, {})
    const newSha = r.stdout.trim()
    const stale = tryRun(`printf '%s' '999' | git -C ${shellEscape(tmpDir)} hash-object -w --stdin`, {})
    const staleSha = stale.stdout.trim()

    // Stale → fails
    const cas = tryRun(`git -C ${shellEscape(tmpDir)} update-ref refs/worktree/prove_it/__gross_lines ${shellEscape(newSha)} ${shellEscape(staleSha)}`, {})
    assert.notStrictEqual(cas.code, 0)
    assert.strictEqual(readGrossCounter(tmpDir), 100)

    // Correct → succeeds
    const cas2 = tryRun(`git -C ${shellEscape(tmpDir)} update-ref refs/worktree/prove_it/__gross_lines ${shellEscape(newSha)} ${shellEscape(currentSha)}`, {})
    assert.strictEqual(cas2.code, 0)
    assert.strictEqual(readGrossCounter(tmpDir), 200)
  })

  it('recovers most increments under concurrent contention', () => {
    const { execSync } = require('child_process')
    incrementGross(tmpDir, 100)

    const n = 4; const delta = 10
    const scriptFile = path.join(tmpDir, '_incr.js')
    fs.writeFileSync(scriptFile, `
      const { incrementGross } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'lib', 'git'))});
      incrementGross(${JSON.stringify(tmpDir)}, ${delta});
    `)

    const cmds = Array.from({ length: n }, () => `node ${scriptFile}`).join(' & ')
    execSync(`${cmds} & wait`, { encoding: 'utf8', timeout: 10000 })

    const counter = readGrossCounter(tmpDir)
    assert.ok(counter > 110, `CAS should recover more than single increment: got ${counter}`)
    assert.ok(counter <= 100 + (n * delta), `should not exceed max: got ${counter}`)
    assert.ok(counter >= 100 + (n * delta) / 2, `at least half should land: got ${counter}`)
  })
})

// ---------- Story: grossChurnSince lifecycle ----------
// bootstrap → accumulate → advance snapshot → independent tasks → cleanup
describe('grossChurnSince lifecycle', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('bootstraps, accumulates, advances, and tracks tasks independently', () => {
    // Bootstrap with existing counter → 0
    incrementGross(tmpDir, 100)
    assert.strictEqual(grossChurnSince(tmpDir, 'my-task'), 0)

    // Bootstrap with no counter → 0
    assert.strictEqual(grossChurnSince(tmpDir, 'empty-task'), 0)

    // Accumulate
    incrementGross(tmpDir, 50)
    incrementGross(tmpDir, 30)
    assert.strictEqual(grossChurnSince(tmpDir, 'my-task'), 80)

    // Advance snapshot → resets
    advanceGrossSnapshot(tmpDir, 'my-task')
    assert.strictEqual(grossChurnSince(tmpDir, 'my-task'), 0)

    // Independent tasks
    grossChurnSince(tmpDir, 'task-a')
    grossChurnSince(tmpDir, 'task-b')
    incrementGross(tmpDir, 100)
    assert.strictEqual(grossChurnSince(tmpDir, 'task-a'), 100)
    assert.strictEqual(grossChurnSince(tmpDir, 'task-b'), 100)
    advanceGrossSnapshot(tmpDir, 'task-a')
    assert.strictEqual(grossChurnSince(tmpDir, 'task-a'), 0)
    assert.strictEqual(grossChurnSince(tmpDir, 'task-b'), 100)
  })

  it('is cleaned up by deleteAllRefs', () => {
    incrementGross(tmpDir, 100)
    grossChurnSince(tmpDir, 'my-task')
    incrementGross(tmpDir, 50)

    deleteAllRefs(tmpDir)

    assert.strictEqual(readGrossCounter(tmpDir), 0)
    assert.strictEqual(grossChurnSince(tmpDir, 'my-task'), 0)
  })
})
