const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const CLI_PATH = path.join(__dirname, '..', 'cli.js')

describe('cmdUpgrade', () => {
  let tmpDir
  let binDir
  let logFile

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_upgrade_'))
    binDir = path.join(tmpDir, 'bin')
    logFile = path.join(tmpDir, 'calls.log')
    fs.mkdirSync(binDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeMock (name, exitCode) {
    const scriptPath = path.join(binDir, name)
    fs.writeFileSync(scriptPath, `#!/bin/sh\necho "${name} $*" >> "${logFile}"\nexit ${exitCode}\n`)
    fs.chmodSync(scriptPath, 0o755)
  }

  function runUpgrade (cwd, extraEnv) {
    const env = {
      ...process.env,
      PATH: binDir + ':' + process.env.PATH,
      ...extraEnv
    }
    return spawnSync('node', [CLI_PATH, 'upgrade'], {
      encoding: 'utf8',
      cwd,
      env
    })
  }

  function getCalls () {
    try {
      return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  it('calls brew update, brew upgrade, prove_it install in order (no project)', () => {
    writeMock('brew', 0)
    writeMock('prove_it', 0)

    const workDir = path.join(tmpDir, 'no-project')
    fs.mkdirSync(workDir)

    const r = runUpgrade(workDir)
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)

    const calls = getCalls()
    assert.strictEqual(calls.length, 3)
    assert.match(calls[0], /^brew update searlsco\/tap$/)
    assert.match(calls[1], /^brew upgrade searlsco\/tap\/prove_it$/)
    assert.match(calls[2], /^prove_it install$/)
    assert.match(r.stdout, /Upgrade complete/)
  })

  it('calls prove_it init when project config is found', () => {
    writeMock('brew', 0)
    writeMock('prove_it', 0)

    const projectDir = path.join(tmpDir, 'with-project')
    fs.mkdirSync(path.join(projectDir, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.claude', 'prove_it', 'config.json'), '{}')

    const r = runUpgrade(projectDir)
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)

    const calls = getCalls()
    assert.strictEqual(calls.length, 4)
    assert.match(calls[3], /^prove_it init$/)
    assert.match(r.stdout, /Reinitializing project/)
  })

  it('finds project config in ancestor directory', () => {
    writeMock('brew', 0)
    writeMock('prove_it', 0)

    const projectDir = path.join(tmpDir, 'ancestor-project')
    const subDir = path.join(projectDir, 'src', 'lib')
    fs.mkdirSync(subDir, { recursive: true })
    fs.mkdirSync(path.join(projectDir, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.claude', 'prove_it', 'config.json'), '{}')

    const r = runUpgrade(subDir)
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)

    const calls = getCalls()
    assert.strictEqual(calls.length, 4)
    assert.match(calls[3], /^prove_it init$/)
  })

  it('stops and exits 1 on brew update failure', () => {
    writeMock('brew', 1)
    writeMock('prove_it', 0)

    const workDir = path.join(tmpDir, 'fail-update')
    fs.mkdirSync(workDir)

    const r = runUpgrade(workDir)
    assert.strictEqual(r.status, 1)
    assert.match(r.stderr, /brew update failed/)

    const calls = getCalls()
    assert.strictEqual(calls.length, 1, 'should only call brew update')
  })

  it('stops and exits 1 on brew upgrade failure', () => {
    // Need brew to succeed for update but fail for upgrade
    const scriptPath = path.join(binDir, 'brew')
    fs.writeFileSync(scriptPath, `#!/bin/sh
echo "brew $*" >> "${logFile}"
if [ "$1" = "update" ]; then exit 0; fi
exit 1
`)
    fs.chmodSync(scriptPath, 0o755)
    writeMock('prove_it', 0)

    const workDir = path.join(tmpDir, 'fail-upgrade')
    fs.mkdirSync(workDir)

    const r = runUpgrade(workDir)
    assert.strictEqual(r.status, 1)
    assert.match(r.stderr, /brew upgrade failed/)

    const calls = getCalls()
    assert.strictEqual(calls.length, 2, 'should call brew update and brew upgrade only')
  })

  it('stops and exits 1 on prove_it install failure', () => {
    writeMock('brew', 0)
    // prove_it mock that fails for install
    const scriptPath = path.join(binDir, 'prove_it')
    fs.writeFileSync(scriptPath, `#!/bin/sh
echo "prove_it $*" >> "${logFile}"
exit 1
`)
    fs.chmodSync(scriptPath, 0o755)

    const workDir = path.join(tmpDir, 'fail-install')
    fs.mkdirSync(workDir)

    const r = runUpgrade(workDir)
    assert.strictEqual(r.status, 1)
    assert.match(r.stderr, /prove_it install failed/)

    const calls = getCalls()
    assert.strictEqual(calls.length, 3, 'should call brew update, upgrade, and prove_it install')
  })

  it('skips prove_it init when no project config exists', () => {
    writeMock('brew', 0)
    writeMock('prove_it', 0)

    const workDir = path.join(tmpDir, 'no-config')
    fs.mkdirSync(workDir)

    const r = runUpgrade(workDir)
    assert.strictEqual(r.status, 0)

    const calls = getCalls()
    assert.strictEqual(calls.length, 3, 'should not call prove_it init')
    assert.doesNotMatch(r.stdout, /Reinitializing/)
  })
})
