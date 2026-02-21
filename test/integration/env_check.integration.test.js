const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { runEnvTask } = require('../../lib/checks/env')

describe('runEnvTask', () => {
  let tmpDir, origProveItDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_env_'))
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeScript (name, body) {
    const p = path.join(tmpDir, name)
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
    fs.chmodSync(p, 0o755)
    return p
  }

  function readLogEntries (sessionId) {
    const logFile = path.join(tmpDir, 'prove_it', 'sessions', `${sessionId}.jsonl`)
    if (!fs.existsSync(logFile)) return []
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  }

  // ---------- Story: basic execution ----------
  it('parses KEY=val, JSON, handles failure, unparseable output, and default timeout', () => {
    // KEY=val format
    const r1 = runEnvTask(
      { name: 'kv', command: writeScript('kv.sh', 'echo "FOO=bar"\necho "BAZ=qux"'), timeout: 5000 },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(r1.vars, { FOO: 'bar', BAZ: 'qux' })
    assert.strictEqual(r1.error, null)

    // JSON format
    const r2 = runEnvTask(
      { name: 'json', command: writeScript('json.sh', 'echo \'{"KEY": "val"}\''), timeout: 5000 },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(r2.vars, { KEY: 'val' })

    // Command failure
    const r3 = runEnvTask(
      { name: 'fail-env', command: writeScript('fail.sh', 'echo "oops" >&2\nexit 1'), timeout: 5000 },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(r3.vars, {})
    assert.ok(r3.error.includes('failed (exit 1)'))

    // Unparseable output
    const r4 = runEnvTask(
      { name: 'bad-env', command: writeScript('bad.sh', 'echo "NOT_VALID"'), timeout: 5000 },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(r4.vars, {})
    assert.ok(r4.error.includes('failed to parse env output'))

    // Default timeout
    const r5 = runEnvTask(
      { name: 'quick', command: writeScript('quick.sh', 'echo "A=1"') },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(r5.vars, { A: '1' })
  })

  // ---------- Story: logReview ----------
  it('logs RUNNING+PASS with vars, PASS with no vars, FAIL on exit, FAIL on parse', () => {
    const sid = 'test-session-env-log'
    const ctx = { rootDir: tmpDir, sessionId: sid, projectDir: tmpDir }

    // PASS with vars
    runEnvTask({ name: 'ok', command: writeScript('ok.sh', 'echo "FOO=bar"\necho "BAZ=qux"'), timeout: 5000 }, ctx)
    const e1 = readLogEntries(sid)
    assert.strictEqual(e1[0].status, 'RUNNING')
    assert.strictEqual(e1[1].status, 'PASS')
    assert.ok(e1[1].reason.includes('FOO'))

    // PASS with no vars (use a different session to isolate logs)
    runEnvTask({ name: 'empty-env', command: writeScript('empty.sh', ''), timeout: 5000 },
      { rootDir: tmpDir, sessionId: 'test-env-empty', projectDir: tmpDir })
    const e2 = readLogEntries('test-env-empty')
    assert.strictEqual(e2[1].status, 'PASS')
    assert.strictEqual(e2[1].reason, 'no vars')

    // FAIL on exit
    runEnvTask({ name: 'fail-env', command: writeScript('fail2.sh', 'exit 1'), timeout: 5000 },
      { rootDir: tmpDir, sessionId: 'test-env-fail', projectDir: tmpDir })
    const e3 = readLogEntries('test-env-fail')
    assert.strictEqual(e3[1].status, 'FAIL')
    assert.ok(e3[1].reason.includes('failed (exit 1)'))

    // FAIL on parse
    runEnvTask({ name: 'bad-env', command: writeScript('bad2.sh', 'echo "NOT_VALID"'), timeout: 5000 },
      { rootDir: tmpDir, sessionId: 'test-env-bad', projectDir: tmpDir })
    const e4 = readLogEntries('test-env-bad')
    assert.strictEqual(e4[1].status, 'FAIL')
    assert.ok(e4[1].reason.includes('failed to parse'))
  })
})
