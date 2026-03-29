const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  makeExecutable,
  writeConfig,
  makeConfig,
  isolatedEnv
} = require('./hook-harness')

const {
  writeCancelSentinel,
  readDispatcherPid,
  readCancelSentinel
} = require('../../lib/session')

describe('cancel integration', () => {
  let tmpDir
  let origProveItDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_cancel_')
    origProveItDir = process.env.PROVE_IT_DIR
    // Match the PROVE_IT_DIR used by isolatedEnv so sentinel files are visible to the subprocess
    process.env.PROVE_IT_DIR = path.join(tmpDir, '.prove_it_test')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (origProveItDir === undefined) {
      delete process.env.PROVE_IT_DIR
    } else {
      process.env.PROVE_IT_DIR = origProveItDir
    }
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('dispatcher writes PID file on Stop entry', () => {
    createFile(tmpDir, 'test.sh', '#!/usr/bin/env bash\nexit 0\n')
    makeExecutable(path.join(tmpDir, 'test.sh'))
    writeConfig(tmpDir, makeConfig({
      claude: { Stop: [{ name: 'fast-test', type: 'script', command: './test.sh' }] }
    }))

    const env = isolatedEnv(tmpDir)
    const sessionId = 'test-cancel-pid'

    const result = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: tmpDir
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    // PID file should be cleaned up after normal exit
    const pidData = readDispatcherPid(sessionId)
    assert.strictEqual(pidData, null, 'PID file should be cleaned up after normal exit')
  })

  it('dispatcher exits with approve when cancel sentinel exists', () => {
    // Create a script that sleeps briefly to give us time to check
    createFile(tmpDir, 'slow.sh', '#!/usr/bin/env bash\nexit 1\n')
    makeExecutable(path.join(tmpDir, 'slow.sh'))
    writeConfig(tmpDir, makeConfig({
      claude: { Stop: [{ name: 'slow-test', type: 'script', command: './slow.sh' }] }
    }))

    const env = isolatedEnv(tmpDir)
    const sessionId = 'test-cancel-sentinel'

    // Pre-write the cancel sentinel before the dispatcher runs.
    // The dispatcher should check for it after the task completes and
    // exit with approve instead of blocking.
    writeCancelSentinel(sessionId)

    const result = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: tmpDir
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0, `Should exit 0, stderr: ${result.stderr}`)
    assert.ok(result.output, 'Should produce JSON output')
    assert.strictEqual(result.output.decision, 'approve',
      `Should approve on cancel, got: ${JSON.stringify(result.output)}`)
  })

  it('cleans up cancel sentinel after reading it', () => {
    createFile(tmpDir, 'fail.sh', '#!/usr/bin/env bash\nexit 1\n')
    makeExecutable(path.join(tmpDir, 'fail.sh'))
    writeConfig(tmpDir, makeConfig({
      claude: { Stop: [{ name: 'fail-test', type: 'script', command: './fail.sh' }] }
    }))

    const env = isolatedEnv(tmpDir)
    const sessionId = 'test-cancel-cleanup'
    writeCancelSentinel(sessionId)

    invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: tmpDir
    }, { projectDir: tmpDir, env })

    assert.strictEqual(readCancelSentinel(sessionId), false,
      'Cancel sentinel should be cleaned up after being read')
  })
})
