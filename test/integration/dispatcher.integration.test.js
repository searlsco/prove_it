const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { freshRepo } = require('../helpers')
const { evaluateWhen } = require('../../lib/dispatcher/claude')
const { updateRef, churnSinceRef, sanitizeRefName, incrementGross, grossChurnSince } = require('../../lib/git')

function setupAppJs (dir) {
  fs.writeFileSync(path.join(dir, 'app.js'), 'initial\n')
}

function getHead (dir) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}

// ---------- Story: variablesPresent ----------
describe('evaluateWhen—variablesPresent', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n')
    })
  })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('passes when non-empty, skips when empty/null/unknown, passes for empty array', () => {
    const ctx = { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }

    // Non-empty → passes
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'changed\n')
    spawnSync('git', ['add', 'file.txt'], { cwd: tmpDir })
    assert.strictEqual(evaluateWhen({ variablesPresent: ['staged_diff'] }, ctx), true)

    // Empty (no staged changes after commit)
    spawnSync('git', ['commit', '-m', 'commit'], { cwd: tmpDir })
    const empty = evaluateWhen({ variablesPresent: ['staged_diff'] }, ctx)
    assert.ok(empty.includes('was not present'))

    // Null session → session_diff unavailable
    const nullSess = evaluateWhen({ variablesPresent: ['session_diff'] }, ctx)
    assert.ok(nullSess.includes('session_diff'))

    // Unknown variable
    const unkn = evaluateWhen({ variablesPresent: ['nonexistent_var'] }, ctx)
    assert.ok(unkn.includes('is not a known variable'))

    // Empty array → passes
    assert.strictEqual(evaluateWhen({ variablesPresent: [] }, ctx), true)
  })
})

