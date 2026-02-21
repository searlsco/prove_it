const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { runEnvTask } = require('../../lib/checks/env')

describe('runEnvTask', () => {
  let tmpDir
  let origProveItDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_env_'))
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

  function readLogEntries (sessionId) {
    const logFile = path.join(tmpDir, 'prove_it', 'sessions', `${sessionId}.jsonl`)
    if (!fs.existsSync(logFile)) return []
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  }

  it('returns parsed vars on success', () => {
    const script = path.join(tmpDir, 'env.sh')
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho "FOO=bar"\necho "BAZ=qux"\n')
    fs.chmodSync(script, 0o755)

    const result = runEnvTask(
      { name: 'test-env', command: script, timeout: 5000 },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(result.vars, { FOO: 'bar', BAZ: 'qux' })
    assert.strictEqual(result.error, null)
  })

  it('returns error when command fails', () => {
    const script = path.join(tmpDir, 'fail.sh')
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho "oops" >&2\nexit 1\n')
    fs.chmodSync(script, 0o755)

    const result = runEnvTask(
      { name: 'fail-env', command: script, timeout: 5000 },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(result.vars, {})
    assert.ok(result.error.includes('fail-env'))
    assert.ok(result.error.includes('failed (exit 1)'))
  })

  it('returns error when output is unparseable', () => {
    const script = path.join(tmpDir, 'bad.sh')
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho "NOT_VALID"\n')
    fs.chmodSync(script, 0o755)

    const result = runEnvTask(
      { name: 'bad-env', command: script, timeout: 5000 },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(result.vars, {})
    assert.ok(result.error.includes('failed to parse env output'))
  })

  it('parses JSON output from command', () => {
    const script = path.join(tmpDir, 'json.sh')
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho \'{"KEY": "val"}\'\n')
    fs.chmodSync(script, 0o755)

    const result = runEnvTask(
      { name: 'json-env', command: script, timeout: 5000 },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(result.vars, { KEY: 'val' })
    assert.strictEqual(result.error, null)
  })

  it('uses default timeout when not specified', () => {
    const script = path.join(tmpDir, 'quick.sh')
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho "A=1"\n')
    fs.chmodSync(script, 0o755)

    const result = runEnvTask(
      { name: 'quick', command: script },
      { rootDir: tmpDir }
    )
    assert.deepStrictEqual(result.vars, { A: '1' })
    assert.strictEqual(result.error, null)
  })

  describe('logReview integration', () => {
    const SESSION_ID = 'test-session-env-log'

    it('logs PASS with var names on success', () => {
      const script = path.join(tmpDir, 'env.sh')
      fs.writeFileSync(script, '#!/usr/bin/env bash\necho "FOO=bar"\necho "BAZ=qux"\n')
      fs.chmodSync(script, 0o755)

      runEnvTask(
        { name: 'test-env', command: script, timeout: 5000 },
        { rootDir: tmpDir, sessionId: SESSION_ID, projectDir: tmpDir }
      )

      const entries = readLogEntries(SESSION_ID)
      assert.strictEqual(entries.length, 2)
      assert.strictEqual(entries[0].status, 'RUNNING')
      assert.strictEqual(entries[1].status, 'PASS')
      assert.strictEqual(entries[1].reviewer, 'test-env')
      assert.ok(entries[1].reason.includes('FOO'))
      assert.ok(entries[1].reason.includes('BAZ'))
    })

    it('logs PASS with "no vars" for empty output', () => {
      const script = path.join(tmpDir, 'empty.sh')
      fs.writeFileSync(script, '#!/usr/bin/env bash\n')
      fs.chmodSync(script, 0o755)

      runEnvTask(
        { name: 'empty-env', command: script, timeout: 5000 },
        { rootDir: tmpDir, sessionId: SESSION_ID, projectDir: tmpDir }
      )

      const entries = readLogEntries(SESSION_ID)
      assert.strictEqual(entries.length, 2)
      assert.strictEqual(entries[0].status, 'RUNNING')
      assert.strictEqual(entries[1].status, 'PASS')
      assert.strictEqual(entries[1].reason, 'no vars')
    })

    it('logs FAIL when command fails', () => {
      const script = path.join(tmpDir, 'fail.sh')
      fs.writeFileSync(script, '#!/usr/bin/env bash\nexit 1\n')
      fs.chmodSync(script, 0o755)

      runEnvTask(
        { name: 'fail-env', command: script, timeout: 5000 },
        { rootDir: tmpDir, sessionId: SESSION_ID, projectDir: tmpDir }
      )

      const entries = readLogEntries(SESSION_ID)
      assert.strictEqual(entries.length, 2)
      assert.strictEqual(entries[0].status, 'RUNNING')
      assert.strictEqual(entries[1].status, 'FAIL')
      assert.ok(entries[1].reason.includes('failed (exit 1)'))
    })

    it('logs FAIL when output is unparseable', () => {
      const script = path.join(tmpDir, 'bad.sh')
      fs.writeFileSync(script, '#!/usr/bin/env bash\necho "NOT_VALID"\n')
      fs.chmodSync(script, 0o755)

      runEnvTask(
        { name: 'bad-env', command: script, timeout: 5000 },
        { rootDir: tmpDir, sessionId: SESSION_ID, projectDir: tmpDir }
      )

      const entries = readLogEntries(SESSION_ID)
      assert.strictEqual(entries.length, 2)
      assert.strictEqual(entries[0].status, 'RUNNING')
      assert.strictEqual(entries[1].status, 'FAIL')
      assert.ok(entries[1].reason.includes('failed to parse env output'))
    })
  })
})
