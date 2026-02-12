const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

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

/**
 * Config-driven hook behaviors for the v2 dispatcher.
 *
 * Covers: custom test commands, hook disable via config, PROVE_IT_DISABLED
 * env var, non-git passthrough, ignoredPaths, and .local.json overrides.
 */

describe('Config-driven hook behavior (v2)', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_cfg_')
    initGitRepo(tmpDir)

    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  // ──── Custom test commands via config ────

  describe('Custom test commands via config', () => {
    it('commit gate uses custom test command', () => {
      createFile(tmpDir, 'script/custom_test', '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'custom_test'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          triggers: ['(^|\\s)git\\s+commit\\b'],
          tasks: [
            { name: 'custom-tests', type: 'script', command: './script/custom_test' }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'allow',
        'Should allow when custom test command passes'
      )
    })

    it('stop hook uses custom fast test command', () => {
      createFile(tmpDir, 'script/custom_fast', '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'custom_fast'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'custom-fast', type: 'script', command: './script/custom_fast' }
          ]
        }
      ]))

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-custom-fast',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'approve',
        'Stop should approve when custom fast tests pass')
    })
  })

  // ──── Hook disable via config ────

  describe('Hook disable via config', () => {
    it('exits silently when enabled: false', () => {
      writeConfig(tmpDir, makeConfig([], { enabled: false }))
      createTestScript(tmpDir, true)

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-disabled',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Stop hook should exit silently when disabled')
    })

    it('exit silently for PreToolUse when no matching hooks', () => {
      // Config has Stop hooks but no PreToolUse hooks
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'fast-tests', type: 'script', command: './script/test_fast' }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Should exit silently when no matching hook entries')
    })
  })

  // ──── PROVE_IT_DISABLED env var ────

  describe('PROVE_IT_DISABLED env var', () => {
    it('stop hook exits silently when PROVE_IT_DISABLED=1', () => {
      createFastTestScript(tmpDir, false) // Would block if not disabled
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
      assert.strictEqual(result.output, null,
        'Stop hook should exit silently when PROVE_IT_DISABLED=1')
    })

    it('PreToolUse exits silently when PROVE_IT_DISABLED=1', () => {
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
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), PROVE_IT_DISABLED: '1' } })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'PreToolUse should exit silently when PROVE_IT_DISABLED=1')
    })
  })

  // ──── Non-git directory with config ────

  describe('Non-git directory with config', () => {
    let nonGitDir

    beforeEach(() => {
      nonGitDir = createTempDir('prove_it_nongit_')
    })

    afterEach(() => {
      if (nonGitDir) cleanupTempDir(nonGitDir)
    })

    it('stop hook runs checks in non-git directory', () => {
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
      assert.ok(result.output, 'Stop hook should produce output in non-git directory with config')
      assert.strictEqual(result.output.decision, 'approve')
    })

    it('PreToolUse runs checks in non-git directory', () => {
      createTestScript(nonGitDir, true)
      writeConfig(nonGitDir, makeConfig([
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
        cwd: nonGitDir
      }, { projectDir: nonGitDir, env: isolatedEnv(nonGitDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'PreToolUse should produce output in non-git directory with config')
    })
  })

  // ──── ignoredPaths ────

  describe('ignoredPaths', () => {
    it('exits silently when project is in ignoredPaths', () => {
      createFastTestScript(tmpDir, false) // Would block if not ignored
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'fast-tests', type: 'script', command: './script/test_fast' }
          ]
        }
      ]))

      // Write global config with this tmpDir in ignoredPaths
      const proveItDir = path.join(tmpDir, '.prove_it_test')
      fs.mkdirSync(proveItDir, { recursive: true })
      fs.writeFileSync(path.join(proveItDir, 'config.json'),
        JSON.stringify({ ignoredPaths: [tmpDir] }), 'utf8')

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-ignored',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Stop hook should exit silently when project is in ignoredPaths')
    })
  })

  // ──── .local.json overrides ────

  describe('.local.json overrides', () => {
    it('local.json overrides project config to disable', () => {
      // Project config has a hook entry
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'fast-tests', type: 'script', command: './script/test_fast' }
          ]
        }
      ]))
      // Local override: disabled entirely
      createFile(tmpDir, '.claude/prove_it.local.json', JSON.stringify({
        enabled: false
      }))
      createFastTestScript(tmpDir, false) // Would block if not disabled

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-local-override',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Stop hook should respect local.json override to disable')
    })
  })

  // ──── when conditions ────

  describe('when conditions', () => {
    it('skips check when fileExists condition is not met', () => {
      // Task has when: { fileExists: '.missing' } — directory does not exist
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          tasks: [
            {
              name: 'conditional-check',
              type: 'script',
              command: 'prove_it run_builtin config:lock',
              when: { fileExists: '.missing' }
            }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src/app.js') },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      // No checks matched (when condition skipped the only check) → silent exit
      // because the matching hook entry's checks all got skipped
      if (result.output) {
        assert.notStrictEqual(
          result.output.hookSpecificOutput?.permissionDecision,
          'deny',
          'Should not deny when fileExists condition is not met'
        )
      }
    })
  })
})
