const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const {
  writeDispatcherPid,
  readCancelSentinel
} = require('../lib/session')

describe('prove_it cancel command', () => {
  let tmpDir
  let origProveItDir
  let origSessionId

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_cancel_'))
    origProveItDir = process.env.PROVE_IT_DIR
    origSessionId = process.env.PROVE_IT_SESSION_ID
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
  })

  afterEach(() => {
    if (origProveItDir === undefined) {
      delete process.env.PROVE_IT_DIR
    } else {
      process.env.PROVE_IT_DIR = origProveItDir
    }
    if (origSessionId === undefined) {
      delete process.env.PROVE_IT_SESSION_ID
    } else {
      process.env.PROVE_IT_SESSION_ID = origSessionId
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function runCancel (env = {}) {
    const cli = path.join(__dirname, '..', 'cli.js')
    return spawnSync(process.execPath, [cli, 'cancel'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 5000
    })
  }

  it('errors when PROVE_IT_SESSION_ID is not set', () => {
    delete process.env.PROVE_IT_SESSION_ID
    const r = runCancel({ PROVE_IT_SESSION_ID: '' })
    assert.notStrictEqual(r.status, 0, 'Should exit non-zero')
    assert.ok(r.stderr.includes('PROVE_IT_SESSION_ID'),
      `Should mention env var in error, got: ${r.stderr}`)
  })

  it('errors when no dispatcher PID file exists', () => {
    const r = runCancel({ PROVE_IT_SESSION_ID: 'no-such-session' })
    assert.notStrictEqual(r.status, 0, 'Should exit non-zero')
    assert.ok(r.stderr.includes('no running'),
      `Should say no running tasks, got: ${r.stderr}`)
  })

  it('writes cancel sentinel for the session', () => {
    const sessionId = 'cancel-test-sentinel'
    // Use a non-existent PID so cancel doesn't kill a real process
    writeDispatcherPid(sessionId, { pid: 999998, event: 'Stop', startedAt: Date.now() })

    const r = runCancel({ PROVE_IT_SESSION_ID: sessionId })
    assert.strictEqual(r.status, 0, `Should exit 0, stderr: ${r.stderr}`)
    assert.strictEqual(readCancelSentinel(sessionId), true,
      'Cancel sentinel should exist after cancel')
  })

  it('prints confirmation message', () => {
    const sessionId = 'cancel-test-msg'
    writeDispatcherPid(sessionId, { pid: 999998, event: 'Stop', startedAt: Date.now() })

    const r = runCancel({ PROVE_IT_SESSION_ID: sessionId })
    assert.strictEqual(r.status, 0)
    const output = r.stdout + r.stderr
    assert.ok(output.includes('Cancelled') || output.includes('cancel'),
      `Should print confirmation, got: ${output}`)
  })

  it('handles stale PID gracefully', () => {
    const sessionId = 'cancel-test-stale'
    // PID 999999 almost certainly doesn't exist
    writeDispatcherPid(sessionId, { pid: 999999, event: 'Stop', startedAt: Date.now() })

    const r = runCancel({ PROVE_IT_SESSION_ID: sessionId })
    // Should still succeed (write sentinel) even if process is already gone
    assert.strictEqual(r.status, 0, `Should exit 0 even with stale PID, stderr: ${r.stderr}`)
    assert.strictEqual(readCancelSentinel(sessionId), true,
      'Cancel sentinel should exist even with stale PID')
  })
})
