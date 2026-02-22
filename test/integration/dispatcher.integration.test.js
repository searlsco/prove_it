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

  it('bootstrap → below threshold → meets threshold → AND with net churn', () => {
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

    // AND with net churn: gross passes but net doesn't → skip (AND semantics)
    churnSinceRef(tmpDir, sanitizeRefName('dual-check'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('dual-check'))
    incrementGross(tmpDir, 600)
    assert.notStrictEqual(
      evaluateWhen({ linesChanged: 500, linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'dual-check'),
      true,
      'Both linesChanged AND linesWritten must pass (AND semantics)'
    )
  })
})

// ---------- Story: object form—all conditions AND'd ----------
describe('evaluateWhen—object form (AND)', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupAppJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('all conditions must pass', () => {
    // Both gates pass → true
    process.env.PROVE_IT_AND_VAR = '1'
    fs.writeFileSync(path.join(tmpDir, '.config'), 'x')
    assert.strictEqual(evaluateWhen({ fileExists: '.config', envSet: 'PROVE_IT_AND_VAR' }, { rootDir: tmpDir }), true)
    delete process.env.PROVE_IT_AND_VAR

    // One gate fails → skip
    assert.notStrictEqual(
      evaluateWhen({ fileExists: '.config', envSet: 'PROVE_IT_AND_MISSING' }, { rootDir: tmpDir }),
      true
    )

    // Gate + activity both pass → true
    process.env.PROVE_IT_AND_PASS = '1'
    grossChurnSince(tmpDir, sanitizeRefName('and-pass'))
    incrementGross(tmpDir, 600)
    assert.strictEqual(
      evaluateWhen({ envSet: 'PROVE_IT_AND_PASS', linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'and-pass'),
      true
    )
    delete process.env.PROVE_IT_AND_PASS

    // Gate fails, activity passes → skip (gate short-circuits)
    grossChurnSince(tmpDir, sanitizeRefName('and-gate'))
    incrementGross(tmpDir, 600)
    assert.notStrictEqual(
      evaluateWhen({ envSet: 'PROVE_IT_AND_GATE', linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'and-gate'),
      true
    )

    // Gate passes, activity fails → skip
    process.env.PROVE_IT_AND_TRIG = '1'
    grossChurnSince(tmpDir, sanitizeRefName('and-trig'))
    incrementGross(tmpDir, 10)
    assert.notStrictEqual(
      evaluateWhen({ envSet: 'PROVE_IT_AND_TRIG', linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'and-trig'),
      true
    )
    delete process.env.PROVE_IT_AND_TRIG

    // Multiple activity conditions: both must pass (AND, not OR)
    churnSinceRef(tmpDir, sanitizeRefName('and-both'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('and-both'))
    incrementGross(tmpDir, 600)
    // Net churn is 0 (no file changes), gross is 600 → linesWritten passes, linesChanged fails
    assert.notStrictEqual(
      evaluateWhen({ linesChanged: 500, linesWritten: 500 }, { rootDir: tmpDir, sources: ['**/*.js'] }, 'and-both'),
      true,
      'Both activity conditions must pass (AND semantics)'
    )
  })
})

// ---------- Story: array form—OR of ANDs ----------
describe('evaluateWhen—array form (OR of ANDs)', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupAppJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('fires when first clause passes, second fails', () => {
    process.env.PROVE_IT_ARR_1 = '1'
    const result = evaluateWhen(
      [{ envSet: 'PROVE_IT_ARR_1' }, { envSet: 'PROVE_IT_ARR_MISSING' }],
      { rootDir: tmpDir }
    )
    assert.strictEqual(result, true)
    delete process.env.PROVE_IT_ARR_1
  })

  it('fires when second clause passes, first fails', () => {
    process.env.PROVE_IT_ARR_2 = '1'
    const result = evaluateWhen(
      [{ envSet: 'PROVE_IT_ARR_MISSING' }, { envSet: 'PROVE_IT_ARR_2' }],
      { rootDir: tmpDir }
    )
    assert.strictEqual(result, true)
    delete process.env.PROVE_IT_ARR_2
  })

  it('fires when both clauses pass', () => {
    process.env.PROVE_IT_ARR_A = '1'
    process.env.PROVE_IT_ARR_B = '1'
    const result = evaluateWhen(
      [{ envSet: 'PROVE_IT_ARR_A' }, { envSet: 'PROVE_IT_ARR_B' }],
      { rootDir: tmpDir }
    )
    assert.strictEqual(result, true)
    delete process.env.PROVE_IT_ARR_A
    delete process.env.PROVE_IT_ARR_B
  })

  it('skips when no clause passes', () => {
    const result = evaluateWhen(
      [{ envSet: 'PROVE_IT_ARR_X' }, { envSet: 'PROVE_IT_ARR_Y' }],
      { rootDir: tmpDir }
    )
    assert.notStrictEqual(result, true)
    assert.ok(typeof result === 'string')
  })

  it('single-element array equivalent to object', () => {
    process.env.PROVE_IT_ARR_SINGLE = '1'
    const arrResult = evaluateWhen(
      [{ envSet: 'PROVE_IT_ARR_SINGLE' }],
      { rootDir: tmpDir }
    )
    const objResult = evaluateWhen(
      { envSet: 'PROVE_IT_ARR_SINGLE' },
      { rootDir: tmpDir }
    )
    assert.strictEqual(arrResult, objResult)
    delete process.env.PROVE_IT_ARR_SINGLE
  })

  it('churn bootstraps in non-matching clauses', () => {
    // Both clauses have linesWritten → both bootstrap even though both skip
    grossChurnSince(tmpDir, sanitizeRefName('arr-boot'))
    const result = evaluateWhen(
      [{ linesWritten: 999 }, { linesWritten: 888 }],
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'arr-boot'
    )
    assert.notStrictEqual(result, true)
  })

  it('accumulates _triggerProgress across clauses', () => {
    grossChurnSince(tmpDir, sanitizeRefName('arr-prog'))
    incrementGross(tmpDir, 50)
    const context = { rootDir: tmpDir, sources: ['**/*.js'] }
    evaluateWhen(
      [{ linesWritten: 999 }, { linesWritten: 888 }],
      context,
      'arr-prog'
    )
    assert.ok(context._triggerProgress, '_triggerProgress should be set')
    assert.ok(context._triggerProgress.includes('linesWritten'))
  })

  it('OR across churn types via array form', () => {
    // Use array form to get the old OR-between-churn behavior:
    // gross passes (linesWritten), net does not (linesChanged)
    churnSinceRef(tmpDir, sanitizeRefName('arr-or'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('arr-or'))
    incrementGross(tmpDir, 600)
    assert.strictEqual(
      evaluateWhen(
        [{ linesChanged: 500 }, { linesWritten: 500 }],
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'arr-or'
      ),
      true,
      'Array form gives OR: linesWritten passes even though linesChanged does not'
    )
  })
})
