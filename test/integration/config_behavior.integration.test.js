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
  makeExecutable,
  initBeads
} = require('./hook-harness')

/**
 * Config-driven hook behaviors.
 *
 * Covers GAPs 2-9 and 13: test fallbacks, custom commands, hook enable/disable,
 * configurable triggers, env disable, non-git passthrough, ignoredPaths,
 * beads.enabled, and .local.json overrides.
 */

describe('Config-driven hook behavior', () => {
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

  function isolatedEnv (extra) {
    return {
      HOME: tmpDir,
      PROVE_IT_DIR: path.join(tmpDir, '.prove_it_test'),
      ...extra
    }
  }

  // ──── GAP 2: Stop fallback test_fast → test ────

  describe('Stop fallback test_fast → test', () => {
    it('runs script/test when test_fast absent', () => {
      // Only create script/test (no test_fast)
      createTestScript(tmpDir, true)

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: 'test-fallback-pass',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'approve',
        'Stop should approve when script/test passes as fallback')
    })

    it('blocks via script/test fallback when tests fail', () => {
      createTestScript(tmpDir, false)

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: 'test-fallback-fail',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'block',
        'Stop should block when script/test fallback fails')
    })
  })

  // ──── GAP 3: Custom test commands via config ────

  describe('Custom test commands via config', () => {
    it('done hook uses commands.test.full from config', () => {
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        commands: { test: { full: './script/custom_test' } }
      }))
      createFile(tmpDir, 'script/custom_test', '#!/bin/bash\nexit 0\n')
      makeExecutable(path.join(tmpDir, 'script', 'custom_test'))

      const result = invokeHook('prove_it_done.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      const reason = result.output.hookSpecificOutput.permissionDecisionReason
      assert.ok(reason.includes('custom_test'),
        `Reason should mention custom_test, got: ${reason}`)
    })

    it('stop hook uses commands.test.fast from config', () => {
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        commands: { test: { fast: './script/custom_fast' } }
      }))
      createFile(tmpDir, 'script/custom_fast', '#!/bin/bash\nexit 0\n')
      makeExecutable(path.join(tmpDir, 'script', 'custom_fast'))

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: 'test-custom-fast',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'approve',
        'Stop should approve when custom fast tests pass')
    })
  })

  // ──── GAP 4: Hook disable via config ────

  describe('Hook disable via config', () => {
    it('stop hook no-ops when hooks.stop.enabled is false', () => {
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        hooks: { stop: { enabled: false } }
      }))
      createTestScript(tmpDir, true)

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: 'test-disable-stop',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Stop hook should exit silently when disabled')
    })

    it('done hook no-ops when hooks.done.enabled is false', () => {
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        hooks: { done: { enabled: false } }
      }))
      createTestScript(tmpDir, true)

      const result = invokeHook('prove_it_done.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Done hook should exit silently when disabled')
    })
  })

  // ──── GAP 5: Configurable triggers ────

  describe('Configurable triggers', () => {
    it('done hook triggers on git push when configured', () => {
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        hooks: {
          done: {
            enabled: true,
            triggers: [
              '(^|\\s)git\\s+commit\\b',
              '(^|\\s)git\\s+push\\b'
            ]
          }
        }
      }))
      createTestScript(tmpDir, true)

      const result = invokeHook('prove_it_done.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce output for git push trigger')
      const reason = result.output.hookSpecificOutput.permissionDecisionReason
      assert.ok(reason.includes('tests passed'),
        `Reason should mention tests passed, got: ${reason}`)
    })
  })

  // ──── GAP 6: PROVE_IT_DISABLED env var ────

  describe('PROVE_IT_DISABLED env var', () => {
    it('stop hook exits silently when PROVE_IT_DISABLED=1', () => {
      createTestScript(tmpDir, false) // Would block if not disabled

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: 'test-disabled',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv({ PROVE_IT_DISABLED: '1' }) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Stop hook should exit silently when PROVE_IT_DISABLED=1')
    })

    it('done hook exits silently when PROVE_IT_DISABLED=1', () => {
      createTestScript(tmpDir, false)

      const result = invokeHook('prove_it_done.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv({ PROVE_IT_DISABLED: '1' }) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Done hook should exit silently when PROVE_IT_DISABLED=1')
    })

    it('edit hook exits silently when PROVE_IT_DISABLED=1', () => {
      initBeads(tmpDir)

      const result = invokeHook('prove_it_edit.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src/app.js') },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv({ PROVE_IT_DISABLED: '1' }) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Edit hook should exit silently when PROVE_IT_DISABLED=1')
    })
  })

  // ──── GAP 7: Non-git directory passthrough ────

  describe('Non-git directory passthrough', () => {
    let nonGitDir

    beforeEach(() => {
      nonGitDir = createTempDir('prove_it_nongit_')
    })

    afterEach(() => {
      if (nonGitDir) cleanupTempDir(nonGitDir)
    })

    it('stop hook exits silently in non-git directory', () => {
      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: 'test-nongit',
        cwd: nonGitDir
      }, { projectDir: nonGitDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Stop hook should exit silently in non-git directory')
    })

    it('done hook exits silently in non-git directory', () => {
      const result = invokeHook('prove_it_done.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: nonGitDir
      }, { projectDir: nonGitDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Done hook should exit silently in non-git directory')
    })

    it('edit hook exits silently in non-git directory', () => {
      const result = invokeHook('prove_it_edit.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(nonGitDir, 'src/app.js') },
        cwd: nonGitDir
      }, { projectDir: nonGitDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Edit hook should exit silently in non-git directory')
    })
  })

  // ──── GAP 8: ignoredPaths ────

  describe('ignoredPaths', () => {
    it('stop hook exits silently when project is in ignoredPaths', () => {
      createTestScript(tmpDir, false) // Would block if not ignored

      // Write global config with this tmpDir in ignoredPaths
      const proveItDir = path.join(tmpDir, '.prove_it_test')
      fs.mkdirSync(proveItDir, { recursive: true })
      fs.writeFileSync(path.join(proveItDir, 'config.json'),
        JSON.stringify({ ignoredPaths: [tmpDir] }), 'utf8')

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: 'test-ignored',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Stop hook should exit silently when project is in ignoredPaths')
    })

    it('done hook exits silently when project is in ignoredPaths', () => {
      createTestScript(tmpDir, false)

      const proveItDir = path.join(tmpDir, '.prove_it_test')
      fs.mkdirSync(proveItDir, { recursive: true })
      fs.writeFileSync(path.join(proveItDir, 'config.json'),
        JSON.stringify({ ignoredPaths: [tmpDir] }), 'utf8')

      const result = invokeHook('prove_it_done.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Done hook should exit silently when project is in ignoredPaths')
    })
  })

  // ──── GAP 9: beads.enabled: false ────

  describe('beads.enabled: false', () => {
    it('edit hook allows Edit when beads.enabled is false', () => {
      initBeads(tmpDir)
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        beads: { enabled: false }
      }))

      const result = invokeHook('prove_it_edit.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src/app.js') },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Edit hook should exit silently when beads.enabled is false')
    })
  })

  // ──── GAP 13: .local.json overrides ────

  describe('.local.json overrides', () => {
    it('local.json overrides project config to disable stop hook', () => {
      // Project config: stop enabled
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        hooks: { stop: { enabled: true } }
      }))
      // Local override: stop disabled
      createFile(tmpDir, '.claude/prove_it.local.json', JSON.stringify({
        hooks: { stop: { enabled: false } }
      }))
      createTestScript(tmpDir, false) // Would block if not disabled

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: 'test-local-override',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null,
        'Stop hook should respect local.json override to disable')
    })
  })
})
