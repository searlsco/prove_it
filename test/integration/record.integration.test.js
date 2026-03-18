const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const CLI_PATH = path.join(__dirname, '..', '..', 'cli.js')

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

describe('record command – CLI argument validation', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_record_'))
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
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

  it('--pass records pass and exits 0', () => {
    const result = runCli(['record', '--pass', '--name', 'foo'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stderr, /recorded foo pass/)
  })

  it('--fail records fail and exits 1', () => {
    const result = runCli(['record', '--fail', '--name', 'foo'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 1)
    assert.match(result.stderr, /recorded foo fail/)
  })

  it('--result 0 exits 0', () => {
    const result = runCli(['record', '--result', '0', '--name', 'foo'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
  })

  it('--result 42 exits 42', () => {
    const result = runCli(['record', '--result', '42', '--name', 'foo'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 42)
  })
})

describe('record command – project root resolution', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_record_'))
    // Create project-level config so findProveItProject can locate the root
    fs.mkdirSync(path.join(tmpDir, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), '{}')
    // Create a subdirectory to run from
    fs.mkdirSync(path.join(tmpDir, 'sub', 'deep'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes config.local.json at project root when run from a subdirectory', () => {
    const subDir = path.join(tmpDir, 'sub', 'deep')
    const result = runCli(['record', '--pass', '--name', 'subdir_test'], { cwd: subDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stderr, /recorded subdir_test pass/)

    // config.local.json should be at project root, not in the subdirectory
    const rootCfg = path.join(tmpDir, '.claude', 'prove_it', 'config.local.json')
    const subCfg = path.join(subDir, '.claude', 'prove_it', 'config.local.json')

    assert.ok(fs.existsSync(rootCfg), 'config.local.json should exist at project root')
    assert.ok(!fs.existsSync(subCfg), 'config.local.json should NOT exist in subdirectory')

    const data = JSON.parse(fs.readFileSync(rootCfg, 'utf8'))
    assert.strictEqual(data.runs.subdir_test.result, 'pass')
  })
})

describe('record command – trap integration', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_record_'))
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

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

    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it/config.local.json'), 'utf8'))
    assert.strictEqual(data.runs.traptest.result, 'fail', 'should record fail')
  })

  it('EXIT trap preserves $? across a command -v guard', () => {
    // Regression: `command -v` succeeds (exit 0) and clobbers $? before
    // it reaches `--result $?`. Capturing rc=$? first avoids this.
    const script = [
      '#!/usr/bin/env bash',
      'set -e',
      `trap 'rc=$?; command -v node >/dev/null 2>&1 && node ${CLI_PATH} record --name guardtest --result $rc' EXIT`,
      'false'
    ].join('\n')
    const scriptPath = path.join(tmpDir, 'guardtest.sh')
    fs.writeFileSync(scriptPath, script)
    fs.chmodSync(scriptPath, 0o755)

    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', cwd: tmpDir })
    assert.notStrictEqual(result.status, 0, 'script should exit non-zero')

    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it/config.local.json'), 'utf8'))
    assert.strictEqual(data.runs.guardtest.result, 'fail', 'should record fail despite command -v guard')
  })
})
