const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  cleanupTempDir,
  createFile,
  createTempDir,
  isolatedEnv,
  invokeHook,
  makeExecutable
} = require('./hook-harness')
const { PROFILE_VERSION } = require('../../lib/redesign/config')
const { getSignal } = require('../../lib/session')

function writeStrictConfig (dir, { tasks = {}, preTool = [] } = {}) {
  const cfgPath = path.join(dir, '.prove_it', 'config.json')
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify({
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    tasks,
    agent_workflows: {
      pre_tool: preTool
    },
    adapters: {
      claude: { enabled: true }
    }
  }, null, 2), 'utf8')
}

function writeScript (dir, name, body) {
  const scriptPath = path.join(dir, 'script', name)
  createFile(dir, path.join('script', name), `#!/usr/bin/env bash\n${body}\n`)
  makeExecutable(scriptPath)
  return scriptPath
}

function invokePreTool (projectDir, sessionId, command, env) {
  return invokeHook('claude:PreToolUse', {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: 'Bash',
    tool_input: { command }
  }, {
    projectDir,
    cwd: projectDir,
    env
  })
}

function additionalContext (result) {
  return result.output?.hookSpecificOutput?.additionalContext || ''
}

describe('Claude clean-runtime Bash signal interception', () => {
  let tmpDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_claude_clean_signal_')
    env = isolatedEnv(tmpDir)
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

  it('records done, stuck, and idle through shared clean session state before Bash tasks can deny', () => {
    writeScript(tmpDir, 'deny-bash', 'echo "bash task should not run" >&2\nexit 1')
    writeStrictConfig(tmpDir, {
      tasks: {
        deny_bash: { type: 'script', command: './script/deny-bash', matcher: 'Bash' }
      },
      preTool: ['deny_bash']
    })

    for (const signalType of ['done', 'stuck', 'idle']) {
      const sessionId = `clean-signal-${signalType}`
      const result = invokePreTool(tmpDir, sessionId, `prove_it signal ${signalType}`, env)

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, `${signalType}: expected Claude context output`)
      assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, undefined)
      assert.match(additionalContext(result), new RegExp(`signal "${signalType}" recorded`))
      assert.doesNotMatch(result.stderr + result.stdout, /bash task should not run/)

      const signal = getSignal(sessionId)
      assert.notStrictEqual(signal, null)
      assert.strictEqual(signal.type, signalType)
      assert.strictEqual(signal.message, null)
    }
  })

  it('preserves supported message syntax and updates repeated signals', () => {
    writeStrictConfig(tmpDir)
    const sessionId = 'clean-signal-message-update'

    const first = invokePreTool(tmpDir, sessionId, 'prove_it signal done --message "ready for review"', env)
    assert.strictEqual(first.exitCode, 0)
    assert.strictEqual(getSignal(sessionId).type, 'done')
    assert.strictEqual(getSignal(sessionId).message, 'ready for review')
    const firstAt = getSignal(sessionId).at

    const second = invokePreTool(tmpDir, sessionId, "prove_it signal stuck -m 'blocked on credentials'", env)
    assert.strictEqual(second.exitCode, 0)
    const updated = getSignal(sessionId)
    assert.strictEqual(updated.type, 'stuck')
    assert.strictEqual(updated.message, 'blocked on credentials')
    assert.ok(updated.at >= firstAt, 'signal timestamp should be updated')
  })

  it('supports legacy Claude command variants including path-prefixed and compound commands', () => {
    writeStrictConfig(tmpDir)

    const prefixed = invokePreTool(tmpDir, 'clean-signal-prefixed', '/tmp/test-bin/prove_it signal idle -m waiting', env)
    assert.strictEqual(prefixed.exitCode, 0)
    assert.match(additionalContext(prefixed), /signal "idle" recorded/)
    assert.strictEqual(getSignal('clean-signal-prefixed').type, 'idle')
    assert.strictEqual(getSignal('clean-signal-prefixed').message, 'waiting')

    const compound = invokePreTool(tmpDir, 'clean-signal-compound', 'prove_it signal done --message ready && echo should-not-run', env)
    assert.strictEqual(compound.exitCode, 0)
    assert.match(additionalContext(compound), /signal "done" recorded/)
    assert.strictEqual(getSignal('clean-signal-compound').type, 'done')
    assert.strictEqual(getSignal('clean-signal-compound').message, 'ready')
  })

  it('returns a clear Claude-visible result for invalid signal commands without corrupting existing state', () => {
    writeScript(tmpDir, 'deny-bash', 'echo "bash task should not run" >&2\nexit 1')
    writeStrictConfig(tmpDir, {
      tasks: {
        deny_bash: { type: 'script', command: './script/deny-bash', matcher: 'Bash' }
      },
      preTool: ['deny_bash']
    })

    const sessionId = 'clean-signal-invalid'
    assert.strictEqual(invokePreTool(tmpDir, sessionId, 'prove_it signal done --message initial', env).exitCode, 0)
    const before = getSignal(sessionId)

    const result = invokePreTool(tmpDir, sessionId, 'prove_it signal bogus --message bad', env)

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'invalid signal should emit Claude hook JSON')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, undefined)
    assert.match(additionalContext(result), /invalid signal "bogus"/)
    assert.match(additionalContext(result), /done, stuck, idle/)
    assert.doesNotMatch(result.stderr + result.stdout, /bash task should not run/)
    assert.deepStrictEqual(getSignal(sessionId), before)
  })

  it('falls through to normal clean PreToolUse workflow for non-signal prove_it commands', () => {
    writeScript(tmpDir, 'deny-bash', 'echo "normal pre-tool task ran" >&2\nexit 1')
    writeStrictConfig(tmpDir, {
      tasks: {
        deny_bash: { type: 'script', command: './script/deny-bash', matcher: 'Bash' }
      },
      preTool: ['deny_bash']
    })

    const result = invokePreTool(tmpDir, 'clean-signal-fallthrough', 'prove_it doctor', env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /normal pre-tool task ran/)
    assert.strictEqual(getSignal('clean-signal-fallthrough'), null)
  })
})
