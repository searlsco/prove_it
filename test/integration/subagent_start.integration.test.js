const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  makeExecutable,
  writeConfig,
  makeConfig,
  isolatedEnv
} = require('./hook-harness')

describe('SubagentStart hook', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_subagent_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  describe('Plan agent injection', () => {
    it('injects signal instruction for Plan agent type', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-plan',
        agent_type: 'Plan'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      assert.ok(result.output.hookSpecificOutput, 'Should have hookSpecificOutput')
      assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'SubagentStart')
      assert.ok(
        result.output.hookSpecificOutput.additionalContext.includes('prove_it signal done'),
        `additionalContext should include signal instruction, got: ${result.output.hookSpecificOutput.additionalContext}`
      )
    })
  })

  describe('non-Plan agent types', () => {
    it('produces no output for Explore agent', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-explore',
        agent_type: 'Explore'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output for Explore agent')
    })

    it('produces no output for Bash agent', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-bash',
        agent_type: 'Bash'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output for Bash agent')
    })

    it('produces no output when agent_type is missing', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-none'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output when no agent_type')
    })
  })

  describe('config-driven tasks', () => {
    it('runs script tasks configured for SubagentStart', () => {
      createFile(tmpDir, 'subagent-check.sh', '#!/usr/bin/env bash\necho "subagent context"\nexit 0\n')
      makeExecutable(path.join(tmpDir, 'subagent-check.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SubagentStart',
          tasks: [
            { name: 'subagent-check', type: 'script', command: './subagent-check.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-config',
        agent_type: 'Explore'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      assert.ok(
        result.output.hookSpecificOutput.additionalContext.includes('subagent-check.sh passed'),
        `additionalContext should include script output, got: ${result.output.hookSpecificOutput.additionalContext}`
      )
    })

    it('combines config-driven output with Plan agent injection', () => {
      createFile(tmpDir, 'extra.sh', '#!/usr/bin/env bash\necho "extra context"\nexit 0\n')
      makeExecutable(path.join(tmpDir, 'extra.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SubagentStart',
          tasks: [
            { name: 'extra-context', type: 'script', command: './extra.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-combined',
        agent_type: 'Plan'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      const ctx = result.output.hookSpecificOutput.additionalContext
      assert.ok(ctx.includes('extra.sh passed'), `Should include script output, got: ${ctx}`)
      assert.ok(ctx.includes('prove_it signal done'), `Should include signal instruction, got: ${ctx}`)
    })
  })

  describe('failed tasks are non-blocking', () => {
    it('emits failure as context, not Stop schema', () => {
      createFile(tmpDir, 'fail.sh', '#!/usr/bin/env bash\necho "something broke" >&2\nexit 1\n')
      makeExecutable(path.join(tmpDir, 'fail.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SubagentStart',
          tasks: [
            { name: 'fail-check', type: 'script', command: './fail.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-fail',
        agent_type: 'Explore'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      // Must use SubagentStart schema (hookSpecificOutput), not Stop schema (decision)
      assert.ok(result.output.hookSpecificOutput, 'Should use hookSpecificOutput, not Stop schema')
      assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'SubagentStart')
      assert.ok(result.output.hookSpecificOutput.additionalContext.includes('failed'),
        `additionalContext should mention failure, got: ${result.output.hookSpecificOutput.additionalContext}`)
      assert.strictEqual(result.output.decision, undefined, 'Should NOT have Stop-style decision field')
    })
  })

  describe('error paths use correct schema', () => {
    it('config validation error emits SubagentStart schema, not Stop schema', () => {
      // Write a config that parses but fails validation (unknown key triggers error)
      writeConfig(tmpDir, { enabled: true, hooks: [], bogusKey: true })

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-bad-config',
        agent_type: 'Plan'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, `Should produce JSON output. stdout: ${result.stdout}, stderr: ${result.stderr}`)
      assert.ok(result.output.hookSpecificOutput, 'Should use hookSpecificOutput, not Stop schema')
      assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'SubagentStart')
      assert.ok(result.output.hookSpecificOutput.additionalContext.includes('invalid config'),
        `Should mention invalid config, got: ${result.output.hookSpecificOutput.additionalContext}`)
      assert.strictEqual(result.output.decision, undefined, 'Should NOT have Stop-style decision field')
    })
  })

  describe('exits cleanly with no config', () => {
    it('exits silently when no hooks match and no Plan agent', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:SubagentStart', {
        hook_event_name: 'SubagentStart',
        session_id: 'test-subagent-empty',
        agent_type: 'Explore'
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output')
    })
  })
})
