const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { freshRepo } = require('../helpers')
const { evaluateWhen } = require('../../lib/dispatcher/claude')
const { updateRef, churnSinceRef, sanitizeRefName, incrementGross, grossChurnSince } = require('../../lib/git')

describe('evaluateWhen — variablesPresent (git-based)', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n')
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when variable resolves to non-empty value', () => {
    // Stage a change so staged_diff is non-empty
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'changed\n')
    spawnSync('git', ['add', 'file.txt'], { cwd: tmpDir })

    const result = evaluateWhen(
      { variablesPresent: ['staged_diff'] },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
    )
    assert.strictEqual(result, true)
  })

  it('returns reason when variable resolves to empty (no staged changes)', () => {
    const result = evaluateWhen(
      { variablesPresent: ['staged_diff'] },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('staged_diff'), `Expected variable name in reason, got: ${result}`)
    assert.ok(result.includes('was not present'), `Expected 'was not present' in reason, got: ${result}`)
  })

  it('returns reason for session_diff when sessionId is null', () => {
    const result = evaluateWhen(
      { variablesPresent: ['session_diff'] },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('session_diff'), `Expected variable name in reason, got: ${result}`)
  })

  it('returns reason for unknown variable name', () => {
    const result = evaluateWhen(
      { variablesPresent: ['nonexistent_var'] },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('nonexistent_var'), `Expected variable name in reason, got: ${result}`)
    assert.ok(result.includes('is not a known variable'), `Expected 'is not a known variable' in reason, got: ${result}`)
  })

  it('passes for empty array', () => {
    const result = evaluateWhen(
      { variablesPresent: [] },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
    )
    assert.strictEqual(result, true)
  })
})

