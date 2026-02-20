const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const CLI_PATH = path.join(__dirname, '..', 'cli.js')

function runCli (args, options = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    ...options
  })
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status
  }
}

describe('record command', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_record_'))
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records a pass', () => {
    const result = runCli(['record', '--pass', '--name', 'foo'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stderr, /recorded foo pass/)

    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.local.json'), 'utf8'))
    assert.strictEqual(data.runs.foo.result, 'pass')
    assert.ok(typeof data.runs.foo.at === 'number')
  })

  it('records a fail', () => {
    const result = runCli(['record', '--fail', '--name', 'foo'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 1)
    assert.match(result.stderr, /recorded foo fail/)

    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.local.json'), 'utf8'))
    assert.strictEqual(data.runs.foo.result, 'fail')
  })

  it('sanitizes name to match script.js behavior', () => {
    const result = runCli(['record', '--pass', '--name', 'my check!@#'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)

    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.local.json'), 'utf8'))
    assert.ok(data.runs.my_check___, 'name should be sanitized with same regex as script.js')
  })

  it('exits 1 when --name is missing', () => {
    const result = runCli(['record', '--pass'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 1)
    assert.match(result.stderr, /Usage/)
  })

  it('exits 1 when neither --pass nor --fail is given', () => {
    const result = runCli(['record', '--name', 'foo'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 1)
    assert.match(result.stderr, /Usage/)
  })

  it('exits 1 when both --pass and --fail are given', () => {
    const result = runCli(['record', '--pass', '--fail', '--name', 'foo'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 1)
    assert.match(result.stderr, /Usage/)
  })

  describe('--result flag', () => {
    it('--result 0 records pass and exits 0', () => {
      const result = runCli(['record', '--result', '0', '--name', 'foo'], { cwd: tmpDir })
      assert.strictEqual(result.exitCode, 0)
      assert.match(result.stderr, /recorded foo pass/)

      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.local.json'), 'utf8'))
      assert.strictEqual(data.runs.foo.result, 'pass')
    })

    it('--result 1 records fail and exits 1', () => {
      const result = runCli(['record', '--result', '1', '--name', 'foo'], { cwd: tmpDir })
      assert.strictEqual(result.exitCode, 1)
      assert.match(result.stderr, /recorded foo fail/)

      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.local.json'), 'utf8'))
      assert.strictEqual(data.runs.foo.result, 'fail')
    })

    it('--result 42 records fail and exits 42', () => {
      const result = runCli(['record', '--result', '42', '--name', 'foo'], { cwd: tmpDir })
      assert.strictEqual(result.exitCode, 42)
      assert.match(result.stderr, /recorded foo fail/)

      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.local.json'), 'utf8'))
      assert.strictEqual(data.runs.foo.result, 'fail')
    })

    it('--result + --pass is an error', () => {
      const result = runCli(['record', '--result', '0', '--pass', '--name', 'foo'], { cwd: tmpDir })
      assert.strictEqual(result.exitCode, 1)
      assert.match(result.stderr, /Usage/)
    })

    it('--result + --fail is an error', () => {
      const result = runCli(['record', '--result', '0', '--fail', '--name', 'foo'], { cwd: tmpDir })
      assert.strictEqual(result.exitCode, 1)
      assert.match(result.stderr, /Usage/)
    })

    it('--result without value is an error', () => {
      const result = runCli(['record', '--result', '--name', 'foo'], { cwd: tmpDir })
      assert.strictEqual(result.exitCode, 1)
      assert.match(result.stderr, /Usage/)
    })
  })

  describe('trap integration', () => {
    it('EXIT trap records fail and exits non-zero with set -e', () => {
      const script = [
        '#!/usr/bin/env bash',
        'set -e',
        `trap 'node ${CLI_PATH} record --name traptest --result $?' EXIT`,
        'false'
      ].join('\n')
      const scriptPath = path.join(tmpDir, 'traptest.sh')
      fs.writeFileSync(scriptPath, script)
      fs.chmodSync(scriptPath, 0o755)

      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', cwd: tmpDir })
      assert.notStrictEqual(result.status, 0, 'script should exit non-zero')

      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.local.json'), 'utf8'))
      assert.strictEqual(data.runs.traptest.result, 'fail', 'should record fail')
    })
  })

  it('preserves existing local config data', () => {
    const localPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
    fs.writeFileSync(localPath, JSON.stringify({ runs: { existing: { at: 1, pass: true } } }))

    runCli(['record', '--pass', '--name', 'new-check'], { cwd: tmpDir })

    const data = JSON.parse(fs.readFileSync(localPath, 'utf8'))
    assert.strictEqual(data.runs.existing.pass, true, 'existing run data preserved')
    assert.strictEqual(data.runs['new-check'].result, 'pass', 'new run data added')
  })
})
