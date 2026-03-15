const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const {
  invokeHook, createTempDir, cleanupTempDir, initGitRepo,
  writeConfig, makeConfig, isolatedEnv, createFastTestScript
} = require('./hook-harness')
const { setPhase, getPhase, setSignal, getSignal } = require('../../lib/session')

describe('phase integration', () => {
  let tmpDir, projectDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_phase_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)
    env = isolatedEnv(tmpDir)

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

  it('PreToolUse intercepts prove_it phase plan and records phase', () => {
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] },
      { type: 'claude', event: 'Stop', tasks: [{ name: 'noop', type: 'script', command: 'true' }] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'phase-int-1',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it phase plan' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    const reason = result.output.hookSpecificOutput?.permissionDecisionReason || ''
    assert.ok(
      reason.includes('phase "plan" recorded'),
      `Expected phase recorded in reason, got: ${reason}`
    )
    assert.strictEqual(getPhase('phase-int-1'), 'plan')
  })

  it('phase change emits systemMessage telling Claude to continue', () => {
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] },
      { type: 'claude', event: 'Stop', tasks: [{ name: 'noop', type: 'script', command: 'true' }] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'phase-sysmsg',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it phase refactor' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    const sysMsg = result.output.systemMessage || ''
    assert.ok(
      sysMsg.includes('continue'),
      `Expected systemMessage telling Claude to continue, got: ${JSON.stringify(sysMsg)}`
    )
  })

  it('PreToolUse intercepts prove_it phase implement and records phase', () => {
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] },
      { type: 'claude', event: 'Stop', tasks: [{ name: 'noop', type: 'script', command: 'true' }] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'phase-int-2',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it phase implement' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(getPhase('phase-int-2'), 'implement')
  })

  it('PreToolUse falls through for unknown phase types', () => {
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] },
      { type: 'claude', event: 'Stop', tasks: [{ name: 'noop', type: 'script', command: 'true' }] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'phase-unknown',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it phase bogus' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(getPhase('phase-unknown'), 'unknown', 'No phase should be set for unknown types')
  })

  it('EnterPlanMode sets phase to plan', () => {
    writeConfig(projectDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] },
      { type: 'claude', event: 'Stop', tasks: [{ name: 'noop', type: 'script', command: 'true' }] }
    ]))

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'phase-planmode',
      tool_name: 'EnterPlanMode',
      tool_input: {}
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(getPhase('phase-planmode'), 'plan')
  })

  it('phase persists after successful Stop', () => {
    setPhase('phase-persist', 'implement')
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
      session_id: 'phase-persist'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(getPhase('phase-persist'), 'implement', 'Phase should persist after successful Stop')
  })

  it('Stop with when: { phase: "implement" } fires when phase matches', () => {
    setPhase('phase-gated-fire', 'implement')
    createFastTestScript(projectDir, true)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast' },
          { name: 'phase-gated', type: 'script', command: 'echo phase-task-ran', when: { phase: 'implement' } }
        ]
      }
    ]))

    const result = invokeHook('claude:Stop', {
      session_id: 'phase-gated-fire'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.stdout.includes('phase-task-ran'), `Expected phase-gated task to run, got: ${result.stdout}`)
  })

  it('Stop with when: { phase: "implement" } skips when phase does not match', () => {
    setPhase('phase-gated-skip', 'plan')
    createFastTestScript(projectDir, true)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast' },
          { name: 'phase-gated', type: 'script', command: 'echo should-not-run', when: { phase: 'implement' } }
        ]
      }
    ]))

    const result = invokeHook('claude:Stop', {
      session_id: 'phase-gated-skip'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(!result.stdout.includes('should-not-run'), 'Phase-gated task should be skipped')
  })

  it('successful Stop with done signal resets phase to unknown', () => {
    setPhase('phase-done-reset', 'implement')
    setSignal('phase-done-reset', 'done')
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
      session_id: 'phase-done-reset'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(getPhase('phase-done-reset'), 'unknown', 'Phase should reset to unknown after successful done signal')
    assert.strictEqual(getSignal('phase-done-reset'), null, 'Signal should be cleared')
  })

  it('successful Stop with stuck signal does NOT reset phase', () => {
    setPhase('phase-stuck-keep', 'implement')
    setSignal('phase-stuck-keep', 'stuck')
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
      session_id: 'phase-stuck-keep'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(getPhase('phase-stuck-keep'), 'implement', 'Phase should persist after stuck signal')
    assert.strictEqual(getSignal('phase-stuck-keep'), null, 'Signal should be cleared')
  })
})
