const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { isBuiltin, getBuiltinName, runScriptCheck } = require('../lib/checks/script')

describe('script check', () => {
  describe('isBuiltin', () => {
    it('returns true for prove_it run_builtin prefix', () => {
      assert.ok(isBuiltin('prove_it run_builtin config:lock'))
    })

    it('returns true for other run_builtin builtins', () => {
      assert.ok(isBuiltin('prove_it run_builtin some:check'))
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
    it('extracts name from run_builtin command', () => {
      assert.strictEqual(getBuiltinName('prove_it run_builtin config:lock'), 'config:lock')
    })

    it('extracts namespaced name', () => {
      assert.strictEqual(getBuiltinName('prove_it run_builtin some:check'), 'some:check')
    })
  })

  describe('runScriptCheck', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_script_test_'))
      origProveItDir = process.env.PROVE_IT_DIR
      process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
      spawnSync('git', ['init'], { cwd: tmpDir })
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
      fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '')
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
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

    it('returns pass for exit 0 scripts', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(scriptPath, 0o755)

      const result = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.cached, undefined)
    })

    it('returns fail for exit 1 scripts', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\necho "failure" >&2\nexit 1\n')
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
        { name: 'test', command: 'prove_it run_builtin nonexistent' },
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
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
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
      assert.strictEqual(result.cached, true)
      assert.ok(result.reason.includes('cached pass'))
    })

    it('uses mtime cache for cached fail', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
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
      assert.strictEqual(result.cached, true)
      assert.ok(result.reason.includes('Tests failed and no code has changed'))
    })

    it('skips mtime check when mtime: false', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
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
      assert.strictEqual(result.cached, undefined)
    })

    it('saves run data with result enum instead of pass boolean', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(scriptPath, 0o755)

      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })

      runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )

      const data = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'))
      assert.strictEqual(data.runs['my-test'].result, 'pass')
      assert.strictEqual(data.runs['my-test'].pass, undefined)
    })

    it('saves fail result for failing scripts', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 1\n')
      fs.chmodSync(scriptPath, 0o755)

      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })

      runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )

      const data = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'))
      assert.strictEqual(data.runs['my-test'].result, 'fail')
    })

    it('reads old format (pass: true) via backward compat', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(scriptPath, 0o755)
      spawnSync('git', ['add', 'script/test'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add test'], { cwd: tmpDir })

      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
      const runTime = Date.now()
      // Old format: { at, pass: true }
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'my-test': { at: runTime, pass: true } }
      }))

      const past = new Date(runTime - 5000)
      setAllTrackedMtimes(tmpDir, past)

      const result = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      // Should still read old format correctly — cached pass
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.cached, true)
    })

    describe('configEnv', () => {
      it('passes config env vars to script subprocess', () => {
        const scriptPath = path.join(tmpDir, 'script', 'env_check')
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, [
          '#!/usr/bin/env bash',
          'if [ "$MY_CUSTOM_VAR" = "hello" ]; then',
          '  exit 0',
          'else',
          '  echo "MY_CUSTOM_VAR was not set" >&2',
          '  exit 1',
          'fi'
        ].join('\n'))
        fs.chmodSync(scriptPath, 0o755)

        const result = runScriptCheck(
          { name: 'env-test', command: './script/env_check' },
          { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, configEnv: { MY_CUSTOM_VAR: 'hello' } }
        )
        assert.strictEqual(result.pass, true)
      })

      it('does not let configEnv override PROVE_IT_DISABLED', () => {
        const scriptPath = path.join(tmpDir, 'script', 'forced_check')
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, [
          '#!/usr/bin/env bash',
          'if [ "$PROVE_IT_DISABLED" = "1" ]; then',
          '  exit 0',
          'else',
          '  echo "PROVE_IT_DISABLED was overridden" >&2',
          '  exit 1',
          'fi'
        ].join('\n'))
        fs.chmodSync(scriptPath, 0o755)

        const result = runScriptCheck(
          { name: 'forced-test', command: './script/forced_check' },
          { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, configEnv: { PROVE_IT_DISABLED: '0' } }
        )
        assert.strictEqual(result.pass, true, `Expected forced var to win, got: ${result.reason}`)
      })

      it('applies forced vars even when configEnv is null', () => {
        const scriptPath = path.join(tmpDir, 'script', 'forced_null')
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, [
          '#!/usr/bin/env bash',
          'if [ "$PROVE_IT_DISABLED" = "1" ]; then',
          '  exit 0',
          'else',
          '  echo "PROVE_IT_DISABLED was not forced" >&2',
          '  exit 1',
          'fi'
        ].join('\n'))
        fs.chmodSync(scriptPath, 0o755)

        const result = runScriptCheck(
          { name: 'forced-null', command: './script/forced_null' },
          { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, configEnv: null }
        )
        assert.strictEqual(result.pass, true, `Expected forced vars even with null configEnv, got: ${result.reason}`)
      })
    })

    describe('logReview integration', () => {
      const SESSION_ID = 'test-session-script-log'

      it('logs PASS when script succeeds', () => {
        const scriptPath = path.join(tmpDir, 'script', 'test')
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
        fs.chmodSync(scriptPath, 0o755)

        runScriptCheck(
          { name: 'my-test', command: './script/test' },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: SESSION_ID, localCfgPath: null, sources: null, maxChars: 12000 }
        )

        const entries = readLogEntries(SESSION_ID)
        assert.strictEqual(entries.length, 1)
        assert.strictEqual(entries[0].status, 'PASS')
        assert.strictEqual(entries[0].reviewer, 'my-test')
        assert.ok(entries[0].reason.includes('passed'))
      })

      it('logs FAIL when script fails', () => {
        const scriptPath = path.join(tmpDir, 'script', 'test')
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 1\n')
        fs.chmodSync(scriptPath, 0o755)

        runScriptCheck(
          { name: 'my-test', command: './script/test' },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: SESSION_ID, localCfgPath: null, sources: null, maxChars: 12000 }
        )

        const entries = readLogEntries(SESSION_ID)
        assert.strictEqual(entries.length, 1)
        assert.strictEqual(entries[0].status, 'FAIL')
        assert.ok(entries[0].reason.includes('failed'))
      })

      it('logs FAIL when script not found', () => {
        runScriptCheck(
          { name: 'missing', command: './script/nope' },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: SESSION_ID, localCfgPath: null, sources: null, maxChars: 12000 }
        )

        const entries = readLogEntries(SESSION_ID)
        assert.strictEqual(entries.length, 1)
        assert.strictEqual(entries[0].status, 'FAIL')
        assert.ok(entries[0].reason.includes('Script not found'))
      })

      it('logs SKIP for cached pass', () => {
        const scriptPath = path.join(tmpDir, 'script', 'test')
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
        fs.chmodSync(scriptPath, 0o755)
        spawnSync('git', ['add', 'script/test'], { cwd: tmpDir })
        spawnSync('git', ['commit', '-m', 'add test'], { cwd: tmpDir })

        const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
        fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
        const runTime = Date.now()
        fs.writeFileSync(localCfgPath, JSON.stringify({
          runs: { 'my-test': { at: runTime, pass: true } }
        }))

        const past = new Date(runTime - 5000)
        setAllTrackedMtimes(tmpDir, past)

        runScriptCheck(
          { name: 'my-test', command: './script/test' },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: SESSION_ID, localCfgPath, sources: null, maxChars: 12000 }
        )

        const entries = readLogEntries(SESSION_ID)
        assert.strictEqual(entries.length, 1)
        assert.strictEqual(entries[0].status, 'SKIP')
        assert.ok(entries[0].reason.includes('cached pass'))
      })

      it('logs FAIL for unknown builtin', () => {
        runScriptCheck(
          { name: 'bad-builtin', command: 'prove_it run_builtin nonexistent' },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: SESSION_ID, localCfgPath: null, sources: null, maxChars: 12000 }
        )

        const entries = readLogEntries(SESSION_ID)
        assert.strictEqual(entries.length, 1)
        assert.strictEqual(entries[0].status, 'FAIL')
        assert.ok(entries[0].reason.includes('Unknown builtin'))
      })

      it('does not log when sessionId and projectDir are both absent', () => {
        const scriptPath = path.join(tmpDir, 'script', 'test')
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n')
        fs.chmodSync(scriptPath, 0o755)

        runScriptCheck(
          { name: 'my-test', command: './script/test' },
          { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
        )

        const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
        const exists = fs.existsSync(sessionsDir)
        if (exists) {
          const files = fs.readdirSync(sessionsDir)
          assert.strictEqual(files.length, 0, 'No log files should be created')
        }
      })
    })
  })
})