describe('evaluateWhen — linesChanged (git-based)', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'app.js'), 'initial\n')
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns reason on bootstrap (0 churn)', () => {
    const result = evaluateWhen(
      { linesChanged: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('0'), `Expected 0 in reason, got: ${result}`)
    assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
    assert.ok(result.includes('lines changed since last run'), `Expected reason, got: ${result}`)
  })

  it('returns true when churn meets threshold', () => {
    // Bootstrap ref
    churnSinceRef(tmpDir, sanitizeRefName('my-check'), ['**/*.js'])

    // Generate enough churn
    const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'add lines'], { cwd: tmpDir })

    const result = evaluateWhen(
      { linesChanged: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.strictEqual(result, true)
  })

  it('returns reason when churn is below threshold', () => {
    // Bootstrap ref
    churnSinceRef(tmpDir, sanitizeRefName('my-check'), ['**/*.js'])

    // Small change
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'initial\nsmall change\n')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'small'], { cwd: tmpDir })

    const result = evaluateWhen(
      { linesChanged: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
  })

  it('resets after ref is advanced (simulating pass)', () => {
    churnSinceRef(tmpDir, sanitizeRefName('my-check'), ['**/*.js'])

    // Generate churn
    const lines = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'big change'], { cwd: tmpDir })

    // Fires
    const result = evaluateWhen(
      { linesChanged: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.strictEqual(result, true)

    // Advance ref (what dispatcher does on pass)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    updateRef(tmpDir, sanitizeRefName('my-check'), head)

    // Should not fire anymore
    const result2 = evaluateWhen(
      { linesChanged: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.notStrictEqual(result2, true)
  })

  it('fires again after more churn post-reset', () => {
    churnSinceRef(tmpDir, sanitizeRefName('my-check'), ['**/*.js'])

    // First round of churn
    const lines = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'round 1'], { cwd: tmpDir })

    // Advance ref (pass)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    updateRef(tmpDir, sanitizeRefName('my-check'), head)

    // Second round of churn
    const lines2 = Array.from({ length: 500 }, (_, i) => `new_line${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(tmpDir, 'app.js'), lines2)
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'round 2'], { cwd: tmpDir })

    const result = evaluateWhen(
      { linesChanged: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.strictEqual(result, true)
  })

  it('returns reason in non-git directory (0 churn)', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
    try {
      const result = evaluateWhen(
        { linesChanged: 500 },
        { rootDir: nonGitDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('0'), `Expected 0 in reason, got: ${result}`)
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }
  })
})

describe('evaluateWhen — linesWritten (gross churn)', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'app.js'), 'initial\n')
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns reason on bootstrap (0 gross churn)', () => {
    const result = evaluateWhen(
      { linesWritten: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('0'), `Expected 0 in reason, got: ${result}`)
    assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
    assert.ok(result.includes('gross lines changed'), `Expected reason, got: ${result}`)
  })

  it('returns true when gross churn meets threshold', () => {
    // Bootstrap
    grossChurnSince(tmpDir, sanitizeRefName('my-check'))
    // Accumulate enough gross churn
    incrementGross(tmpDir, 600)

    const result = evaluateWhen(
      { linesWritten: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.strictEqual(result, true)
  })

  it('returns reason when gross churn is below threshold', () => {
    grossChurnSince(tmpDir, sanitizeRefName('my-check'))
    incrementGross(tmpDir, 100)

    const result = evaluateWhen(
      { linesWritten: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'my-check'
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('100'), `Expected churn in reason, got: ${result}`)
    assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
  })

  it('OR-ed triggers — gross passes, net fails → task fires', () => {
    // Bootstrap both refs
    churnSinceRef(tmpDir, sanitizeRefName('dual-check'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('dual-check'))

    // Gross churn meets threshold, but net churn does not
    incrementGross(tmpDir, 600)

    const result = evaluateWhen(
      { linesChanged: 500, linesWritten: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'dual-check'
    )
    // Triggers are OR-ed: gross passes → task fires even though net fails
    assert.strictEqual(result, true)
  })
})

describe('evaluateWhen — prerequisite/trigger split', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'app.js'), 'initial\n')
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('multiple prerequisites AND — all pass → true', () => {
    process.env.PROVE_IT_PTS_VAR = '1'
    try {
      fs.writeFileSync(path.join(tmpDir, '.config'), 'x')
      const result = evaluateWhen(
        { fileExists: '.config', envSet: 'PROVE_IT_PTS_VAR' },
        { rootDir: tmpDir }
      )
      assert.strictEqual(result, true)
    } finally {
      delete process.env.PROVE_IT_PTS_VAR
    }
  })

  it('multiple prerequisites AND — one fails → skip', () => {
    delete process.env.PROVE_IT_PTS_MISSING
    fs.writeFileSync(path.join(tmpDir, '.config'), 'x')
    const result = evaluateWhen(
      { fileExists: '.config', envSet: 'PROVE_IT_PTS_MISSING' },
      { rootDir: tmpDir }
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('was not set'), `Expected prereq reason, got: ${result}`)
  })

  it('multiple triggers OR — one passes → true', () => {
    // Bootstrap refs
    churnSinceRef(tmpDir, sanitizeRefName('pts-check'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('pts-check'))

    // Only gross churn meets threshold
    incrementGross(tmpDir, 600)

    const result = evaluateWhen(
      { linesChanged: 500, linesWritten: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'pts-check'
    )
    assert.strictEqual(result, true)
  })

  it('multiple triggers OR — none pass → skip', () => {
    // Bootstrap refs
    churnSinceRef(tmpDir, sanitizeRefName('pts-check2'), ['**/*.js'])
    grossChurnSince(tmpDir, sanitizeRefName('pts-check2'))

    // Neither meets threshold
    incrementGross(tmpDir, 10)

    const result = evaluateWhen(
      { linesChanged: 500, linesWritten: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'pts-check2'
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('gross lines changed'), `Expected trigger reason, got: ${result}`)
  })

  it('prerequisite fails + trigger passes → skip (prereq gates)', () => {
    delete process.env.PROVE_IT_PTS_GATE
    // Set up a trigger that would pass
    grossChurnSince(tmpDir, sanitizeRefName('pts-gate'))
    incrementGross(tmpDir, 600)

    const result = evaluateWhen(
      { envSet: 'PROVE_IT_PTS_GATE', linesWritten: 500 },
      { rootDir: tmpDir, sources: ['**/*.js'] },
      'pts-gate'
    )
    assert.notStrictEqual(result, true)
    assert.ok(result.includes('was not set'), `Expected prereq reason, got: ${result}`)
  })

  it('prerequisite passes + trigger passes → true', () => {
    process.env.PROVE_IT_PTS_PASS = '1'
    try {
      grossChurnSince(tmpDir, sanitizeRefName('pts-pass'))
      incrementGross(tmpDir, 600)

      const result = evaluateWhen(
        { envSet: 'PROVE_IT_PTS_PASS', linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'pts-pass'
      )
      assert.strictEqual(result, true)
    } finally {
      delete process.env.PROVE_IT_PTS_PASS
    }
  })

  it('prerequisite passes + trigger fails → skip', () => {
    process.env.PROVE_IT_PTS_TRIG = '1'
    try {
      grossChurnSince(tmpDir, sanitizeRefName('pts-trig'))
      incrementGross(tmpDir, 10)

      const result = evaluateWhen(
        { envSet: 'PROVE_IT_PTS_TRIG', linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'pts-trig'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('gross lines changed'), `Expected trigger reason, got: ${result}`)
    } finally {
      delete process.env.PROVE_IT_PTS_TRIG
    }
  })

  it('prerequisites only (no triggers) → true when all pass', () => {
    process.env.PROVE_IT_PTS_ONLY = '1'
    try {
      fs.writeFileSync(path.join(tmpDir, '.config'), 'x')
      const result = evaluateWhen(
        { fileExists: '.config', envSet: 'PROVE_IT_PTS_ONLY' },
        { rootDir: tmpDir }
      )
      assert.strictEqual(result, true)
    } finally {
      delete process.env.PROVE_IT_PTS_ONLY
    }
  })

  it('PREREQUISITE_KEYS and TRIGGER_KEYS are exported', () => {
    const { PREREQUISITE_KEYS, TRIGGER_KEYS } = require('../../lib/dispatcher/claude')
    assert.ok(Array.isArray(PREREQUISITE_KEYS))
    assert.ok(Array.isArray(TRIGGER_KEYS))
    assert.ok(PREREQUISITE_KEYS.includes('fileExists'))
    assert.ok(TRIGGER_KEYS.includes('linesChanged'))
    assert.ok(TRIGGER_KEYS.includes('sourceFilesEdited'))
  })
})
