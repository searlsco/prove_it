const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { saveSessionState } = require('../lib/session')

describe('libexec/test-first', () => {
  let tmpDir
  let origProveItDir
  const SESSION_ID = 'test-session-first'
  const scriptPath = path.join(__dirname, '..', 'libexec', 'test-first')

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_testfirst_'))
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

  it('outputs nothing when count is below untestedEditLimit', () => {
    saveSessionState(SESSION_ID, 'consecutiveUntestedEditCount', 1)
    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({ session_id: SESSION_ID, params: { untestedEditLimit: 3 } }),
      encoding: 'utf8',
      env: { ...process.env }
    })
    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stdout, '')
  })

  it('outputs reminder when count meets untestedEditLimit', () => {
    saveSessionState(SESSION_ID, 'consecutiveUntestedEditCount', 3)
    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({ session_id: SESSION_ID, params: { untestedEditLimit: 3 } }),
      encoding: 'utf8',
      env: { ...process.env }
    })
    assert.strictEqual(result.status, 0)
    assert.ok(result.stdout.includes('edited 3 source files'))
    assert.ok(result.stdout.includes('writing a failing test'))
  })

  it('outputs reminder when count exceeds untestedEditLimit', () => {
    saveSessionState(SESSION_ID, 'consecutiveUntestedEditCount', 5)
    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({ session_id: SESSION_ID, params: { untestedEditLimit: 3 } }),
      encoding: 'utf8',
      env: { ...process.env }
    })
    assert.strictEqual(result.status, 0)
    assert.ok(result.stdout.includes('edited 5 source files'))
  })

  it('uses default untestedEditLimit of 3 when not specified', () => {
    saveSessionState(SESSION_ID, 'consecutiveUntestedEditCount', 3)
    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({ session_id: SESSION_ID }),
      encoding: 'utf8',
      env: { ...process.env }
    })
    assert.strictEqual(result.status, 0)
    assert.ok(result.stdout.includes('edited 3 source files'))
  })

  it('outputs nothing when no session state exists', () => {
    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({ session_id: 'nonexistent-session' }),
      encoding: 'utf8',
      env: { ...process.env }
    })
    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stdout, '')
  })
})
