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
  makeConfig,
  assertValidPermissionDecision,
  isolatedEnv
} = require('./hook-harness')

const { SIGNAL_TASK_MARKER } = require('../../lib/dispatcher/claude')

describe('Plan mode enforcement via PreToolUse', () => {
  let tmpDir, env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_planmode_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
    env = isolatedEnv(tmpDir)
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  describe('EnterPlanMode — silent pass-through', () => {
    it('exits silently when signal-gated tasks exist', () => {
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
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output (silent exit)')
    })

    it('exits silently when no signal-gated tasks exist', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-enter-plan-no-signal',
        tool_name: 'EnterPlanMode',
        tool_input: {}
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output when no signal-gated tasks')
    })
  })

  describe('ExitPlanMode — plan file editing', () => {
    it('appends signal task to matching plan file', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
          ]
        }
      ]))

      // Create a plan file
      const plansDir = path.join(tmpDir, '.claude', 'plans')
      fs.mkdirSync(plansDir, { recursive: true })
      const planText = '1. Implement feature\n2. Run tests\n3. Deploy'
      fs.writeFileSync(path.join(plansDir, 'test-plan.md'), planText)

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-exit-plan-edit',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: planText }
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result.exitCode, 0)
      assertValidPermissionDecision(result, 'ExitPlanMode')
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')

      // Verify plan file was edited
      const content = fs.readFileSync(path.join(plansDir, 'test-plan.md'), 'utf8')
      assert.ok(content.includes(SIGNAL_TASK_MARKER), `Plan file should contain signal task marker, got:\n${content}`)
      assert.ok(content.includes('Mark this task complete'), 'Plan file should contain task instructions')
    })

    it('does not double-append signal task', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
          ]
        }
      ]))

      const plansDir = path.join(tmpDir, '.claude', 'plans')
      fs.mkdirSync(plansDir, { recursive: true })
      const planText = '1. Implement feature\n2. Run tests'
      // Pre-write with marker already present
      fs.writeFileSync(path.join(plansDir, 'test-plan.md'), planText + '\n' + SIGNAL_TASK_MARKER + '\n\nAlready here.\n')

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-exit-plan-no-dupe',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: planText }
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')

      // Should still have exactly one marker
      const content = fs.readFileSync(path.join(plansDir, 'test-plan.md'), 'utf8')
      const markerCount = content.split(SIGNAL_TASK_MARKER).length - 1
      assert.strictEqual(markerCount, 1, `Should have exactly 1 marker, found ${markerCount}`)
    })

    it('skips editing when no signal-gated tasks exist', () => {
      writeConfig(tmpDir, makeConfig([]))

      const plansDir = path.join(tmpDir, '.claude', 'plans')
      fs.mkdirSync(plansDir, { recursive: true })
      const planText = '1. Do stuff\n2. Done'
      fs.writeFileSync(path.join(plansDir, 'test-plan.md'), planText)

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-exit-plan-no-gate',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: planText }
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')

      // Plan file should be unchanged
      const content = fs.readFileSync(path.join(plansDir, 'test-plan.md'), 'utf8')
      assert.ok(!content.includes(SIGNAL_TASK_MARKER), 'Plan file should not be edited when no signal-gated tasks')
    })

    it('allows even when plan file not found', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
          ]
        }
      ]))

      // No plans dir at all
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: 'test-exit-plan-no-file',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: '1. Do stuff\n2. Done' }
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
    })
  })
})
