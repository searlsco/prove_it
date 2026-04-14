const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
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

const {
  writeDisabledSentinel,
  readDisabledSentinel,
  clearDisabledSentinel
} = require('../../lib/session')

describe('disable integration', () => {
  let tmpDir
  let origProveItDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_disable_')
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, '.prove_it_test')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('PreToolUse exits silently when session is disabled', () => {
    // Config has a task that would otherwise fire and produce output
    createFile(tmpDir, 'noisy.sh', '#!/usr/bin/env bash\necho "should not run"\nexit 1\n')
    makeExecutable(path.join(tmpDir, 'noisy.sh'))
    writeConfig(tmpDir, makeConfig({
      claude: { PreToolUse: [{ name: 'noisy', type: 'script', command: './noisy.sh' }] }
    }))

    const env = isolatedEnv(tmpDir)
    const sessionId = 'disable-pretooluse'
    writeDisabledSentinel(sessionId)

    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.strictEqual(result.stdout.trim(), '',
      `Disabled session should produce no stdout, got: ${result.stdout}`)
  })

  it('Stop exits silently when session is disabled', () => {
    createFile(tmpDir, 'fail.sh', '#!/usr/bin/env bash\nexit 1\n')
    makeExecutable(path.join(tmpDir, 'fail.sh'))
    writeConfig(tmpDir, makeConfig({
      claude: { Stop: [{ name: 'fail', type: 'script', command: './fail.sh' }] }
    }))

    const env = isolatedEnv(tmpDir)
    const sessionId = 'disable-stop'
    writeDisabledSentinel(sessionId)

    const result = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: tmpDir
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.strictEqual(result.stdout.trim(), '',
      `Disabled session should produce no stdout, got: ${result.stdout}`)
  })

  it('SessionStart emits banner and injects PROVE_IT_SESSION_ID when disabled', () => {
    writeConfig(tmpDir, makeConfig({
      claude: { PreToolUse: [{ name: 'noop', type: 'script', command: 'true' }] }
    }))

    const env = isolatedEnv(tmpDir)
    const sessionId = 'disable-sessionstart'
    writeDisabledSentinel(sessionId)

    // CLAUDE_ENV_FILE is how the dispatcher injects env vars into the user's shell
    const envFilePath = path.join(tmpDir, '.claude-env')
    env.CLAUDE_ENV_FILE = envFilePath

    const result = invokeHook('claude:SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'resume',
      cwd: tmpDir
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.ok(result.output, 'Should produce JSON output')
    assert.ok(result.output.systemMessage, 'Should set systemMessage')
    assert.ok(result.output.systemMessage.includes('disabled'),
      `systemMessage should mention disabled, got: ${result.output.systemMessage}`)
    assert.ok(result.output.systemMessage.includes('prove_it enable'),
      `systemMessage should tell user how to re-enable, got: ${result.output.systemMessage}`)
    // Must NOT inject additionalContext (model stays unaware)
    assert.ok(!result.output.hookSpecificOutput || !result.output.hookSpecificOutput.additionalContext,
      `Should not set additionalContext, got: ${JSON.stringify(result.output)}`)

    // Env var must be injected so `! prove_it enable` works
    assert.ok(fs.existsSync(envFilePath), 'Env file should be written')
    const envContents = fs.readFileSync(envFilePath, 'utf8')
    assert.ok(envContents.includes(`PROVE_IT_SESSION_ID=${sessionId}`),
      `Env file should inject PROVE_IT_SESSION_ID, got: ${envContents}`)
  })

  it('hooks resume normal dispatch after clearDisabledSentinel', () => {
    createFile(tmpDir, 'ok.sh', '#!/usr/bin/env bash\nexit 0\n')
    makeExecutable(path.join(tmpDir, 'ok.sh'))
    writeConfig(tmpDir, makeConfig({
      claude: { PreToolUse: [{ name: 'ok', type: 'script', command: './ok.sh' }] }
    }))

    const env = isolatedEnv(tmpDir)
    const sessionId = 'disable-then-enable'

    writeDisabledSentinel(sessionId)
    const disabledResult = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env })
    assert.strictEqual(disabledResult.stdout.trim(), '', 'Silent while disabled')

    clearDisabledSentinel(sessionId)
    assert.strictEqual(readDisabledSentinel(sessionId), false)

    const enabledResult = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env })
    assert.strictEqual(enabledResult.exitCode, 0, `stderr: ${enabledResult.stderr}`)
    // After re-enable, dispatcher produces normal output (passed check context)
    assert.ok(enabledResult.output, 'Should produce output after re-enable')
  })
})
