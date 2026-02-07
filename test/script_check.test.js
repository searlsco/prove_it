const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { isBuiltin, getBuiltinName, runScriptCheck } = require('../lib/checks/script')

describe('script check', () => {
  describe('isBuiltin', () => {
    it('returns true for prove_it builtin: prefix', () => {
      assert.ok(isBuiltin('prove_it builtin:config-protection'))
    })

    it('returns true for other builtins', () => {
      assert.ok(isBuiltin('prove_it builtin:beads-gate'))
    })

    it('returns false for regular commands', () => {
      assert.ok(!isBuiltin('./script/test'))
    })

    it('returns false for null', () => {
      assert.ok(!isBuiltin(null))
    })

    it('returns false for undefined', () => {
      assert.ok(!isBuiltin(undefined))
    })
  })

  describe('getBuiltinName', () => {
    it('extracts name from builtin command', () => {
      assert.strictEqual(getBuiltinName('prove_it builtin:config-protection'), 'config-protection')
    })

    it('extracts beads-gate name', () => {
      assert.strictEqual(getBuiltinName('prove_it builtin:beads-gate'), 'beads-gate')
    })
  })

  describe('runScriptCheck', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_script_test_'))
      spawnSync('git', ['init'], { cwd: tmpDir })
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
      fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '')
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns pass for exit 0 scripts', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/bin/bash\nexit 0\n')
      fs.chmodSync(scriptPath, 0o755)

      const result = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.skipped, false)
    })

    it('returns fail for exit 1 scripts', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/bin/bash\necho "failure" >&2\nexit 1\n')
      fs.chmodSync(scriptPath, 0o755)

      const result = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('failed'))
    })

    it('returns fail when script does not exist', () => {
      const result = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('Script not found'))
    })

    it('returns fail for unknown builtin', () => {
      const result = runScriptCheck(
        { name: 'test', command: 'prove_it builtin:nonexistent' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('Unknown builtin'))
    })

    function setAllTrackedMtimes (dir, time) {
      const tracked = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' })
      for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
        fs.utimesSync(path.join(dir, file), time, time)
      }
    }

    it('uses mtime cache for cached pass', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/bin/bash\nexit 0\n')
      fs.chmodSync(scriptPath, 0o755)
      spawnSync('git', ['add', 'script/test'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add test'], { cwd: tmpDir })

      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
      const runTime = Date.now()
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'my-test': { at: runTime, pass: true } }
      }))

      // Set ALL tracked file mtimes to well before the run time
      const past = new Date(runTime - 5000)
      setAllTrackedMtimes(tmpDir, past)

      const result = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.skipped, true)
      assert.ok(result.reason.includes('cached pass'))
    })

    it('uses mtime cache for cached fail', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/bin/bash\nexit 0\n')
      fs.chmodSync(scriptPath, 0o755)
      spawnSync('git', ['add', 'script/test'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add test'], { cwd: tmpDir })

      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
      const runTime = Date.now()
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'my-test': { at: runTime, pass: false } }
      }))

      const past = new Date(runTime - 5000)
      setAllTrackedMtimes(tmpDir, past)

      const result = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.skipped, true)
      assert.ok(result.reason.includes('Tests failed and no code has changed'))
    })

    it('skips mtime check when mtime: false', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/bin/bash\nexit 0\n')
      fs.chmodSync(scriptPath, 0o755)
      spawnSync('git', ['add', 'script/test'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add test'], { cwd: tmpDir })

      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
      const runTime = Date.now()
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'my-test': { at: runTime, pass: false } }
      }))

      const past = new Date(runTime - 5000)
      setAllTrackedMtimes(tmpDir, past)

      const result = runScriptCheck(
        { name: 'my-test', command: './script/test', mtime: false },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      // Should actually run the script (exit 0) instead of using cache
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.skipped, false)
    })
  })
})
