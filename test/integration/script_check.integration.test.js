const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { isBuiltin, getBuiltinName, runScriptCheck } = require('../../lib/checks/script')
const { freshRepo } = require('../helpers')

describe('script check', () => {
  // 1. isBuiltin—parameterized (5 → 1)
  describe('isBuiltin', () => {
    it('returns expected results for various inputs', () => {
      const cases = [
        ['prove_it run_builtin config:lock', true],
        ['prove_it run_builtin some:check', true],
        ['./script/test', false],
        [null, false],
        [undefined, false]
      ]
      for (const [input, expected] of cases) {
        assert.strictEqual(!!isBuiltin(input), expected,
          `isBuiltin(${JSON.stringify(input)}) should be ${expected}`)
      }
    })
  })

  // 2. getBuiltinName—parameterized (2 → 1)
  describe('getBuiltinName', () => {
    it('extracts the name from run_builtin commands', () => {
      const cases = [
        ['prove_it run_builtin config:lock', 'config:lock'],
        ['prove_it run_builtin some:check', 'some:check']
      ]
      for (const [input, expected] of cases) {
        assert.strictEqual(getBuiltinName(input), expected)
      }
    })
  })

  describe('runScriptCheck', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = freshRepo()
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

    function setAllTrackedMtimes (dir, time) {
      const tracked = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' })
      for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
        fs.utimesSync(path.join(dir, file), time, time)
      }
    }

    function makeScript (name, body) {
      const scriptPath = path.join(tmpDir, 'script', name)
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}\n`)
      fs.chmodSync(scriptPath, 0o755)
      return scriptPath
    }

    // 3. basic execution story (4 → 1)
    it('basic execution: pass, fail, script not found, unknown builtin', () => {
      // pass—exit 0
      makeScript('pass', 'exit 0')
      const pass = runScriptCheck(
        { name: 'pass-test', command: './script/pass' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(pass.pass, true)
      assert.strictEqual(pass.cached, undefined)

      // fail—exit 1
      makeScript('fail', 'echo "failure" >&2\nexit 1')
      const fail = runScriptCheck(
        { name: 'fail-test', command: './script/fail' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(fail.pass, false)
      assert.ok(fail.reason.includes('failed'))

      // script not found
      const notFound = runScriptCheck(
        { name: 'missing', command: './script/nope' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(notFound.pass, false)
      assert.ok(notFound.reason.includes('Script not found'))

      // unknown builtin
      const badBuiltin = runScriptCheck(
        { name: 'bad', command: 'prove_it run_builtin nonexistent' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(badBuiltin.pass, false)
      assert.ok(badBuiltin.reason.includes('Unknown builtin'))
    })

    // 4. mtime caching story (3 → 1)
    it('mtime caching: cached pass, failure re-runs, mtime:false bypass', () => {
      makeScript('test', 'exit 0')
      spawnSync('git', ['add', 'script/test'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add test'], { cwd: tmpDir })

      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
      const runTime = Date.now()

      const past = new Date(runTime - 5000)
      setAllTrackedMtimes(tmpDir, past)

      // cached pass—previous pass + no file changes → cached
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'my-test': { at: runTime, pass: true } }
      }))
      const cached = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(cached.pass, true)
      assert.strictEqual(cached.cached, true)
      assert.ok(cached.reason.includes('cached pass'))

      // failure re-runs—previous fail + no file changes → actually re-runs (exits 0)
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'my-test': { at: runTime, pass: false } }
      }))
      const rerun = runScriptCheck(
        { name: 'my-test', command: './script/test' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(rerun.pass, true)
      assert.strictEqual(rerun.cached, undefined, 'Should not be cached—actually re-ran')

      // mtime:false bypass—skips cache entirely, always runs
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'my-test': { at: runTime, pass: false } }
      }))
      const bypass = runScriptCheck(
        { name: 'my-test', command: './script/test', mtime: false },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(bypass.pass, true)
      assert.strictEqual(bypass.cached, undefined)
    })

    // 5. run data persistence story (4 → 1)
    it('run data persistence: result enum, fail result, old format backward compat', () => {
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })

      // saves pass result as enum
      makeScript('pass', 'exit 0')
      runScriptCheck(
        { name: 'my-test', command: './script/pass' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      const passData = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'))
      assert.strictEqual(passData.runs['my-test'].result, 'pass')
      assert.strictEqual(passData.runs['my-test'].pass, undefined)

      // saves fail result
      makeScript('fail', 'exit 1')
      runScriptCheck(
        { name: 'fail-test', command: './script/fail' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      const failData = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'))
      assert.strictEqual(failData.runs['fail-test'].result, 'fail')

      // backward compat: reads old format { at, pass: true } as cached pass
      makeScript('compat', 'exit 0')
      spawnSync('git', ['add', 'script/compat'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add compat'], { cwd: tmpDir })

      const runTime = Date.now()
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'compat-test': { at: runTime, pass: true } }
      }))
      const past = new Date(runTime - 5000)
      setAllTrackedMtimes(tmpDir, past)

      const compat = runScriptCheck(
        { name: 'compat-test', command: './script/compat' },
        { rootDir: tmpDir, localCfgPath, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(compat.pass, true)
      assert.strictEqual(compat.cached, true)
    })

    // 6. configEnv story (3 → 1)
    it('configEnv: custom var, PROVE_IT_DISABLED override protection, null configEnv', () => {
      // custom env var passed to subprocess
      makeScript('env_check', [
        'if [ "$MY_CUSTOM_VAR" = "hello" ]; then',
        '  exit 0',
        'else',
        '  echo "MY_CUSTOM_VAR was not set" >&2',
        '  exit 1',
        'fi'
      ].join('\n'))
      const custom = runScriptCheck(
        { name: 'env-test', command: './script/env_check' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, configEnv: { MY_CUSTOM_VAR: 'hello' } }
      )
      assert.strictEqual(custom.pass, true)

      // PROVE_IT_DISABLED cannot be overridden by configEnv
      makeScript('forced_check', [
        'if [ "$PROVE_IT_DISABLED" = "1" ]; then',
        '  exit 0',
        'else',
        '  echo "PROVE_IT_DISABLED was overridden" >&2',
        '  exit 1',
        'fi'
      ].join('\n'))
      const forced = runScriptCheck(
        { name: 'forced-test', command: './script/forced_check' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, configEnv: { PROVE_IT_DISABLED: '0' } }
      )
      assert.strictEqual(forced.pass, true, `Expected forced var to win, got: ${forced.reason}`)

      // forced vars applied even with null configEnv
      makeScript('forced_null', [
        'if [ "$PROVE_IT_DISABLED" = "1" ]; then',
        '  exit 0',
        'else',
        '  echo "PROVE_IT_DISABLED was not forced" >&2',
        '  exit 1',
        'fi'
      ].join('\n'))
      const nullEnv = runScriptCheck(
        { name: 'forced-null', command: './script/forced_null' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, configEnv: null }
      )
      assert.strictEqual(nullEnv.pass, true, `Expected forced vars even with null configEnv, got: ${nullEnv.reason}`)
    })

    // 7. logReview normal story (5+1 → 1)
    it('logReview normal: PASS, FAIL, FAIL not found, SKIP cached, FAIL unknown builtin, no log without session', () => {
      const SID = 'test-session-log-normal'

      // PASS
      makeScript('test', 'exit 0')
      runScriptCheck(
        { name: 'log-pass', command: './script/test' },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: SID, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      const passEntries = readLogEntries(SID)
      const passRunning = passEntries.filter(e => e.reviewer === 'log-pass' && e.status === 'RUNNING')
      const passResult = passEntries.filter(e => e.reviewer === 'log-pass' && e.status === 'PASS')
      assert.strictEqual(passRunning.length, 1)
      assert.strictEqual(passResult.length, 1)
      assert.ok(passResult[0].reason.includes('passed'))
      // Verbose data on final verdict
      assert.ok(passResult[0].verbose, 'PASS entry should have verbose data')
      assert.strictEqual(passResult[0].verbose.command, './script/test')
      assert.strictEqual(passResult[0].verbose.exitCode, 0)
      assert.strictEqual(typeof passResult[0].verbose.output, 'string')
      // RUNNING entry should NOT have verbose data
      assert.strictEqual(passRunning[0].verbose, undefined, 'RUNNING entry should not have verbose data')

      // FAIL
      makeScript('failing', 'exit 1')
      runScriptCheck(
        { name: 'log-fail', command: './script/failing' },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: SID, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      const failEntries = readLogEntries(SID).filter(e => e.reviewer === 'log-fail')
      assert.strictEqual(failEntries.length, 2)
      assert.strictEqual(failEntries[0].status, 'RUNNING')
      assert.strictEqual(failEntries[1].status, 'FAIL')
      assert.ok(failEntries[1].reason.includes('failed'))
      // Verbose data on FAIL verdict
      assert.ok(failEntries[1].verbose, 'FAIL entry should have verbose data')
      assert.strictEqual(failEntries[1].verbose.command, './script/failing')
      assert.strictEqual(failEntries[1].verbose.exitCode, 1)

      // FAIL—script not found (no RUNNING entry)
      runScriptCheck(
        { name: 'log-missing', command: './script/nope' },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: SID, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      const missingEntries = readLogEntries(SID).filter(e => e.reviewer === 'log-missing')
      assert.strictEqual(missingEntries.length, 1)
      assert.strictEqual(missingEntries[0].status, 'FAIL')
      assert.ok(missingEntries[0].reason.includes('Script not found'))

      // SKIP—cached pass (no RUNNING entry)
      spawnSync('git', ['add', 'script/test'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add test'], { cwd: tmpDir })
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
      const runTime = Date.now()
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'log-cached': { at: runTime, pass: true } }
      }))
      const past = new Date(runTime - 5000)
      setAllTrackedMtimes(tmpDir, past)

      runScriptCheck(
        { name: 'log-cached', command: './script/test' },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: SID, localCfgPath, sources: null, maxChars: 12000 }
      )
      const cachedEntries = readLogEntries(SID).filter(e => e.reviewer === 'log-cached')
      assert.strictEqual(cachedEntries.length, 1, 'Cached skip should not emit RUNNING')
      assert.strictEqual(cachedEntries[0].status, 'SKIP')
      assert.ok(!cachedEntries.some(e => e.status === 'RUNNING'),
        'RUNNING must not appear for mtime-cached results')
      assert.ok(cachedEntries[0].reason.includes('cached pass'))

      // FAIL—unknown builtin
      runScriptCheck(
        { name: 'log-bad-builtin', command: 'prove_it run_builtin nonexistent' },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: SID, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      const builtinEntries = readLogEntries(SID).filter(e => e.reviewer === 'log-bad-builtin')
      assert.strictEqual(builtinEntries.length, 1)
      assert.strictEqual(builtinEntries[0].status, 'FAIL')
      assert.ok(builtinEntries[0].reason.includes('Unknown builtin'))

      // no log without session—no sessionId or projectDir
      const noLogSid = 'test-session-no-log'
      makeScript('nolog', 'exit 0')
      runScriptCheck(
        { name: 'nolog-test', command: './script/nolog' },
        { rootDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      const noLogFile = path.join(sessionsDir, `${noLogSid}.jsonl`)
      assert.ok(!fs.existsSync(noLogFile), 'No log file should be created without sessionId')
    })

    // 8. logReview quiet mode story (4 → 1)
    it('logReview quiet mode: PASS suppressed, FAIL not suppressed, SKIP suppressed, builtin PASS suppressed', () => {
      // quiet PASS—suppressed entirely
      const sidPass = 'test-quiet-pass'
      makeScript('qtest', 'exit 0')
      runScriptCheck(
        { name: 'quiet-test', command: './script/qtest', quiet: true },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: sidPass, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(readLogEntries(sidPass).length, 0,
        'Quiet task pass should produce no log entries')

      // quiet FAIL—not suppressed
      const sidFail = 'test-quiet-fail'
      makeScript('qfail', 'exit 1')
      runScriptCheck(
        { name: 'quiet-fail', command: './script/qfail', quiet: true },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: sidFail, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      const failEntries = readLogEntries(sidFail)
      assert.strictEqual(failEntries.length, 1,
        'Quiet task fail should produce exactly one log entry')
      assert.strictEqual(failEntries[0].status, 'FAIL')

      // quiet SKIP—cached pass suppressed
      const sidSkip = 'test-quiet-skip'
      spawnSync('git', ['add', 'script/qtest'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add qtest'], { cwd: tmpDir })
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
      const runTime = Date.now()
      fs.writeFileSync(localCfgPath, JSON.stringify({
        runs: { 'quiet-skip': { at: runTime, pass: true } }
      }))
      const past = new Date(runTime - 5000)
      setAllTrackedMtimes(tmpDir, past)

      runScriptCheck(
        { name: 'quiet-skip', command: './script/qtest', quiet: true },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: sidSkip, localCfgPath, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(readLogEntries(sidSkip).length, 0,
        'Quiet task cached pass should produce no log entries')

      // quiet builtin PASS—suppressed
      const sidBuiltin = 'test-quiet-builtin'
      runScriptCheck(
        { name: 'quiet-lock', command: 'prove_it run_builtin config:lock', quiet: true },
        { rootDir: tmpDir, projectDir: tmpDir, sessionId: sidBuiltin, localCfgPath: null, sources: null, maxChars: 12000 }
      )
      assert.strictEqual(readLogEntries(sidBuiltin).length, 0,
        'Quiet builtin pass should produce no log entries')
    })
  })
})
