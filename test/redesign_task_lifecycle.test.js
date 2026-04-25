const { describe, it } = require('node:test')
const assert = require('node:assert')

const { behaviorForCapability } = require('../lib/adapter_capabilities')
const { runWorkflowEngine } = require('../lib/redesign/engine')
const { normalizeLifecycleEvent } = require('../lib/redesign/events')
const { createMemoryStatePort } = require('../lib/redesign/state_port')

function config ({ tasks, postTool = [], agentEnd = [], preTool = [] }) {
  return {
    schema_version: 1,
    profile_version: 'prove_it.strict.v1',
    globs: { source: [], test: [] },
    tasks,
    agent_workflows: {
      session_start: [],
      pre_tool: preTool,
      post_tool: postTool,
      post_tool_failure: [],
      agent_end: agentEnd
    },
    git_workflows: { pre_commit: [], pre_push: [] },
    adapters: {}
  }
}

function event (stage, sessionId = 'session-123') {
  return normalizeLifecycleEvent({
    adapterId: 'claude',
    rawEventName: stage,
    rawEvent: { session_id: sessionId },
    cwd: process.cwd()
  })
}

function claudeCompletionCapabilities () {
  return {
    completion_verification: behaviorForCapability('claude', 'completion_verification')
  }
}

describe('clean-runtime task lifecycle', () => {
  it('launches async tasks through the task port and records pending lifecycle state', () => {
    const effectiveConfig = config({
      tasks: {
        slow_check: { type: 'script', command: './script/slow', async: true }
      },
      postTool: ['slow_check']
    })
    const statePort = createMemoryStatePort()
    const launches = []
    const taskPort = {
      harvestBackgroundTasks () { return [] },
      launchBackgroundTask (context) {
        launches.push(context.taskName)
        return { id: 'bg-1', status: 'pending' }
      }
    }

    const effect = runWorkflowEngine({
      event: event('PostToolUse'),
      effectiveConfig,
      statePort,
      taskPort
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.deepStrictEqual(launches, ['slow_check'])
    assert.deepStrictEqual(statePort.readSessionState('session-123', 'task_lifecycle').async.pending, [{
      id: 'bg-1',
      taskName: 'slow_check',
      stage: 'post_tool',
      status: 'pending'
    }])
  })

  it('treats no async result yet as allow without rerunning unrelated work', () => {
    const effectiveConfig = config({
      tasks: {
        background_check: { type: 'script', command: './script/background', async: true }
      },
      postTool: ['background_check']
    })
    const statePort = createMemoryStatePort()
    statePort.writeSessionState('session-123', 'task_lifecycle', {
      async: { pending: [{ id: 'bg-1', taskName: 'background_check', stage: 'post_tool', status: 'pending' }] }
    })
    let harvested = false
    const taskPort = {
      harvestBackgroundTasks () { harvested = true; return [] },
      launchBackgroundTask: () => ({ id: 'bg-2', status: 'pending' })
    }

    const effect = runWorkflowEngine({
      event: event('PostToolUse'),
      effectiveConfig,
      statePort,
      taskPort
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.strictEqual(harvested, true)
    assert.deepStrictEqual(effect.asyncResults, [])
  })

  it('consumes harvested async passes and reports them as context-safe lifecycle results', () => {
    const effectiveConfig = config({ tasks: {} })
    const statePort = createMemoryStatePort()
    statePort.writeSessionState('session-123', 'task_lifecycle', {
      async: { pending: [{ id: 'bg-1', taskName: 'background_check', stage: 'post_tool', status: 'pending' }] }
    })
    const consumed = []
    const taskPort = {
      harvestBackgroundTasks () {
        return [{ id: 'bg-1', taskName: 'background_check', result: { pass: true, reason: 'background passed', output: 'looks good' } }]
      },
      consumeBackgroundTask (result) { consumed.push(result.id) }
    }

    const effect = runWorkflowEngine({
      event: event('PostToolUse'),
      effectiveConfig,
      statePort,
      taskPort
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.deepStrictEqual(consumed, ['bg-1'])
    assert.deepStrictEqual(effect.asyncResults.map(result => [result.taskName, result.status, result.reason]), [
      ['background_check', 'pass', 'background passed']
    ])
    assert.deepStrictEqual(statePort.readSessionState('session-123', 'task_lifecycle').async.pending, [])
  })

  it('holds harvested async failures on non-completion stages and enforces them at completion verification', () => {
    const effectiveConfig = config({ tasks: {} })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    statePort.writeSessionState('session-123', 'task_lifecycle', {
      async: { pending: [{ id: 'bg-1', taskName: 'background_check', stage: 'post_tool', status: 'pending' }] }
    })
    const taskPort = {
      harvestBackgroundTasks () {
        return [{ id: 'bg-1', taskName: 'background_check', result: { pass: false, reason: 'background failed' } }]
      }
    }

    const postToolEffect = runWorkflowEngine({
      event: event('PostToolUse'),
      effectiveConfig,
      statePort,
      taskPort
    })
    const completionEffect = runWorkflowEngine({
      event: event('Stop'),
      effectiveConfig,
      adapterCapabilities: claudeCompletionCapabilities(),
      statePort,
      taskPort
    })

    assert.strictEqual(postToolEffect.effect, 'allow')
    assert.deepStrictEqual(postToolEffect.asyncResults, [])
    assert.strictEqual(completionEffect.effect, 'fail')
    assert.match(completionEffect.reason, /background_check/)
    assert.match(completionEffect.reason, /background failed/)
    assert.strictEqual(completionEffect.signalLifecycle.action, 'preserve')
  })

  it('safely consumes stale or missing async result records without failing the hook', () => {
    const effectiveConfig = config({ tasks: {} })
    const statePort = createMemoryStatePort()
    statePort.writeSessionState('session-123', 'task_lifecycle', {
      async: { pending: [{ id: 'stale-1', taskName: 'old_check', stage: 'post_tool', status: 'pending' }] }
    })
    const taskPort = {
      harvestBackgroundTasks () {
        return [{ id: 'stale-1', taskName: 'old_check', missing: true, reason: 'result record expired' }]
      }
    }

    const effect = runWorkflowEngine({
      event: event('PostToolUse'),
      effectiveConfig,
      statePort,
      taskPort
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.deepStrictEqual(effect.lifecycleWarnings, [{
      taskName: 'old_check',
      reason: 'result record expired'
    }])
    assert.deepStrictEqual(statePort.readSessionState('session-123', 'task_lifecycle').async.pending, [])
  })

  it('settles parallel task batches in one completion invocation and clears done when they pass', () => {
    const effectiveConfig = config({
      tasks: {
        check_a: { type: 'script', command: './script/a', parallel: true },
        check_b: { type: 'script', command: './script/b', parallel: true }
      },
      agentEnd: ['check_a', 'check_b']
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    const taskPort = {
      startParallelTask ({ taskName }) { return { id: taskName, taskName } },
      settleParallelBatch (handles) {
        return handles.map(handle => ({ id: handle.id, taskName: handle.taskName, result: { pass: true, reason: `${handle.taskName} passed` } }))
      }
    }

    const effect = runWorkflowEngine({
      event: event('Stop'),
      effectiveConfig,
      adapterCapabilities: claudeCompletionCapabilities(),
      statePort,
      taskPort
    })

    assert.strictEqual(effect.effect, 'approve')
    assert.deepStrictEqual(effect.parallelResults.map(result => [result.taskName, result.status]), [
      ['check_a', 'pass'],
      ['check_b', 'pass']
    ])
    assert.strictEqual(effect.signalLifecycle.action, 'clear')
  })

  it('preserves done and reports the first actionable parallel failure', () => {
    const effectiveConfig = config({
      tasks: {
        check_a: { type: 'script', command: './script/a', parallel: true },
        check_b: { type: 'script', command: './script/b', parallel: true }
      },
      agentEnd: ['check_a', 'check_b']
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    const taskPort = {
      startParallelTask ({ taskName }) { return { id: taskName, taskName } },
      settleParallelBatch () {
        return [
          { id: 'check_a', taskName: 'check_a', result: { pass: false, reason: 'check_a failed' } },
          { id: 'check_b', taskName: 'check_b', result: { pass: false, reason: 'check_b failed' } }
        ]
      }
    }

    const effect = runWorkflowEngine({
      event: event('Stop'),
      effectiveConfig,
      adapterCapabilities: claudeCompletionCapabilities(),
      statePort,
      taskPort
    })

    assert.strictEqual(effect.effect, 'fail')
    assert.match(effect.reason, /check_a failed/)
    assert.doesNotMatch(effect.reason, /check_b failed/)
    assert.strictEqual(effect.signalLifecycle.action, 'preserve')
  })

  it('cancels active parallel work and runs lifecycle cleanup when a later serial task fails', () => {
    const effectiveConfig = config({
      tasks: {
        slow_parallel: { type: 'script', command: './script/slow', parallel: true },
        serial_gate: { type: 'script', command: './script/gate' }
      },
      agentEnd: ['slow_parallel', 'serial_gate']
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    const calls = []
    const taskPort = {
      startParallelTask ({ taskName }) {
        calls.push(['start', taskName])
        return { id: 'parallel-1', taskName }
      },
      run ({ taskName }) {
        calls.push(['run', taskName])
        return { pass: false, reason: 'serial gate failed' }
      },
      cancelTasks (handles) { calls.push(['cancel', handles.map(handle => handle.id).join(',')]) },
      cleanupTasks (handles) { calls.push(['cleanup', handles.map(handle => handle.id).join(',')]) }
    }

    const effect = runWorkflowEngine({
      event: event('Stop'),
      effectiveConfig,
      adapterCapabilities: claudeCompletionCapabilities(),
      statePort,
      taskPort
    })

    assert.strictEqual(effect.effect, 'fail')
    assert.match(effect.reason, /serial gate failed/)
    assert.deepStrictEqual(calls, [
      ['start', 'slow_parallel'],
      ['run', 'serial_gate'],
      ['cancel', 'parallel-1'],
      ['cleanup', 'parallel-1']
    ])
  })
})
