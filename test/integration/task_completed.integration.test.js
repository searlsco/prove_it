const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const {
  invokeHook, createTempDir, cleanupTempDir, initGitRepo,
  writeConfig, makeConfig, isolatedEnv, createFastTestScript
} = require('./hook-harness')
const { setSignal, getSignal } = require('../../lib/session')
const { SIGNAL_TASK_MARKER } = require('../../lib/dispatcher/claude')

describe('TaskCompleted auto-signaling', () => {
  let tmpDir, projectDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_taskcompleted_')
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

  it('sets signal when task_subject matches signal pattern', () => {
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
        ]
      }
    ]))

    const result = invokeHook('claude:TaskCompleted', {
      hook_event_name: 'TaskCompleted',
      session_id: 'tc-match',
      task_id: '1',
      task_subject: 'Invoke `prove_it signal done`'
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    const signal = getSignal('tc-match')
    assert.notStrictEqual(signal, null, 'Signal should be set')
    assert.strictEqual(signal.type, 'done')
  })

  it('does not set signal when subject does not match', () => {
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
        ]
      }
    ]))

    const result = invokeHook('claude:TaskCompleted', {
      hook_event_name: 'TaskCompleted',
      session_id: 'tc-no-match',
      task_id: '2',
      task_subject: 'Run unit tests'
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(getSignal('tc-no-match'), null, 'Signal should not be set for non-matching subject')
  })

  it('no-op when signal already set', () => {
    setSignal('tc-already', 'done', null)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
        ]
      }
    ]))

    const result = invokeHook('claude:TaskCompleted', {
      hook_event_name: 'TaskCompleted',
      session_id: 'tc-already',
      task_id: '3',
      task_subject: 'Invoke `prove_it signal done`'
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    // Signal should still be set (unchanged)
    const signal = getSignal('tc-already')
    assert.notStrictEqual(signal, null)
    assert.strictEqual(signal.type, 'done')
  })

  it('does nothing when no signal-gated tasks in config', () => {
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'ungated-task', type: 'script', command: 'echo ok' }
        ]
      }
    ]))

    const result = invokeHook('claude:TaskCompleted', {
      hook_event_name: 'TaskCompleted',
      session_id: 'tc-no-gated',
      task_id: '4',
      task_subject: 'Invoke `prove_it signal done`'
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(getSignal('tc-no-gated'), null, 'Signal should not be set when no signal-gated tasks')
  })

  it('end-to-end: ExitPlanMode edits plan, TaskCompleted sets signal, Stop fires gated task', () => {
    // 1. Set up config with a signal-gated Stop task
    createFastTestScript(projectDir, true)
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'signal-gated', type: 'script', command: 'echo signal-task-ran', when: { signal: 'done' } }
        ]
      }
    ]))

    // 2. Create a plan file
    const plansDir = path.join(tmpDir, '.claude', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    const planText = '1. Implement feature\n2. Run tests'
    fs.writeFileSync(path.join(plansDir, 'my-plan.md'), planText)

    // 3. Invoke ExitPlanMode → plan file should be edited
    const exitResult = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'tc-e2e',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: planText }
    }, { projectDir, env })

    assert.strictEqual(exitResult.exitCode, 0)
    assert.strictEqual(exitResult.output.hookSpecificOutput.permissionDecision, 'allow')
    const planContent = fs.readFileSync(path.join(plansDir, 'my-plan.md'), 'utf8')
    assert.ok(planContent.includes(SIGNAL_TASK_MARKER), 'Plan file should have signal task appended')

    // 4. Invoke TaskCompleted with matching subject → signal should be set
    const tcResult = invokeHook('claude:TaskCompleted', {
      hook_event_name: 'TaskCompleted',
      session_id: 'tc-e2e',
      task_id: '99',
      task_subject: 'Invoke `prove_it signal done`'
    }, { projectDir, env })

    assert.strictEqual(tcResult.exitCode, 0)
    const signal = getSignal('tc-e2e')
    assert.notStrictEqual(signal, null, 'Signal should be set after TaskCompleted')
    assert.strictEqual(signal.type, 'done')

    // 5. Invoke Stop → signal-gated task should fire
    const stopResult = invokeHook('claude:Stop', {
      session_id: 'tc-e2e'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(stopResult.exitCode, 0)
    assert.ok(
      stopResult.stdout.includes('signal-task-ran'),
      `Expected signal-gated task to run, got: ${stopResult.stdout}`
    )
  })
})
