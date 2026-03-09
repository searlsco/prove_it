const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const CLI_PATH = path.join(__dirname, '..', '..', 'cli.js')

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
