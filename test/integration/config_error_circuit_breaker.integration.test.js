const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  writeConfig,
  isolatedEnv,
  assertValidPermissionDecision
} = require('./hook-harness')

/**
 * Config error circuit breaker: invalid configs must not create a death spiral.
 *
 * First error → non-blocking warning. Subsequent errors → silent exit.
 * SessionStart always emits the error prominently.
 */
describe('Config error circuit breaker', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_cfgerr_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  function writeInvalidConfig (dir) {
    const cfgPath = path.join(dir, '.claude', 'prove_it', 'config.json')
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify({
      enabled: true,
      staleKeyFromOldVersion: true,
      hooks: []
    }), 'utf8')
  }

  // ──── PreToolUse ────

  describe('PreToolUse with invalid config', () => {
    it('first error emits allow (not deny)', () => {
      writeInvalidConfig(tmpDir)
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        session_id: 'test-cfgerr-ptu',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce output on first config error')
      assertValidPermissionDecision(result, 'config-error-ptu')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'allow',
        'Config error should allow (not deny) to avoid death spiral'
      )
    })

    it('second error in same session emits nothing (silent exit)', () => {
      writeInvalidConfig(tmpDir)
      const sessionId = 'test-cfgerr-ptu-repeat'
      const env = isolatedEnv(tmpDir)

      // First call: sets the circuit breaker
      invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      // Second call: should be silent
      const result2 = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'foo.js', old_string: 'a', new_string: 'b' },
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result2.exitCode, 0)
      assert.strictEqual(result2.output, null,
        'Second config error should produce no output (silent exit)')
    })
  })

  // ──── Stop ────

  describe('Stop with invalid config', () => {
    it('first error emits approve (not block)', () => {
      writeInvalidConfig(tmpDir)
      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-cfgerr-stop',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce output on first config error')
      assert.strictEqual(result.output.decision, 'approve',
        'Config error should approve (not block) to avoid death spiral')
    })

    it('second error in same session emits nothing (silent exit)', () => {
      writeInvalidConfig(tmpDir)
      const sessionId = 'test-cfgerr-stop-repeat'
      const env = isolatedEnv(tmpDir)

      // First call
      invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      // Second call: silent
      const result2 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result2.exitCode, 0)
      assert.strictEqual(result2.output, null,
        'Second config error should produce no output (silent exit)')
    })
  })

  // ──── SessionStart ────

  describe('SessionStart with invalid config', () => {
    it('always emits the error (even on repeat)', () => {
      writeInvalidConfig(tmpDir)
      const sessionId = 'test-cfgerr-start'
      const env = isolatedEnv(tmpDir)

      // First call
      const result1 = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result1.exitCode, 0)
      assert.ok(result1.output, 'SessionStart should produce output')
      assert.ok(result1.output.additionalContext,
        'SessionStart should include additionalContext')
      assert.ok(result1.output.additionalContext.includes('invalid'),
        'additionalContext should mention config is invalid')
      assert.ok(result1.output.systemMessage,
        'SessionStart should include systemMessage')

      // Second call (resume): should still emit
      const result2 = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result2.exitCode, 0)
      assert.ok(result2.output, 'SessionStart should produce output on repeat')
      assert.ok(result2.output.additionalContext,
        'Repeat SessionStart should include additionalContext')
    })
  })

  // ──── Logging ────

  describe('config error logging', () => {
    it('logs BOOM to session log on first error', () => {
      writeInvalidConfig(tmpDir)
      const sessionId = 'test-cfgerr-log'
      const env = isolatedEnv(tmpDir)

      invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      assert.ok(fs.existsSync(logPath), `Session log should exist at ${logPath}`)
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const boomEntry = entries.find(e => e.reviewer === 'config' && e.status === 'BOOM')
      assert.ok(boomEntry, 'Should have a BOOM log entry for config error')
      assert.ok(boomEntry.reason.includes('Unknown key'),
        `BOOM reason should mention the unknown key, got: ${boomEntry.reason}`)
    })

    it('does not log BOOM on second error (already reported)', () => {
      writeInvalidConfig(tmpDir)
      const sessionId = 'test-cfgerr-log-dedup'
      const env = isolatedEnv(tmpDir)

      // First call
      invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      // Second call
      invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const boomEntries = entries.filter(e => e.reviewer === 'config' && e.status === 'BOOM')
      assert.strictEqual(boomEntries.length, 1,
        'Should have exactly one BOOM entry (not duplicated)')
    })
  })

  // ──── Session state ────

  describe('config error saved to session state', () => {
    it('saves configError to session state', () => {
      writeInvalidConfig(tmpDir)
      const sessionId = 'test-cfgerr-state'
      const env = isolatedEnv(tmpDir)

      invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      const statePath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.json`)
      assert.ok(fs.existsSync(statePath), `Session state should exist at ${statePath}`)
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert.ok(state.configError, 'Session state should have configError key')
      assert.ok(state.configError.includes('Unknown key'),
        `configError should mention the unknown key, got: ${state.configError}`)
    })
  })

  // ──── JSON parse error ────

  describe('JSON parse error is non-blocking', () => {
    it('emits allow for PreToolUse with malformed stdin', () => {
      writeConfig(tmpDir, { enabled: true, hooks: [] })
      const { spawnSync: sp } = require('child_process')
      const CLI_PATH = path.join(__dirname, '..', '..', 'cli.js')
      const env = { ...isolatedEnv(tmpDir), CLAUDE_PROJECT_DIR: tmpDir }
      const result = sp('node', [CLI_PATH, 'hook', 'claude:PreToolUse'], {
        input: 'not valid json{{{',
        encoding: 'utf8',
        env
      })

      assert.strictEqual(result.status, 0)
      const output = JSON.parse(result.stdout)
      assert.strictEqual(
        output.hookSpecificOutput.permissionDecision,
        'allow',
        'JSON parse error should allow (not deny)'
      )
    })

    it('emits approve for Stop with malformed stdin', () => {
      writeConfig(tmpDir, { enabled: true, hooks: [] })
      const { spawnSync: sp } = require('child_process')
      const CLI_PATH = path.join(__dirname, '..', '..', 'cli.js')
      const env = { ...isolatedEnv(tmpDir), CLAUDE_PROJECT_DIR: tmpDir }
      const result = sp('node', [CLI_PATH, 'hook', 'claude:Stop'], {
        input: 'not valid json{{{',
        encoding: 'utf8',
        env
      })

      assert.strictEqual(result.status, 0)
      const output = JSON.parse(result.stdout)
      assert.strictEqual(output.decision, 'approve',
        'JSON parse error should approve (not block)')
    })
  })
})
