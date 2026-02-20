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
      createFile(tmpDir, '.claude/prove_it/config.local.json', JSON.stringify({
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

    it('skips task with enabled: false and logs SKIP with Disabled reason', () => {
      const sessionId = 'test-enabled-false-skip'
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'disabled-check',
              type: 'script',
              command: 'exit 1',
              enabled: false
            }
          ]
        }
      ]))

      const env = isolatedEnv(tmpDir)
      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      // Disabled task should not block — silent exit or pass
      assert.strictEqual(result.exitCode, 0)
      if (result.output) {
        assert.notStrictEqual(result.output.decision, 'block',
          'Disabled task should not block')
      }

      // Verify SKIP log entry with "Disabled" reason
      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      assert.ok(fs.existsSync(logPath), `Session log should exist at ${logPath}`)
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const skipEntry = entries.find(e => e.reviewer === 'disabled-check' && e.status === 'SKIP')
      assert.ok(skipEntry, 'Should have a SKIP log entry for the disabled task')
      assert.strictEqual(skipEntry.reason, 'Disabled',
        `SKIP reason should be 'Disabled', got: ${skipEntry.reason}`)
    })

    it('runs task with enabled: true', () => {
      createFastTestScript(tmpDir, false)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'enabled-check',
              type: 'script',
              command: './script/test_fast',
              enabled: true
            }
          ]
        }
      ]))

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-enabled-true-runs',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Task with enabled: true should execute')
      assert.strictEqual(result.output.decision, 'block',
        'Failing task with enabled: true should block')
    })

    it('logs SKIP entry when when condition is not met', () => {
      const sessionId = 'test-when-skip-log'
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'guarded-check',
              type: 'script',
              command: 'prove_it run_builtin config:lock',
              when: { fileExists: '.nonexistent' }
            }
          ]
        }
      ]))

      const env = isolatedEnv(tmpDir)
      invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      // Read the session log and verify SKIP was recorded
      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      assert.ok(fs.existsSync(logPath), `Session log should exist at ${logPath}`)
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const skipEntry = entries.find(e => e.reviewer === 'guarded-check' && e.status === 'SKIP')
      assert.ok(skipEntry, 'Should have a SKIP log entry for the guarded check')
      assert.ok(skipEntry.reason.includes('was not found'),
        `SKIP reason should mention 'was not found', got: ${skipEntry.reason}`)
    })

    it('logs SKIP for variablesPresent when variable is empty', () => {
      const sessionId = 'test-when-vp-skip'
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'needs-diff',
              type: 'script',
              command: 'prove_it run_builtin config:lock',
              when: { variablesPresent: ['staged_diff'] }
            }
          ]
        }
      ]))

      const env = isolatedEnv(tmpDir)
      invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      assert.ok(fs.existsSync(logPath), `Session log should exist at ${logPath}`)
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const skipEntry = entries.find(e => e.reviewer === 'needs-diff' && e.status === 'SKIP')
      assert.ok(skipEntry, 'Should have a SKIP log entry when variablesPresent fails')
      assert.ok(skipEntry.reason.includes('staged_diff'),
        `SKIP reason should name the empty variable, got: ${skipEntry.reason}`)
      assert.ok(skipEntry.reason.includes('was not present'),
        `SKIP reason should say 'was not present', got: ${skipEntry.reason}`)
    })
  })

  // ──── top-level env ────

  describe('top-level taskEnv config', () => {
    it('script task sees config taskEnv vars', () => {
      createFile(tmpDir, 'script/env_check', [
        '#!/usr/bin/env bash',
        'if [ "$TURBOCOMMIT_DISABLED" = "1" ]; then',
        '  exit 0',
        'else',
        '  echo "TURBOCOMMIT_DISABLED was not set" >&2',
        '  exit 1',
        'fi'
      ].join('\n'))
      fs.chmodSync(path.join(tmpDir, 'script', 'env_check'), 0o755)

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'env-check', type: 'script', command: './script/env_check' }
          ]
        }
      ], { taskEnv: { TURBOCOMMIT_DISABLED: '1' } }))

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-config-env',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'approve',
        'Script should pass when config taskEnv var is present')
    })

    it('script task fails without config taskEnv var', () => {
      createFile(tmpDir, 'script/env_check', [
        '#!/usr/bin/env bash',
        'if [ "$TURBOCOMMIT_DISABLED" = "1" ]; then',
        '  exit 0',
        'else',
        '  echo "TURBOCOMMIT_DISABLED was not set" >&2',
        '  exit 1',
        'fi'
      ].join('\n'))
      fs.chmodSync(path.join(tmpDir, 'script', 'env_check'), 0o755)

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'env-check', type: 'script', command: './script/env_check' }
          ]
        }
      ]))

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-config-env-absent',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'block',
        'Script should fail when config taskEnv var is absent')
    })

    it('empty taskEnv object does not break dispatch', () => {
      createFastTestScript(tmpDir, true)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'fast-tests', type: 'script', command: './script/test_fast' }
          ]
        }
      ], { taskEnv: {} }))

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-config-env-empty',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'approve')
    })
  })

  // ──── top-level model ────

  describe('top-level model config', () => {
    it('agent task uses top-level model when task has no model', () => {
      // Put a fake 'claude' shim that captures args on PATH
      const shimDir = path.join(tmpDir, 'shims')
      const capturePath = path.join(tmpDir, 'captured_args.txt')
      fs.mkdirSync(shimDir, { recursive: true })
      createFile(tmpDir, 'shims/claude', [
        '#!/usr/bin/env bash',
        `echo "$*" > "${capturePath}"`,
        'cat > /dev/null',
        'echo "PASS: ok"'
      ].join('\n'))
      fs.chmodSync(path.join(shimDir, 'claude'), 0o755)

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'model-test', type: 'agent', prompt: 'Review this' }
          ]
        }
      ], { model: 'custom-model' }))

      const env = isolatedEnv(tmpDir)
      env.PATH = `${shimDir}:${process.env.PATH}`

      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'test-top-level-model',
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce JSON output')
      assert.strictEqual(result.output.decision, 'approve')

      // Verify --model was passed through
      const capturedArgs = fs.readFileSync(capturePath, 'utf8')
      assert.ok(capturedArgs.includes('--model') && capturedArgs.includes('custom-model'),
        `Expected --model custom-model in reviewer args, got: ${capturedArgs}`)
    })
  })

  // ──── sourcesModifiedSinceLastRun ────

  describe('sourcesModifiedSinceLastRun', () => {
    it('fires on first run, skips on second when no files changed, fires after source touch', () => {
      const sessionId = 'test-smslr-integration'
      // Create a source file
      createFile(tmpDir, 'src/app.js', 'console.log("hello")\n')
      // A passing script task gated by sourcesModifiedSinceLastRun
      createFile(tmpDir, 'script/check', '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'check'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'mtime-gate',
              type: 'script',
              command: './script/check',
              when: { sourcesModifiedSinceLastRun: true }
            }
          ]
        }
      ], { sources: ['src/**/*.js'] }))

      const env = isolatedEnv(tmpDir)

      // First invocation: should fire (no prior run data)
      const result1 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result1.exitCode, 0)
      assert.ok(result1.output, 'First invocation should produce output (task ran)')
      assert.strictEqual(result1.output.decision, 'approve')

      // Second invocation: should skip (no source changes)
      const result2 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result2.exitCode, 0)
      // All tasks skipped → silent exit (no output) or pass output
      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      assert.ok(fs.existsSync(logPath), 'Session log should exist')
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const skipEntries = entries.filter(e => e.reviewer === 'mtime-gate' && e.status === 'SKIP')
      assert.ok(skipEntries.length >= 1, 'Should have a SKIP log entry on second invocation')
      assert.ok(skipEntries[0].reason.includes('no sources were modified'),
        `SKIP reason should mention no modifications, got: ${skipEntries[0].reason}`)

      // Touch a source file and invoke again: should fire
      // Ensure the mtime is strictly newer than what was recorded
      const now = Date.now()
      const srcPath = path.join(tmpDir, 'src', 'app.js')
      fs.utimesSync(srcPath, new Date(now + 2000), new Date(now + 2000))

      const result3 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result3.exitCode, 0)
      assert.ok(result3.output, 'Third invocation should produce output after source touch')
      assert.strictEqual(result3.output.decision, 'approve')
    })

    it('does not conflict with script mtime cache when task has mtime: true', () => {
      const sessionId = 'test-smslr-mtime-compat'
      createFile(tmpDir, 'src/app.js', 'code\n')
      createFile(tmpDir, 'script/check', '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'check'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'mtime-compat',
              type: 'script',
              command: './script/check',
              mtime: true,
              when: { sourcesModifiedSinceLastRun: true }
            }
          ]
        }
      ], { sources: ['src/**/*.js'] }))

      const env = isolatedEnv(tmpDir)

      // First run: should pass (script runs successfully)
      const result1 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result1.exitCode, 0)
      assert.ok(result1.output, 'First invocation should produce output')
      assert.strictEqual(result1.output.decision, 'approve')

      // Second run: should skip via sourcesModifiedSinceLastRun
      // (script.js wrote { at, pass: true } which satisfies both caches)
      const result2 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result2.exitCode, 0)
    })

    it('re-fires cached failure instead of silently skipping', () => {
      const sessionId = 'test-smslr-failure-sticky'
      createFile(tmpDir, 'src/app.js', 'code\n')
      createFile(tmpDir, 'script/check', '#!/usr/bin/env bash\nexit 1\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'check'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'fail-gate',
              type: 'script',
              command: './script/check',
              when: { sourcesModifiedSinceLastRun: true }
            }
          ]
        }
      ], { sources: ['src/**/*.js'] }))

      const env = isolatedEnv(tmpDir)

      // First run: task fails
      const result1 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result1.exitCode, 0)
      assert.ok(result1.output, 'First invocation should produce output')
      assert.strictEqual(result1.output.decision, 'block', 'Should block on failure')

      // Second run (no source changes): should re-fire with cached failure, NOT skip silently
      const result2 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result2.exitCode, 0)
      assert.ok(result2.output, 'Second invocation should still produce output (cached failure)')
      assert.strictEqual(result2.output.decision, 'block', 'Cached failure should still block')

      // Touch source and run again: should re-run the actual command (still fails)
      const now = Date.now()
      const srcPath = path.join(tmpDir, 'src', 'app.js')
      fs.utimesSync(srcPath, new Date(now + 2000), new Date(now + 2000))

      const result3 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result3.exitCode, 0)
      assert.ok(result3.output, 'Third invocation should produce output after source touch')
      assert.strictEqual(result3.output.decision, 'block', 'Should still block (script still fails)')
    })
  })

  // ──── sourceFilesEdited + toolsUsed when conditions ────

  describe('sourceFilesEdited when condition', () => {
    it('fires Stop after PreToolUse records source edits', () => {
      const sessionId = 'test-sfe-integration'
      createFile(tmpDir, 'src/app.js', 'console.log("hello")\n')
      createFile(tmpDir, 'script/check', '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'check'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          tasks: [
            { name: 'lock-config', type: 'script', command: 'true' }
          ]
        },
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'sfe-check',
              type: 'script',
              command: './script/check',
              when: { sourceFilesEdited: true }
            }
          ]
        }
      ], { sources: ['src/**/*.js'] }))

      const env = isolatedEnv(tmpDir)

      // Stop without prior PreToolUse → should skip (no edits)
      const result1 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result1.exitCode, 0)

      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      assert.ok(fs.existsSync(logPath), 'Session log should exist')
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const skipEntry = entries.find(e => e.reviewer === 'sfe-check' && e.status === 'SKIP')
      assert.ok(skipEntry, 'Should have SKIP entry when no edits recorded')

      // Now simulate PreToolUse for Edit on source file
      invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src', 'app.js'), old_string: 'a', new_string: 'b' },
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      // Stop should now fire
      const result2 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result2.exitCode, 0)
      assert.ok(result2.output, 'Stop should produce output after source edits')
      assert.strictEqual(result2.output.decision, 'approve')
    })

    it('cross-session isolation: session B does not see session A edits', () => {
      createFile(tmpDir, 'src/app.js', 'code\n')
      createFile(tmpDir, 'script/check', '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'check'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          tasks: []
        },
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'sfe-check',
              type: 'script',
              command: './script/check',
              when: { sourceFilesEdited: true }
            }
          ]
        }
      ], { sources: ['src/**/*.js'] }))

      const env = isolatedEnv(tmpDir)

      // Session A records edits
      invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src', 'app.js'), old_string: 'a', new_string: 'b' },
        session_id: 'session-A',
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      // Session B's Stop should skip (no edits in B)
      const result = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: 'session-B',
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result.exitCode, 0)
      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', 'session-B.jsonl')
      assert.ok(fs.existsSync(logPath), 'Session B log should exist')
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const skipEntry = entries.find(e => e.reviewer === 'sfe-check' && e.status === 'SKIP')
      assert.ok(skipEntry, 'Session B should skip because it has no edits')
    })

    it('turn reset: after successful Stop, next Stop skips unless new edits', () => {
      const sessionId = 'test-sfe-reset'
      createFile(tmpDir, 'src/app.js', 'code\n')
      createFile(tmpDir, 'script/check', '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'check'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          tasks: []
        },
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'sfe-check',
              type: 'script',
              command: './script/check',
              when: { sourceFilesEdited: true }
            }
          ]
        }
      ], { sources: ['src/**/*.js'] }))

      const env = isolatedEnv(tmpDir)

      // Record edit, then Stop
      invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src', 'app.js'), old_string: 'a', new_string: 'b' },
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      const result1 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result1.exitCode, 0)
      assert.ok(result1.output, 'First Stop should fire')
      assert.strictEqual(result1.output.decision, 'approve')

      // Second Stop without new edits → should skip
      const result2 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result2.exitCode, 0)
      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const skipEntries = entries.filter(e => e.reviewer === 'sfe-check' && e.status === 'SKIP')
      assert.ok(skipEntries.length >= 1, 'Second Stop should have SKIP entry after turn reset')
    })
  })

  describe('toolsUsed when condition', () => {
    it('fires Stop only when specified tool was used', () => {
      const sessionId = 'test-tu-integration'
      createFile(tmpDir, 'src/app.swift', 'code\n')
      createFile(tmpDir, 'script/check', '#!/usr/bin/env bash\nexit 0\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'check'), 0o755)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          tasks: []
        },
        {
          type: 'claude',
          event: 'Stop',
          tasks: [
            {
              name: 'xcode-only-check',
              type: 'script',
              command: './script/check',
              when: { toolsUsed: ['XcodeEdit'] }
            }
          ]
        }
      ], { sources: ['src/**/*.swift'], fileEditingTools: ['XcodeEdit'] }))

      const env = isolatedEnv(tmpDir)

      // Edit with Edit tool (not in toolsUsed list) → Stop should skip
      invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src', 'app.swift'), old_string: 'a', new_string: 'b' },
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      const result1 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result1.exitCode, 0)
      const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const skipEntry = entries.find(e => e.reviewer === 'xcode-only-check' && e.status === 'SKIP')
      assert.ok(skipEntry, 'Should skip when Edit was used but toolsUsed only has XcodeEdit')

      // Now use XcodeEdit → Stop should fire
      // First reset by simulating a successful stop (need fresh session for clean slate)
      const sessionId2 = 'test-tu-integration-2'
      invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'XcodeEdit',
        tool_input: { file_path: path.join(tmpDir, 'src', 'app.swift') },
        session_id: sessionId2,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })

      const result2 = invokeHook('claude:Stop', {
        hook_event_name: 'Stop',
        session_id: sessionId2,
        cwd: tmpDir
      }, { projectDir: tmpDir, env })
      assert.strictEqual(result2.exitCode, 0)
      assert.ok(result2.output, 'Stop should fire when XcodeEdit was used')
      assert.strictEqual(result2.output.decision, 'approve')
    })
  })
})
