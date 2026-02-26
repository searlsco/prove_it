const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  APPEAL_THRESHOLD,
  recordFailure,
  resetFailures,
  isTaskSuspended,
  suspendTask,
  createScriptBackchannel,
  handleScriptAppeal
} = require('../lib/checks/arbiter')
const { backchannelDir } = require('../lib/checks/agent')
const { loadSessionState } = require('../lib/session')
const reviewer = require('../lib/reviewer')

describe('arbiter – script appeal system', () => {
  let tmpDir
  let origProveItDir
  const SESSION_ID = 'test-session-arbiter'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_arbiter_'))
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
  })

  afterEach(() => {
    if (origProveItDir === undefined) {
      delete process.env.PROVE_IT_DIR
    } else {
      process.env.PROVE_IT_DIR = origProveItDir
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('APPEAL_THRESHOLD', () => {
    it('is 5', () => {
      assert.strictEqual(APPEAL_THRESHOLD, 5)
    })
  })

  describe('recordFailure / resetFailures', () => {
    it('tracks consecutive failures', () => {
      assert.strictEqual(recordFailure(SESSION_ID, 'fast-tests'), 1)
      assert.strictEqual(recordFailure(SESSION_ID, 'fast-tests'), 2)
      assert.strictEqual(recordFailure(SESSION_ID, 'fast-tests'), 3)
    })

    it('tracks separate tasks independently', () => {
      recordFailure(SESSION_ID, 'fast-tests')
      recordFailure(SESSION_ID, 'fast-tests')
      recordFailure(SESSION_ID, 'lint')
      assert.strictEqual(recordFailure(SESSION_ID, 'fast-tests'), 3)
      assert.strictEqual(recordFailure(SESSION_ID, 'lint'), 2)
    })

    it('resets to zero', () => {
      recordFailure(SESSION_ID, 'fast-tests')
      recordFailure(SESSION_ID, 'fast-tests')
      resetFailures(SESSION_ID, 'fast-tests')
      assert.strictEqual(recordFailure(SESSION_ID, 'fast-tests'), 1)
    })

    it('returns 0 without session', () => {
      assert.strictEqual(recordFailure(null, 'fast-tests'), 0)
    })
  })

  describe('isTaskSuspended / suspendTask', () => {
    it('returns false when no tasks are suspended', () => {
      assert.strictEqual(isTaskSuspended(SESSION_ID, 'fast-tests'), false)
    })

    it('returns true after suspending', () => {
      suspendTask(SESSION_ID, 'fast-tests')
      assert.strictEqual(isTaskSuspended(SESSION_ID, 'fast-tests'), true)
    })

    it('does not affect other tasks', () => {
      suspendTask(SESSION_ID, 'fast-tests')
      assert.strictEqual(isTaskSuspended(SESSION_ID, 'lint'), false)
    })

    it('is idempotent', () => {
      suspendTask(SESSION_ID, 'fast-tests')
      suspendTask(SESSION_ID, 'fast-tests')
      const suspended = loadSessionState(SESSION_ID, 'suspended')
      assert.deepStrictEqual(suspended, ['fast-tests'])
    })

    it('returns false without session', () => {
      assert.strictEqual(isTaskSuspended(null, 'fast-tests'), false)
    })
  })

  describe('createScriptBackchannel', () => {
    it('creates backchannel directory with README', () => {
      const rootDir = tmpDir
      createScriptBackchannel(rootDir, SESSION_ID, 'fast-tests', 'exit code 1', './script/test_fast')

      const bcDir = backchannelDir(rootDir, SESSION_ID, 'fast-tests')
      const readmePath = path.join(bcDir, 'README.md')
      assert.ok(fs.existsSync(readmePath))

      const content = fs.readFileSync(readmePath, 'utf8')
      assert.ok(content.includes('fast-tests'))
      assert.ok(content.includes('./script/test_fast'))
      assert.ok(content.includes('exit code 1'))
      assert.ok(content.includes('---'))
    })

    it('does not overwrite existing backchannel', () => {
      const rootDir = tmpDir
      createScriptBackchannel(rootDir, SESSION_ID, 'fast-tests', 'first failure', './script/test')

      const bcDir = backchannelDir(rootDir, SESSION_ID, 'fast-tests')
      const readmePath = path.join(bcDir, 'README.md')
      const firstContent = fs.readFileSync(readmePath, 'utf8')

      createScriptBackchannel(rootDir, SESSION_ID, 'fast-tests', 'second failure', './script/test')
      const secondContent = fs.readFileSync(readmePath, 'utf8')

      assert.strictEqual(firstContent, secondContent)
    })

    it('no-ops without session', () => {
      createScriptBackchannel(tmpDir, null, 'fast-tests', 'fail', './script/test')
      // Should not throw
    })
  })

  describe('handleScriptAppeal', () => {
    const makeTask = (name) => ({
      name,
      type: 'script',
      command: './script/test_fast'
    })

    const makeResult = () => ({
      pass: false,
      reason: './script/test_fast failed (exit 1, 2.0s)\n\nsome output',
      output: 'some output'
    })

    const makeContext = (rootDir) => ({
      rootDir,
      projectDir: rootDir,
      sessionId: SESSION_ID,
      hookEvent: 'PreToolUse'
    })

    it('returns result unchanged below threshold', () => {
      const task = makeTask('fast-tests')
      const result = makeResult()
      const context = makeContext(tmpDir)

      const out = handleScriptAppeal(task, result, context)
      assert.strictEqual(out.pass, false)
      // Count should be 1
      const failures = loadSessionState(SESSION_ID, 'successiveFailures')
      assert.strictEqual(failures['fast-tests'], 1)
    })

    it('creates backchannel at threshold', () => {
      const task = makeTask('fast-tests')
      const context = makeContext(tmpDir)

      // Record APPEAL_THRESHOLD - 1 failures first
      for (let i = 0; i < APPEAL_THRESHOLD - 1; i++) {
        recordFailure(SESSION_ID, 'fast-tests')
      }

      const result = makeResult()
      const out = handleScriptAppeal(task, result, context)
      assert.strictEqual(out.pass, false)
      assert.ok(out.reason.includes('consecutive times'))

      const bcDir = backchannelDir(tmpDir, SESSION_ID, 'fast-tests')
      assert.ok(fs.existsSync(path.join(bcDir, 'README.md')))
    })

    it('reminds about backchannel above threshold when no appeal written', () => {
      const task = makeTask('fast-tests')
      const context = makeContext(tmpDir)

      // Record enough failures to be above threshold
      for (let i = 0; i < APPEAL_THRESHOLD; i++) {
        recordFailure(SESSION_ID, 'fast-tests')
      }

      // Create backchannel but don't write appeal
      createScriptBackchannel(tmpDir, SESSION_ID, 'fast-tests', 'fail output', './script/test_fast')

      const result = makeResult()
      const out = handleScriptAppeal(task, result, context)
      assert.strictEqual(out.pass, false)
      assert.ok(out.reason.includes('consecutive times'))
    })

    it('returns result unchanged without session', () => {
      const task = makeTask('fast-tests')
      const result = makeResult()
      const context = { ...makeContext(tmpDir), sessionId: null }

      const out = handleScriptAppeal(task, result, context)
      assert.strictEqual(out, result)
    })

    it('counter resets on pass via resetFailures', () => {
      // Simulate some failures then a reset
      recordFailure(SESSION_ID, 'fast-tests')
      recordFailure(SESSION_ID, 'fast-tests')
      recordFailure(SESSION_ID, 'fast-tests')
      resetFailures(SESSION_ID, 'fast-tests')

      const failures = loadSessionState(SESSION_ID, 'successiveFailures')
      assert.strictEqual(failures['fast-tests'], 0)
    })
  })

  describe('arbiter verdict wiring (stubbed reviewer)', () => {
    const makeTask = (name) => ({
      name,
      type: 'script',
      command: './script/test_fast'
    })

    const makeResult = () => ({
      pass: false,
      reason: './script/test_fast failed (exit 1, 2.0s)\n\ntest output here',
      output: 'test output here'
    })

    const makeContext = (rootDir) => ({
      rootDir,
      projectDir: rootDir,
      sessionId: SESSION_ID,
      hookEvent: 'Stop'
    })

    function writeAppeal (rootDir, taskName, text) {
      const bcDir = backchannelDir(rootDir, SESSION_ID, taskName)
      const readmePath = path.join(bcDir, 'README.md')
      const content = fs.readFileSync(readmePath, 'utf8')
      fs.writeFileSync(readmePath, content + '\n' + text, 'utf8')
    }

    function setupAboveThreshold (rootDir, taskName) {
      for (let i = 0; i < APPEAL_THRESHOLD; i++) {
        recordFailure(SESSION_ID, taskName)
      }
      createScriptBackchannel(rootDir, SESSION_ID, taskName, 'test failure output', './script/test_fast')
    }

    it('suspends task when arbiter returns PASS', () => {
      mock.method(reviewer, 'runReviewer', () => ({
        available: true,
        pass: true,
        reason: 'environment issue confirmed',
        responseText: 'PASS environment issue confirmed'
      }))

      const task = makeTask('fast-tests')
      const context = makeContext(tmpDir)
      setupAboveThreshold(tmpDir, 'fast-tests')
      writeAppeal(tmpDir, 'fast-tests', 'PASS — this is a pre-existing flaky test, not caused by my changes')

      const result = makeResult()
      const out = handleScriptAppeal(task, result, context)

      assert.strictEqual(out.pass, true)
      assert.strictEqual(out.skipped, true)
      assert.ok(out.reason.includes('suspended by arbiter'))
      assert.strictEqual(isTaskSuspended(SESSION_ID, 'fast-tests'), true)

      // Backchannel should be cleaned up
      const bcDir = backchannelDir(tmpDir, SESSION_ID, 'fast-tests')
      assert.strictEqual(fs.existsSync(bcDir), false)

      // Failure counter should be reset
      const failures = loadSessionState(SESSION_ID, 'successiveFailures')
      assert.strictEqual(failures['fast-tests'], 0)

      mock.restoreAll()
    })

    it('suspends task when arbiter returns SKIP', () => {
      mock.method(reviewer, 'runReviewer', () => ({
        available: true,
        skip: true,
        reason: 'unclear situation, benefit of the doubt',
        responseText: 'SKIP unclear situation'
      }))

      const task = makeTask('fast-tests')
      const context = makeContext(tmpDir)
      setupAboveThreshold(tmpDir, 'fast-tests')
      writeAppeal(tmpDir, 'fast-tests', 'SKIP — mid-task, will fix later')

      const result = makeResult()
      const out = handleScriptAppeal(task, result, context)

      assert.strictEqual(out.pass, true)
      assert.strictEqual(out.skipped, true)
      assert.strictEqual(isTaskSuspended(SESSION_ID, 'fast-tests'), true)

      mock.restoreAll()
    })

    it('keeps blocking when arbiter returns FAIL', () => {
      mock.method(reviewer, 'runReviewer', () => ({
        available: true,
        pass: false,
        reason: 'developer should fix the failing test',
        responseText: 'FAIL developer should fix the failing test'
      }))

      const task = makeTask('fast-tests')
      const context = makeContext(tmpDir)
      setupAboveThreshold(tmpDir, 'fast-tests')
      writeAppeal(tmpDir, 'fast-tests', 'PASS — I think this is an env issue')

      const result = makeResult()
      const out = handleScriptAppeal(task, result, context)

      assert.strictEqual(out.pass, false)
      assert.ok(out.reason.includes('Appeal denied'))
      assert.strictEqual(isTaskSuspended(SESSION_ID, 'fast-tests'), false)

      mock.restoreAll()
    })

    it('falls back to blocking when reviewer is unavailable', () => {
      mock.method(reviewer, 'runReviewer', () => ({
        available: false,
        binary: 'claude'
      }))

      const task = makeTask('fast-tests')
      const context = makeContext(tmpDir)
      setupAboveThreshold(tmpDir, 'fast-tests')
      writeAppeal(tmpDir, 'fast-tests', 'PASS — env issue')

      const result = makeResult()
      const out = handleScriptAppeal(task, result, context)

      assert.strictEqual(out.pass, false)
      assert.strictEqual(isTaskSuspended(SESSION_ID, 'fast-tests'), false)

      mock.restoreAll()
    })
  })
})
