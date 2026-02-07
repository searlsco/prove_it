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
  isolatedEnv
} = require('./hook-harness')

describe('v2 dispatcher: core hook behaviors', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_core_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  describe('Stop hook', () => {
    it('blocks when fast tests fail', () => {
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
        session_id: 'test-stop-fail',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'block',
        'Stop must block when fast tests fail')
      assert.ok(result.output.reason.includes('fast-tests failed'),
        `Reason should mention failure, got: ${result.output.reason}`)
    })

    it('approves when fast tests pass', () => {
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
        session_id: 'test-stop-pass',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'approve',
        'Stop must approve when tests pass')
    })
  })

  describe('Pre-commit hook (PreToolUse)', () => {
    it('blocks commit when tests fail', () => {
      createTestScript(tmpDir, false)
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
        tool_input: { command: 'git commit -m "ship it"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'deny',
        'Must deny when tests fail'
      )
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('full-tests failed'),
        'Reason should mention test failure'
      )
    })

    it('allows commit when tests pass', () => {
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
        tool_input: { command: 'git commit -m "ship it"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'allow',
        'Must allow when tests pass'
      )
    })

    it('ignores non-matching Bash commands', () => {
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
        tool_input: { command: 'git status' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      // Should exit silently (no matching hook entry)
      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output for non-matching commands')
    })
  })

  describe('SessionStart hook', () => {
    it('emits text output', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          checks: [
            { name: 'beads-reminder', type: 'script', command: 'prove_it builtin:beads-reminder' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-session',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.stdout.includes('prove_it active'),
        'Should include reminder text in stdout')
    })

    it('does not block on failing check — collects output instead', () => {
      createFile(tmpDir, 'fail_check.sh', '#!/bin/bash\necho "startup failure" >&2\nexit 1\n')
      const fs = require('fs')
      const path = require('path')
      fs.chmodSync(path.join(tmpDir, 'fail_check.sh'), 0o755)

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          checks: [
            { name: 'fail-check', type: 'script', command: './fail_check.sh' },
            { name: 'beads-reminder', type: 'script', command: 'prove_it builtin:beads-reminder' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-session-fail',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      // SessionStart never blocks — exit 0, no JSON decision output
      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'SessionStart should not emit JSON')
      // Should still include the passing check's output
      assert.ok(result.stdout.includes('prove_it active'),
        'Should still emit passing checks output')
      // Should include failing check's reason too
      assert.ok(result.stdout.includes('failed'),
        `Should include failure reason, got: ${result.stdout}`)
    })
  })

  describe('disabled hooks', () => {
    it('exits silently when enabled: false', () => {
      writeConfig(tmpDir, makeConfig([], { enabled: false }))

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-disabled',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null)
    })

    it('exits silently when PROVE_IT_DISABLED is set', () => {
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
        session_id: 'test-env-disabled',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), PROVE_IT_DISABLED: '1' } })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null)
    })
  })

  describe('non-git directory', () => {
    it('runs hooks in non-git directory when config exists', () => {
      const nonGitDir = createTempDir('prove_it_nongit_')
      createFastTestScript(nonGitDir, true)
      writeConfig(nonGitDir, makeConfig([
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
        session_id: 'test-nongit',
        cwd: nonGitDir
      }, { projectDir: nonGitDir, env: isolatedEnv(nonGitDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce output when config exists in non-git dir')
      assert.strictEqual(result.output.decision, 'approve')
      cleanupTempDir(nonGitDir)
    })
  })
})
