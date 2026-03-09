const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

describe('session_id passed as parameter via subprocess', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_session_'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('session functions write to correct files when given session_id', () => {
    const probeScript = path.join(tmpDir, 'session_probe.js')
    const proveItDir = path.join(tmpDir, 'prove_it_state')
    const sharedPath = path.join(__dirname, '..', '..', 'lib', 'shared.js')

    fs.writeFileSync(probeScript, [
      `const { saveSessionState, logReview } = require(${JSON.stringify(sharedPath)});`,
      'const input = JSON.parse(require("fs").readFileSync(0, "utf8"));',
      'const sessionId = input.session_id || null;',
      'saveSessionState(sessionId, "probe_key", "probe_value");',
      'logReview(sessionId, "/test", "probe", "pass", "propagation test");'
    ].join('\n'))

    const result = spawnSync('node', [probeScript], {
      input: JSON.stringify({ session_id: 'test-session-xyz789' }),
      encoding: 'utf8',
      env: { ...process.env, PROVE_IT_DIR: proveItDir }
    })

    assert.strictEqual(result.status, 0, `Probe script should exit 0: ${result.stderr}`)

    const stateFile = path.join(proveItDir, 'sessions', 'test-session-xyz789.json')
    assert.strictEqual(fs.existsSync(stateFile), true, `State file should exist at ${stateFile}`)
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.strictEqual(state.probe_key, 'probe_value')

    const logFile = path.join(proveItDir, 'sessions', 'test-session-xyz789.jsonl')
    assert.strictEqual(fs.existsSync(logFile), true, `Log file should exist at ${logFile}`)
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim())
    assert.strictEqual(entry.reviewer, 'probe')
    assert.strictEqual(entry.status, 'pass')
    assert.strictEqual(entry.sessionId, 'test-session-xyz789')
  })

  it('without session_id, logReview writes to project-level file', () => {
    const probeScript = path.join(tmpDir, 'session_probe_no_id.js')
    const proveItDir = path.join(tmpDir, 'prove_it_no_id')
    const sharedPath = path.join(__dirname, '..', '..', 'lib', 'shared.js')

    fs.writeFileSync(probeScript, [
      `const { saveSessionState, loadSessionState, logReview, projectLogName } = require(${JSON.stringify(sharedPath)});`,
      'const input = JSON.parse(require("fs").readFileSync(0, "utf8"));',
      'const sessionId = input.session_id || null;',
      'saveSessionState(sessionId, "key", "value");',
      'const result = loadSessionState(sessionId, "key");',
      'logReview(sessionId, "/test", "probe", "pass", "no session");',
      'process.stdout.write(JSON.stringify({ loadResult: result, logName: projectLogName("/test") }));'
    ].join('\n'))

    const result = spawnSync('node', [probeScript], {
      input: JSON.stringify({}),
      encoding: 'utf8',
      env: { ...process.env, PROVE_IT_DIR: proveItDir }
    })

    assert.strictEqual(result.status, 0, `Probe script should exit 0: ${result.stderr}`)
    const output = JSON.parse(result.stdout)
    assert.strictEqual(output.loadResult, null)

    // logReview now writes to a project-level file instead of skipping
    const projectLog = path.join(proveItDir, 'sessions', output.logName)
    assert.strictEqual(fs.existsSync(projectLog), true,
      `Project-level log should exist at ${projectLog}`)
    const entry = JSON.parse(fs.readFileSync(projectLog, 'utf8').trim())
    assert.strictEqual(entry.sessionId, null)
    assert.strictEqual(entry.projectDir, '/test')
  })
})
