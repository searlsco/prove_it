const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const {
  invokeHook, createTempDir, cleanupTempDir, initGitRepo,
  writeConfig, makeConfig, isolatedEnv, createFastTestScript
} = require('./hook-harness')
const { setSignal, getSignal } = require('../../lib/session')

describe('signal integration', () => {
  let tmpDir, projectDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_signal_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)
    env = isolatedEnv(tmpDir)

    // Align parent process PROVE_IT_DIR with the child's so session state
    // is read/written from the same directory by both processes
    origProveItDir = process.env.PROVE_IT_DIR
    origHome = process.env.HOME
    process.env.PROVE_IT_DIR = env.PROVE_IT_DIR
    process.env.HOME = env.HOME
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    process.env.HOME = origHome
    cleanupTempDir(tmpDir)
  })

  it('PreToolUse intercepts prove_it signal done and records signal', () => {
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*', tasks: [] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'sig-int-1',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it signal done' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    // Output is JSON with escaped quotes; check the parsed output
    assert.ok(result.output, 'Expected JSON output')
    const reason = result.output.hookSpecificOutput?.permissionDecisionReason || ''
    assert.ok(
      reason.includes('signal "done" recorded'),
      `Expected signal recorded in reason, got: ${reason}`
    )

    const signal = getSignal('sig-int-1')
    assert.notStrictEqual(signal, null, 'Signal should be set in session state')
    assert.strictEqual(signal.type, 'done')
  })

  it('PreToolUse intercepts prove_it signal with --message', () => {
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'sig-int-msg',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it signal stuck --message "Cannot test async"' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    const signal = getSignal('sig-int-msg')
    assert.notStrictEqual(signal, null, 'Signal should be set')
    assert.strictEqual(signal.type, 'stuck')
    assert.strictEqual(signal.message, 'Cannot test async')
  })

  it('PreToolUse intercepts prove_it signal clear', () => {
    setSignal('sig-int-clear', 'done', null)
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'sig-int-clear',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it signal clear' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.stdout.includes('signal cleared'))
    assert.strictEqual(getSignal('sig-int-clear'), null)
  })

  it('Stop with when: { signal: "done" } fires when signal is active', () => {
    setSignal('sig-stop-fire', 'done', null)
    createFastTestScript(projectDir, true)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast' },
          { name: 'signal-gated', type: 'script', command: 'echo signal-task-ran', when: { signal: 'done' } }
        ]
      }
    ]))

    const result = invokeHook('claude:Stop', {
      session_id: 'sig-stop-fire'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.stdout.includes('signal-task-ran'), `Expected signal-gated task to run, got: ${result.stdout}`)
  })

  it('Stop with when: { signal: "done" } skips when no signal active', () => {
    createFastTestScript(projectDir, true)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast' },
          { name: 'signal-gated', type: 'script', command: 'echo should-not-run', when: { signal: 'done' } }
        ]
      }
    ]))

    const result = invokeHook('claude:Stop', {
      session_id: 'sig-stop-skip'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(!result.stdout.includes('should-not-run'), 'Signal-gated task should be skipped')
  })

  it('signal is cleared after successful Stop', () => {
    setSignal('sig-stop-clear', 'done', null)
    createFastTestScript(projectDir, true)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast' }
        ]
      }
    ]))

    invokeHook('claude:Stop', {
      session_id: 'sig-stop-clear'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(getSignal('sig-stop-clear'), null, 'Signal should be cleared after successful Stop')
  })

  it('signal is preserved after failed Stop', () => {
    setSignal('sig-stop-fail', 'done', null)
    createFastTestScript(projectDir, false)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast' }
        ]
      }
    ]))

    invokeHook('claude:Stop', {
      session_id: 'sig-stop-fail'
    }, { projectDir, env, cwd: projectDir })

    const signal = getSignal('sig-stop-fail')
    assert.notStrictEqual(signal, null, 'Signal should be preserved after failed Stop')
    assert.strictEqual(signal.type, 'done')
  })

  it('PreToolUse falls through for unknown signal types', () => {
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'sig-unknown',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it signal bogus' }
    }, { projectDir, env })

    // Falls through—no interception, exits normally
    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(getSignal('sig-unknown'), null, 'No signal should be set for unknown types')
  })
})