// ---------- Story: linesChanged lifecycle ----------
describe('evaluateWhen—linesChanged lifecycle', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupAppJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('bootstrap → below threshold → meets threshold → advance → re-accumulate → non-git', () => {
    const GLOBS = ['**/*.js']

    // Bootstrap: 0 churn → reason
    const r0 = evaluateWhen({ linesChanged: 500 }, { rootDir: tmpDir, sources: GLOBS }, 'my-check')
    assert.notStrictEqual(r0, true)
    assert.ok(r0.includes('0') && r0.includes('500'))

    // Small change → below threshold
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'initial\nsmall change\n')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'small'], { cwd: tmpDir })
    assert.notStrictEqual(evaluateWhen({ linesChanged: 500 }, { rootDir: tmpDir, sources: GLOBS }, 'my-check'), true)

    // Big change → meets threshold
    const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'big'], { cwd: tmpDir })
    assert.strictEqual(evaluateWhen({ linesChanged: 500 }, { rootDir: tmpDir, sources: GLOBS }, 'my-check'), true)

    // Advance ref → resets → no longer fires
    updateRef(tmpDir, sanitizeRefName('my-check'), getHead(tmpDir))
    assert.notStrictEqual(evaluateWhen({ linesChanged: 500 }, { rootDir: tmpDir, sources: GLOBS }, 'my-check'), true)

    // Re-accumulate → fires again
    const lines2 = Array.from({ length: 500 }, (_, i) => `new${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'app.js'), lines2)
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'round 2'], { cwd: tmpDir })
    assert.strictEqual(evaluateWhen({ linesChanged: 500 }, { rootDir: tmpDir, sources: GLOBS }, 'my-check'), true)

    // Non-git directory → 0 churn
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
    try {
      assert.notStrictEqual(evaluateWhen({ linesChanged: 500 }, { rootDir: nonGitDir, sources: GLOBS }, 'my-check'), true)
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }
  })
})

// ---------- Story: linesWritten lifecycle ----------
describe('evaluateWhen—linesWritten lifecycle', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupAppJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('bootstrap → below threshold → meets threshold → OR with net churn', () => {
    // Bootstrap → 0
    const r0 = evaluateWhen({ linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'my-check')
    assert.notStrictEqual(r0, true)
    assert.ok(r0.includes('0') && r0.includes('500'))

    // Below threshold
    grossChurnSince(tmpDir, sanitizeRefName('my-check'))
    incrementGross(tmpDir, 100)
    const rLow = evaluateWhen({ linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'my-check')
    assert.notStrictEqual(rLow, true)
    assert.ok(rLow.includes('100'))

    // Meets threshold
    incrementGross(tmpDir, 500)
    assert.strictEqual(evaluateWhen({ linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'my-check'), true)

    // OR with net churn: gross passes even though net doesn't
    churnSinceRef(tmpDir, sanitizeRefName('dual-check'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('dual-check'))
    incrementGross(tmpDir, 600)
    assert.strictEqual(
      evaluateWhen({ linesChanged: 500, linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'dual-check'),
      true
    )
  })
})

// ---------- Story: prerequisite/trigger split ----------
describe('evaluateWhen—prerequisite/trigger split', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupAppJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('AND prereqs, OR triggers, prereq gates trigger, keys exported', () => {
    // Both prereqs pass → true
    process.env.PROVE_IT_PTS_VAR = '1'
    fs.writeFileSync(path.join(tmpDir, '.config'), 'x')
    assert.strictEqual(evaluateWhen({ fileExists: '.config', envSet: 'PROVE_IT_PTS_VAR' }, { rootDir: tmpDir }), true)
    delete process.env.PROVE_IT_PTS_VAR

    // One prereq fails → skip
    assert.notStrictEqual(
      evaluateWhen({ fileExists: '.config', envSet: 'PROVE_IT_PTS_MISSING' }, { rootDir: tmpDir }),
      true
    )

    // OR triggers: only gross passes → task fires
    churnSinceRef(tmpDir, sanitizeRefName('pts-or'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('pts-or'))
    incrementGross(tmpDir, 600)
    assert.strictEqual(
      evaluateWhen({ linesChanged: 500, linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'pts-or'),
      true
    )

    // No triggers pass → skip
    churnSinceRef(tmpDir, sanitizeRefName('pts-none'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('pts-none'))
    incrementGross(tmpDir, 10)
    assert.notStrictEqual(
      evaluateWhen({ linesChanged: 500, linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'pts-none'),
      true
    )

    // Prereq fails, trigger passes → skip (prereq gates)
    grossChurnSince(tmpDir, sanitizeRefName('pts-gate'))
    incrementGross(tmpDir, 600)
    assert.notStrictEqual(
      evaluateWhen({ envSet: 'PROVE_IT_PTS_GATE', linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'pts-gate'),
      true
    )

    // Prereq passes, trigger passes → true
    process.env.PROVE_IT_PTS_PASS = '1'
    grossChurnSince(tmpDir, sanitizeRefName('pts-pass'))
    incrementGross(tmpDir, 600)
    assert.strictEqual(
      evaluateWhen({ envSet: 'PROVE_IT_PTS_PASS', linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'pts-pass'),
      true
    )
    delete process.env.PROVE_IT_PTS_PASS

    // Prereq passes, trigger fails → skip
    process.env.PROVE_IT_PTS_TRIG = '1'
    grossChurnSince(tmpDir, sanitizeRefName('pts-trig'))
    incrementGross(tmpDir, 10)
    assert.notStrictEqual(
      evaluateWhen({ envSet: 'PROVE_IT_PTS_TRIG', linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'pts-trig'),
      true
    )
    delete process.env.PROVE_IT_PTS_TRIG

    // Keys exported
    assert.ok(Array.isArray(PREREQUISITE_KEYS) && PREREQUISITE_KEYS.includes('fileExists'))
    assert.ok(Array.isArray(TRIGGER_KEYS) && TRIGGER_KEYS.includes('linesChanged'))
    assert.ok(TRIGGER_KEYS.includes('sourceFilesEdited'))
  })
})
