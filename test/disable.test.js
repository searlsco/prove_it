const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const {
  readDisabledSentinel,
  writeDisabledSentinel,
  getSessionControl,
  disableSessionControl
} = require('../lib/session')

describe('prove_it disable / enable commands', () => {
  let tmpDir
  let origProveItDir
  let origSessionId

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_disable_'))
    origProveItDir = process.env.PROVE_IT_DIR
    origSessionId = process.env.PROVE_IT_SESSION_ID
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    if (origSessionId === undefined) delete process.env.PROVE_IT_SESSION_ID
    else process.env.PROVE_IT_SESSION_ID = origSessionId
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function run (cmd, env = {}) {
    const cli = path.join(__dirname, '..', 'cli.js')
    return spawnSync(process.execPath, [cli, cmd], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 5000
    })
  }

  describe('disable', () => {
    it('errors when PROVE_IT_SESSION_ID is not set', () => {
      const r = run('disable', { PROVE_IT_SESSION_ID: '' })
      assert.notStrictEqual(r.status, 0)
      assert.ok(r.stderr.includes('PROVE_IT_SESSION_ID'),
        `Should mention env var, got: ${r.stderr}`)
    })

    it('writes disabled sentinel for the session', () => {
      const sessionId = 'disable-test-sentinel'
      const r = run('disable', { PROVE_IT_SESSION_ID: sessionId })
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
      assert.strictEqual(readDisabledSentinel(sessionId), true,
        'Disabled sentinel should exist after disable')
      assert.strictEqual(getSessionControl(sessionId).disabled?.active, true,
        'Clean session control state should mark the session disabled')
    })

    it('prints warning banner with enable instructions', () => {
      const sessionId = 'disable-test-msg'
      const r = run('disable', { PROVE_IT_SESSION_ID: sessionId })
      assert.strictEqual(r.status, 0)
      assert.ok(r.stdout.includes('⚠'), `Should include warning emoji, got: ${r.stdout}`)
      assert.ok(r.stdout.includes('prove_it enable'),
        `Should tell user how to re-enable, got: ${r.stdout}`)
    })
  })

  describe('enable', () => {
    it('errors when PROVE_IT_SESSION_ID is not set', () => {
      const r = run('enable', { PROVE_IT_SESSION_ID: '' })
      assert.notStrictEqual(r.status, 0)
      assert.ok(r.stderr.includes('PROVE_IT_SESSION_ID'),
        `Should mention env var, got: ${r.stderr}`)
    })

    it('clears disabled sentinel when previously disabled', () => {
      const sessionId = 'enable-test-clear'
      writeDisabledSentinel(sessionId)
      disableSessionControl(sessionId)
      assert.strictEqual(readDisabledSentinel(sessionId), true)
      assert.strictEqual(getSessionControl(sessionId).disabled?.active, true)
      const r = run('enable', { PROVE_IT_SESSION_ID: sessionId })
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
      assert.strictEqual(readDisabledSentinel(sessionId), false,
        'Disabled sentinel should be cleared')
      assert.strictEqual(getSessionControl(sessionId).disabled, null,
        'Clean disabled state should be cleared')
    })

    it('is idempotent when session was already enabled', () => {
      const sessionId = 'enable-test-idempotent'
      const r = run('enable', { PROVE_IT_SESSION_ID: sessionId })
      assert.strictEqual(r.status, 0)
      assert.strictEqual(readDisabledSentinel(sessionId), false)
    })
  })
})
