const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  writeConfig,
  makeConfig,
  assertValidPermissionDecision,
  isolatedEnv
} = require('./hook-harness')

describe('Plan mode enforcement via PreToolUse', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_planmode_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  describe('EnterPlanMode — soft reminder', () => {
    it('injects signal instruction as systemMessage when signal-gated tasks exist', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-enter-plan',
        tool_name: 'EnterPlanMode',
        tool_input: {}
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assertValidPermissionDecision(result, 'EnterPlanMode')
      assert.ok(result.output, 'Should produce JSON output')
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
      assert.ok(
        result.output.systemMessage.includes('prove_it signal done'),
        `systemMessage should include signal instruction, got: ${result.output.systemMessage}`
      )
    })

    it('exits silently when no signal-gated tasks exist', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-enter-plan-no-signal',
        tool_name: 'EnterPlanMode',
        tool_input: {}
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      // No output means silent allow
      assert.strictEqual(result.output, null, 'Should produce no output when no signal-gated tasks')
    })
  })

  describe('ExitPlanMode — hard gate', () => {
    it('denies when plan text is missing signal step', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-exit-plan-deny',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: '1. Do stuff\n2. Run tests\n3. Done' }
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assertValidPermissionDecision(result, 'ExitPlanMode deny')
      assert.ok(result.output, 'Should produce JSON output')
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('Verify & Signal'),
        `reason should mention Verify & Signal, got: ${result.output.hookSpecificOutput.permissionDecisionReason}`
      )
    })

    it('allows when plan text includes signal step', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-exit-plan-allow',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: '1. Implement feature\n2. Run tests\n3. prove_it signal done -m "done"' }
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assertValidPermissionDecision(result, 'ExitPlanMode allow')
      assert.ok(result.output, 'Should produce JSON output')
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
    })

    it('allows when no signal-gated tasks exist (no gate needed)', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-exit-plan-no-gate',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: '1. Do stuff\n2. Done' }
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assertValidPermissionDecision(result, 'ExitPlanMode no gate')
      assert.ok(result.output, 'Should produce JSON output')
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
    })

    it('denies when plan text is empty', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-exit-plan-empty',
        tool_name: 'ExitPlanMode',
        tool_input: {}
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    })
  })
})
