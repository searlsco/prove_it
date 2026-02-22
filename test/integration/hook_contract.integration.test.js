const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  createTestScript,
  createFastTestScript,
  writeConfig,
  makeConfig,
  assertValidPermissionDecision,
  isolatedEnv
} = require('./hook-harness')

/**
 * Contract tests: verify that all dispatcher outputs conform to Claude Code's
 * expected schema. This prevents bugs like using "block" instead of "deny"
 * for permissionDecision—values Claude Code silently ignores.
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

  describe('PreToolUse config:lock decisions', () => {
    beforeEach(() => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
          tasks: [
            { name: 'lock-config', type: 'script', command: 'prove_it run_builtin config:lock' }
          ]
        }
      ]))
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
      assert.ok(result.output.systemMessage,
        'denied PreToolUse should include systemMessage')
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
          tasks: [
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
          tasks: [
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
          tasks: [
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
      assert.ok(result.output.systemMessage,
        'blocked Stop should include systemMessage')
    })

    it('uses approve when tests pass', () => {
      createFastTestScript(tmpDir, true)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
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
      assert.strictEqual(result.output.systemMessage, undefined,
        'approved Stop should not include systemMessage')
    })
  })
})
