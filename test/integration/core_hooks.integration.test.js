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
          tasks: [
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
      assert.ok(result.output.systemMessage,
        'blocked Stop should include systemMessage for user visibility')
      assert.ok(result.output.systemMessage.includes('fast-tests failed'),
        `systemMessage should mention failure, got: ${result.output.systemMessage}`)
    })

    it('approves when fast tests pass', () => {
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
        session_id: 'test-stop-pass',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'approve',
        'Stop must approve when tests pass')
      assert.strictEqual(result.output.systemMessage, undefined,
        'approved Stop should not include systemMessage')
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
          tasks: [
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
      assert.ok(result.output.systemMessage,
        'denied PreToolUse should include systemMessage for user visibility')
    })

    it('allows commit when tests pass', () => {
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
      assert.strictEqual(result.output.systemMessage, undefined,
        'allowed PreToolUse should not include systemMessage')
    })

    it('ignores non-matching Bash commands', () => {
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
        tool_input: { command: 'git status' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      // Should exit silently (no matching hook entry)
      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output for non-matching commands')
    })
  })

  describe('SessionStart hook', () => {
    it('emits structured JSON output', () => {
      createFile(tmpDir, 'hello_check.sh', '#!/usr/bin/env bash\necho "hello from session start"\nexit 0\n')
      const fs = require('fs')
      const path = require('path')
      fs.chmodSync(path.join(tmpDir, 'hello_check.sh'), 0o755)

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'hello-check', type: 'script', command: './hello_check.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-session',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'SessionStart should emit JSON')
      assert.ok(result.output.additionalContext.includes('hello_check.sh passed'),
        'Should include check result in additionalContext')
    })

    it('does not block on failing check — collects output instead', () => {
      createFile(tmpDir, 'fail_check.sh', '#!/usr/bin/env bash\necho "startup failure" >&2\nexit 1\n')
      createFile(tmpDir, 'pass_check.sh', '#!/usr/bin/env bash\necho "session started ok"\nexit 0\n')
      const fs = require('fs')
      const path = require('path')
      fs.chmodSync(path.join(tmpDir, 'fail_check.sh'), 0o755)
      fs.chmodSync(path.join(tmpDir, 'pass_check.sh'), 0o755)

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'fail-check', type: 'script', command: './fail_check.sh' },
            { name: 'pass-check', type: 'script', command: './pass_check.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-session-fail',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      // SessionStart never blocks — exit 0
      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'SessionStart should emit JSON')
      // Should include the passing check's output in additionalContext
      assert.ok(result.output.additionalContext.includes('pass_check.sh passed'),
        'Should include passing checks in additionalContext')
      // Should include failing check's reason in both channels
      assert.ok(result.output.additionalContext.includes('failed'),
        `additionalContext should include failure, got: ${result.output.additionalContext}`)
      assert.ok(result.output.systemMessage.includes('failed'),
        `systemMessage should include failure, got: ${result.output.systemMessage}`)
    })
  })

  describe('git hook CLAUDECODE guard', () => {
    it('exits 0 immediately when CLAUDECODE is absent', () => {
      createTestScript(tmpDir, false) // would fail if checks ran
      writeConfig(tmpDir, makeConfig([
        {
          type: 'git',
          event: 'pre-commit',
          tasks: [
            { name: 'full-tests', type: 'script', command: './script/test' }
          ]
        }
      ]))

      const result = invokeHook('git:pre-commit', {}, {
        projectDir: tmpDir,
        cwd: tmpDir,
        cleanEnv: true,
        env: { PATH: process.env.PATH, ...isolatedEnv(tmpDir) }
      })

      assert.strictEqual(result.exitCode, 0,
        'Git hook should exit 0 when CLAUDECODE is absent')
    })

    it('runs checks when CLAUDECODE is set', () => {
      createTestScript(tmpDir, false)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'git',
          event: 'pre-commit',
          tasks: [
            { name: 'full-tests', type: 'script', command: './script/test' }
          ]
        }
      ]))

      const result = invokeHook('git:pre-commit', {}, {
        projectDir: tmpDir,
        cwd: tmpDir,
        cleanEnv: true,
        env: { PATH: process.env.PATH, ...isolatedEnv(tmpDir), CLAUDECODE: '1' }
      })

      assert.strictEqual(result.exitCode, 1,
        'Git hook should exit 1 when CLAUDECODE is set and checks fail')
      assert.ok(result.stderr.includes('full-tests'),
        `Stderr should mention failing check, got: ${result.stderr}`)
    })

    it('exits 0 when CLAUDECODE is set and checks pass', () => {
      createTestScript(tmpDir, true)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'git',
          event: 'pre-commit',
          tasks: [
            { name: 'full-tests', type: 'script', command: './script/test' }
          ]
        }
      ]))

      const result = invokeHook('git:pre-commit', {}, {
        projectDir: tmpDir,
        cwd: tmpDir,
        cleanEnv: true,
        env: { PATH: process.env.PATH, ...isolatedEnv(tmpDir), CLAUDECODE: '1' }
      })

      assert.strictEqual(result.exitCode, 0,
        'Git hook should exit 0 when CLAUDECODE is set and checks pass')
      assert.ok(result.stderr.includes('all checks passed'),
        `Stderr should confirm pass, got: ${result.stderr}`)
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
          tasks: [
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
          tasks: [
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
