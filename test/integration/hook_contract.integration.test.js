const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const path = require('path')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  createTestScript,
  createFastTestScript,
  initBeads,
  writeConfig,
  makeConfig,
  assertValidPermissionDecision,
  isolatedEnv,
  VALID_PERMISSION_DECISIONS
} = require('./hook-harness')

/**
 * Contract tests: verify that all dispatcher outputs conform to Claude Code's
 * expected schema. This prevents bugs like using "block" instead of "deny"
 * for permissionDecision — values Claude Code silently ignores.
 */
describe('Claude Code hook output contract', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_contract_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  describe('PreToolUse config-protection decisions', () => {
    beforeEach(() => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Edit|Write|NotebookEdit|Bash',
          checks: [
            { name: 'config-protection', type: 'script', command: 'prove_it builtin:config-protection' },
            { name: 'beads-gate', type: 'script', command: 'prove_it builtin:beads-gate', when: { fileExists: '.beads' } }
          ]
        }
      ]))
      initBeads(tmpDir)
    })

    it('uses valid permissionDecision when denying config Edit', () => {
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '.claude/prove_it.json', old_string: 'a', new_string: 'b' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assertValidPermissionDecision(result, 'config-edit')
      if (result.output?.hookSpecificOutput?.permissionDecision) {
        assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
      }
    })

    it('uses valid permissionDecision when denying config Write', () => {
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '.claude/prove_it.local.json', content: '{}' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assertValidPermissionDecision(result, 'config-write')
      if (result.output?.hookSpecificOutput?.permissionDecision) {
        assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
      }
    })

    it('uses valid permissionDecision when denying config Bash redirect', () => {
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: "echo '{}' > .claude/prove_it.local.json" },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assertValidPermissionDecision(result, 'config-bash-write')
      if (result.output?.hookSpecificOutput?.permissionDecision) {
        assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
      }
    })
  })

  describe('PreToolUse test-gate decisions', () => {
    it('uses valid permissionDecision when wrapping git commit', () => {
      createTestScript(tmpDir, true)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          triggers: ['(^|\\s)git\\s+commit\\b'],
          checks: [
            { name: 'full-tests', type: 'script', command: './script/test' }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assertValidPermissionDecision(result, 'done/git-commit')
    })

    it('uses deny when test script is missing', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          triggers: ['(^|\\s)git\\s+commit\\b'],
          checks: [
            { name: 'full-tests', type: 'script', command: './script/test' }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assertValidPermissionDecision(result, 'done/missing-script')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'deny',
        'Should deny when test script is missing'
      )
    })
  })

  describe('Stop decisions', () => {
    it('uses block when tests fail', () => {
      createFastTestScript(tmpDir, false)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          checks: [
            { name: 'fast-tests', type: 'script', command: './script/test_fast' }
          ]
        }
      ]))

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-contract-stop',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.output.decision, 'block')
    })

    it('uses approve when tests pass', () => {
      createFastTestScript(tmpDir, true)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          checks: [
            { name: 'fast-tests', type: 'script', command: './script/test_fast' }
          ]
        }
      ]))

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-contract-stop-pass',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.output.decision, 'approve')
    })
  })

  describe('session_id passed as parameter via subprocess', () => {
    it('session functions write to correct files when given session_id', () => {
      const probeScript = path.join(tmpDir, 'session_probe.js')
      const proveItDir = path.join(tmpDir, 'prove_it_state')
      const sharedPath = path.join(__dirname, '..', '..', 'lib', 'shared.js')

      createFile(tmpDir, 'session_probe.js', [
        `const { saveSessionState, logReview } = require(${JSON.stringify(sharedPath)});`,
        'const input = JSON.parse(require("fs").readFileSync(0, "utf8"));',
        'const sessionId = input.session_id || null;',
        'saveSessionState(sessionId, "probe_key", "probe_value");',
        'logReview(sessionId, "/test", "probe", "pass", "propagation test");'
      ].join('\n'))

      const result = spawnSync('node', [probeScript], {
        input: JSON.stringify({ session_id: 'test-session-xyz789' }),
        encoding: 'utf8',
        env: { ...process.env, PROVE_IT_DIR: proveItDir }
      })

      assert.strictEqual(result.status, 0, `Probe script should exit 0: ${result.stderr}`)

      const fs = require('fs')
      const stateFile = path.join(proveItDir, 'sessions', 'test-session-xyz789.json')
      assert.ok(fs.existsSync(stateFile), `State file should exist at ${stateFile}`)
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      assert.strictEqual(state.probe_key, 'probe_value')

      const logFile = path.join(proveItDir, 'sessions', 'test-session-xyz789.jsonl')
      assert.ok(fs.existsSync(logFile), `Log file should exist at ${logFile}`)
      const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim())
      assert.strictEqual(entry.reviewer, 'probe')
      assert.strictEqual(entry.status, 'pass')
      assert.strictEqual(entry.sessionId, 'test-session-xyz789')
    })

    it('without session_id, state functions gracefully degrade', () => {
      const probeScript = path.join(tmpDir, 'session_probe_no_id.js')
      const proveItDir = path.join(tmpDir, 'prove_it_no_id')
      const sharedPath = path.join(__dirname, '..', '..', 'lib', 'shared.js')

      createFile(tmpDir, 'session_probe_no_id.js', [
        `const { saveSessionState, loadSessionState, logReview } = require(${JSON.stringify(sharedPath)});`,
        'const input = JSON.parse(require("fs").readFileSync(0, "utf8"));',
        'const sessionId = input.session_id || null;',
        'saveSessionState(sessionId, "key", "value");',
        'const result = loadSessionState(sessionId, "key");',
        'logReview(sessionId, "/test", "probe", "pass", "no session");',
        'process.stdout.write(JSON.stringify({ loadResult: result }));'
      ].join('\n'))

      const result = spawnSync('node', [probeScript], {
        input: JSON.stringify({}),
        encoding: 'utf8',
        env: { ...process.env, PROVE_IT_DIR: proveItDir }
      })

      assert.strictEqual(result.status, 0, `Probe script should exit 0: ${result.stderr}`)
      const output = JSON.parse(result.stdout)
      assert.strictEqual(output.loadResult, null)

      const fs = require('fs')
      const unknownLog = path.join(proveItDir, 'sessions', 'unknown.jsonl')
      assert.ok(!fs.existsSync(unknownLog), 'Should not create unknown.jsonl')
    })
  })

  describe('exhaustive: no hook emits invalid permissionDecision values', () => {
    it("rejects a hypothetical 'block' value", () => {
      assert.ok(
        !VALID_PERMISSION_DECISIONS.includes('block'),
        "'block' must not be in the valid set — Claude Code ignores it"
      )
    })

    it("rejects a hypothetical 'approve' value", () => {
      assert.ok(
        !VALID_PERMISSION_DECISIONS.includes('approve'),
        "'approve' must not be in the valid set — use 'allow' instead"
      )
    })
  })
})
