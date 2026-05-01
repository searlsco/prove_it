const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  makeExecutable,
  createFastTestScript,
  writeConfig,
  makeConfig,
  assertValidPermissionDecision,
  isolatedEnv
} = require('./hook-harness')
const { setSignal, getSignal } = require('../../lib/session')

/**
 * Characterization coverage for the current Claude enforcement behavior.
 *
 * These tests intentionally describe the pre-redesign external contract so a
 * later extraction can keep config guarding, Stop blocking, signal state,
 * backchannels, SessionStart injection, and signal-command interception stable.
 */
describe('Claude enforcement characterization', () => {
  let tmpDir, projectDir, resolvedProjectDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_claude_enforcement_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)
    resolvedProjectDir = fs.realpathSync(projectDir)
    env = isolatedEnv(tmpDir)

    // Session helpers in this process must read/write the same state directory
    // as the CLI subprocesses invoked through invokeHook().
    origProveItDir = process.env.PROVE_IT_DIR
    origHome = process.env.HOME
    process.env.PROVE_IT_DIR = env.PROVE_IT_DIR
    process.env.HOME = env.HOME
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    cleanupTempDir(tmpDir)
  })

  function guardTask () {
    return {
      name: 'guard-config',
      matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
      type: 'script',
      command: '$(prove_it prefix)/libexec/guard-config'
    }
  }

  function stopScript (name, body) {
    createFile(projectDir, `script/${name}`, `#!/usr/bin/env bash\n${body}\n`)
    makeExecutable(path.join(projectDir, 'script', name))
    return `./script/${name}`
  }

  it('denies Claude PreToolUse edits to protected prove_it config files', () => {
    writeConfig(projectDir, makeConfig({
      claude: { PreToolUse: [guardTask()] }
    }))

    const attempts = [
      {
        label: 'Edit config.json',
        input: {
          tool_name: 'Edit',
          tool_input: {
            file_path: path.join(projectDir, '.claude', 'prove_it', 'config.json'),
            old_string: '{}',
            new_string: '{"enabled":false}'
          }
        }
      },
      {
        label: 'Write config.local.json',
        input: {
          tool_name: 'Write',
          tool_input: {
            file_path: '.claude/prove_it/config.local.json',
            content: '{"enabled":false}'
          }
        }
      },
      {
        label: 'Bash redirect to config.json',
        input: {
          tool_name: 'Bash',
          tool_input: { command: 'echo "{}" > .claude/prove_it/config.json' }
        }
      }
    ]

    for (const attempt of attempts) {
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: `guard-${attempt.label.replace(/\W+/g, '-')}`,
        cwd: projectDir,
        ...attempt.input
      }, { projectDir, env, cwd: projectDir })

      assert.strictEqual(result.exitCode, 0, attempt.label)
      assert.ok(result.output, `${attempt.label}: expected Claude hook JSON`)
      assertValidPermissionDecision(result, attempt.label)
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'deny',
        `${attempt.label}: protected config write must be denied`
      )
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('Cannot modify prove_it config files'),
        `${attempt.label}: denial should explain protected prove_it config files`
      )
    }
  })

  it('blocks Stop when a done-gated task fails and preserves the done signal', () => {
    const sessionId = 'done-gated-fails'
    setSignal(sessionId, 'done', 'ready for final checks')
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          {
            name: 'done-gated-check',
            type: 'script',
            command: stopScript('done-check-fails', 'echo "done gate failed" >&2\nexit 1'),
            when: { signal: 'done' }
          }
        ]
      }
    }))

    const result = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: projectDir
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Stop should produce a blocking response')
    assert.strictEqual(result.output.decision, 'block')
    assert.ok(result.output.reason.includes('done-gated-check failed'),
      `Stop reason should name failed done-gated task, got: ${result.output.reason}`)
    assert.ok(result.output.reason.includes('done gate failed'),
      `Stop reason should include task output, got: ${result.output.reason}`)

    const signal = getSignal(sessionId)
    assert.notStrictEqual(signal, null, 'done signal should persist after failed Stop')
    assert.strictEqual(signal.type, 'done')
  })

  it('clears the done signal after a successful done-gated Stop', () => {
    const sessionId = 'done-gated-passes'
    setSignal(sessionId, 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          {
            name: 'done-gated-check',
            type: 'script',
            command: stopScript('done-check-passes', 'echo "done gate passed"\nexit 0'),
            when: { signal: 'done' }
          }
        ]
      }
    }))

    const result = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: projectDir
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Stop should produce an approval response')
    assert.strictEqual(result.output.decision, 'approve')
    assert.strictEqual(getSignal(sessionId), null, 'done signal should clear after successful Stop')
  })

  it('allows backchannel writes before matching PreToolUse tasks can deny', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, makeConfig({
      claude: {
        PreToolUse: [
          { name: 'always-fail', type: 'script', command: './script/test_fast' }
        ]
      }
    }))

    const normalWrite = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'backchannel-normal-write',
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(resolvedProjectDir, 'src', 'app.js'),
        content: 'module.exports = {}\n'
      }
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(normalWrite.exitCode, 0)
    assert.strictEqual(normalWrite.output.hookSpecificOutput.permissionDecision, 'deny',
      'outside the backchannel, the failing task should deny Write')

    const sessionId = 'backchannel-bypass'
    const backchannelPath = path.join(
      resolvedProjectDir,
      '.claude',
      'prove_it',
      'sessions',
      sessionId,
      'backchannel',
      'always-fail',
      'README.md'
    )

    const bypass = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: backchannelPath, content: 'Appeal text\n' }
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(bypass.exitCode, 0)
    assertValidPermissionDecision(bypass, 'backchannel Write')
    assert.strictEqual(bypass.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('injects SessionStart additional context and exported env vars on startup', () => {
    const envFile = path.join(tmpDir, '.claude-env')
    createFile(projectDir, 'context.sh', '#!/usr/bin/env bash\necho "session orientation context"\n')
    makeExecutable(path.join(projectDir, 'context.sh'))
    createFile(projectDir, 'env.sh', '#!/usr/bin/env bash\necho "API_TOKEN=abc123"\n')
    makeExecutable(path.join(projectDir, 'env.sh'))
    writeConfig(projectDir, makeConfig({
      claude: {
        SessionStart: [
          { name: 'orientation', type: 'script', command: './context.sh' },
          { name: 'env-injection', type: 'env', command: './env.sh' }
        ]
      }
    }))

    const result = invokeHook('claude:SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: 'sessionstart-injection',
      source: 'startup',
      cwd: projectDir
    }, { projectDir, env: { ...env, CLAUDE_ENV_FILE: envFile }, cwd: projectDir })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'SessionStart should emit Claude hook JSON')
    const context = result.output.hookSpecificOutput?.additionalContext || ''
    assert.ok(context.includes('session orientation context'),
      `additionalContext should include script output, got: ${context}`)
    assert.ok(context.includes('prove_it: set env vars:'),
      `additionalContext should report env injection, got: ${context}`)
    assert.ok(context.includes('API_TOKEN'),
      `additionalContext should list task env var names, got: ${context}`)
    assert.ok(context.includes('PROVE_IT_SESSION_ID'),
      `additionalContext should list session env var, got: ${context}`)

    assert.ok(fs.existsSync(envFile), 'CLAUDE_ENV_FILE should be written')
    const envContent = fs.readFileSync(envFile, 'utf8')
    assert.ok(envContent.includes('export API_TOKEN=abc123'),
      `task env var should be exported, got: ${envContent}`)
    assert.ok(envContent.includes('export PROVE_IT_SESSION_ID=sessionstart-injection'),
      `session id should be exported, got: ${envContent}`)
  })

  it('intercepts Bash prove_it signal commands before user tasks run', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, makeConfig({
      claude: {
        PreToolUse: [
          { name: 'bash-would-fail', matcher: 'Bash', type: 'script', command: './script/test_fast' }
        ],
        Stop: []
      }
    }))

    const sessionId = 'bash-signal-intercept'
    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'prove_it signal done --message "ready to stop"' },
      cwd: projectDir
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'signal interception should emit Claude hook JSON')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, undefined,
      'intercepted signal command should not deny even though a matching Bash task would fail')
    const context = result.output.hookSpecificOutput.additionalContext || ''
    assert.ok(context.includes('signal "done" recorded'),
      `additionalContext should confirm interception, got: ${context}`)

    const signal = getSignal(sessionId)
    assert.notStrictEqual(signal, null, 'signal should be persisted')
    assert.strictEqual(signal.type, 'done')
    assert.strictEqual(signal.message, 'ready to stop')
  })
})
