const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { behaviorForCapability } = require('../lib/adapter_capabilities')
const { runWorkflowEngine } = require('../lib/redesign/engine')
const { normalizeLifecycleEvent } = require('../lib/redesign/events')
const { createMemoryStatePort } = require('../lib/redesign/state_port')
const { requestSessionCancel } = require('../lib/redesign/session_control')
const { asyncSnapshotForTask } = require('../lib/redesign/script_task_port')

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
  it('suppresses routine async worker PASS and DONE logs for failures-only script tasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_async_worker_quiet_'))
    const proveItDir = path.join(tmpDir, 'prove_it_home')
    try {
      fs.mkdirSync(path.join(tmpDir, 'script'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'script', 'pass'), '#!/usr/bin/env bash\necho routine async output\n')
      fs.chmodSync(path.join(tmpDir, 'script', 'pass'), 0o755)
      const task = { type: 'script', command: './script/pass', output: 'failures_only' }
      const snapshot = asyncSnapshotForTask({
        taskName: 'quiet_background_check',
        task,
        event: normalizeLifecycleEvent({
          adapterId: 'claude',
          rawEventName: 'PostToolUse',
          rawEvent: { session_id: 'quiet-async-session' },
          cwd: tmpDir,
          projectDir: tmpDir,
          rootDir: tmpDir
        }),
        effectiveConfig: config({ tasks: { quiet_background_check: task }, postTool: ['quiet_background_check'] })
      }, { asyncDir: path.join(tmpDir, 'async') })

      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'async_worker.js'), snapshot.contextFilePath], {
        cwd: tmpDir,
        encoding: 'utf8',
        env: { ...process.env, PROVE_IT_DIR: proveItDir }
      })

      assert.strictEqual(result.status, 0, result.stderr)
      assert.ok(fs.existsSync(snapshot.resultPath), 'async worker should still write the result record')
      const logPath = path.join(proveItDir, 'sessions', 'quiet-async-session.jsonl')
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
      assert.doesNotMatch(log, /PASS/)
      assert.doesNotMatch(log, /DONE/)
      assert.doesNotMatch(log, /routine async output/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('preserves params, task-local env, and timeout_ms in async script task snapshots', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_async_snapshot_'))
    try {
      const task = {
        type: 'script',
        command: './script/check',
        params: { mode: 'strict' },
        env: { TASK_LOCAL: 'yes' },
        timeout_ms: 3210
      }
      const snapshot = asyncSnapshotForTask({
        taskName: 'background_check',
        task,
        event: event('PostToolUse'),
        effectiveConfig: config({ tasks: { background_check: task }, postTool: ['background_check'] })
      }, { asyncDir: tmpDir })
      const payload = JSON.parse(fs.readFileSync(snapshot.contextFilePath, 'utf8'))

      assert.strictEqual(payload.task.name, 'background_check')
      assert.deepStrictEqual(payload.task.params, { mode: 'strict' })
      assert.strictEqual(payload.task.timeout, 3210)
      assert.deepStrictEqual(payload.context.configEnv, { TASK_LOCAL: 'yes' })
      assert.strictEqual(payload.context.normalizedEvent.stage, 'post_tool')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('preserves params, task-local env, and timeout_ms in parallel script task provider contexts', () => {
    const task = {
      type: 'script',
      command: './script/parallel',
      params: { mode: 'strict' },
      env: { TASK_LOCAL: 'yes' },
      timeout_ms: 6543,
      parallel: true
    }
    const effectiveConfig = config({ tasks: { parallel_check: task }, agentEnd: ['parallel_check'] })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    let received
    const taskPort = {
      startParallelTask (context) {
        received = context
        return { id: 'parallel-1', taskName: context.taskName, task: context.task }
      },
      settleParallelBatch (handles) {
        return handles.map(handle => ({ id: handle.id, taskName: handle.taskName, task: handle.task, result: { pass: true, reason: 'ok' } }))
      }
    }

    runWorkflowEngine({
      event: event('Stop'),
      effectiveConfig,
      adapterCapabilities: claudeCompletionCapabilities(),
      statePort,
      taskPort
    })

    assert.strictEqual(received.taskName, 'parallel_check')
    assert.deepStrictEqual(received.task.params, { mode: 'strict' })
    assert.deepStrictEqual(received.task.env, { TASK_LOCAL: 'yes' })
    assert.strictEqual(received.task.timeout_ms, 6543)
  })

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

  it('suppresses harvested async pass results for failures-only tasks without hiding failures', () => {
    const effectiveConfig = config({ tasks: { background_check: { type: 'script', command: './script/background', output: 'failures_only' } } })
    const statePort = createMemoryStatePort()
    statePort.writeSessionState('session-123', 'task_lifecycle', {
      async: { pending: [{ id: 'bg-1', taskName: 'background_check', stage: 'post_tool', status: 'pending' }] }
    })
    const taskPort = {
      harvestBackgroundTasks () {
        return [{ id: 'bg-1', taskName: 'background_check', task: effectiveConfig.tasks.background_check, result: { pass: true, reason: 'background passed', output: 'looks good' } }]
      },
      consumeBackgroundTask () {}
    }

    const effect = runWorkflowEngine({
      event: event('PostToolUse'),
      effectiveConfig,
      statePort,
      taskPort
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.deepStrictEqual(effect.asyncResults, [])
    assert.strictEqual(effect.routineOutputSuppressed, true)
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

  it('suppresses successful failures-only parallel lifecycle results while preserving completion success', () => {
    const effectiveConfig = config({
      tasks: {
        quiet_parallel: { type: 'script', command: './script/quiet', output: 'failures_only', parallel: true }
      },
      agentEnd: ['quiet_parallel']
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    const taskPort = {
      startParallelTask ({ taskName }) { return { id: taskName, taskName } },
      settleParallelBatch (handles) {
        return handles.map(handle => ({ id: handle.id, taskName: handle.taskName, result: { pass: true, reason: `${handle.taskName} passed`, output: 'routine pass output' } }))
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
    assert.strictEqual(effect.parallelResults, undefined)
    assert.strictEqual(effect.routineOutputSuppressed, true)
    assert.strictEqual(effect.signalLifecycle.action, 'clear')
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

  it('observes clean cancel requests, cancels pending async work, clears the request, and allows the hook', () => {
    const effectiveConfig = config({ tasks: {} })
    const statePort = createMemoryStatePort()
    statePort.writeSessionState('session-123', 'task_lifecycle', {
      async: {
        pending: [
          { id: 'script-bg', taskName: 'background_script', stage: 'post_tool', status: 'pending' },
          { id: 'review-bg', taskName: 'background_review', taskType: 'reviewer', stage: 'post_tool', status: 'pending' }
        ]
      }
    })
    requestSessionCancel(statePort, 'session-123')
    const calls = []
    const taskPort = {
      cancelBackgroundTasks (handles) { calls.push(['task-cancel', handles.map(handle => handle.id).join(',')]) },
      cleanupBackgroundTasks (handles) { calls.push(['task-cleanup', handles.map(handle => handle.id).join(',')]) }
    }
    const reviewerPort = {
      cancelBackgroundTasks (handles) { calls.push(['review-cancel', handles.map(handle => handle.id).join(',')]) },
      cleanupBackgroundTasks (handles) { calls.push(['review-cleanup', handles.map(handle => handle.id).join(',')]) }
    }

    const effect = runWorkflowEngine({
      event: event('PostToolUse'),
      effectiveConfig,
      statePort,
      taskPort,
      reviewerPort
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.match(effect.reason, /Cancelled by user/)
    assert.deepStrictEqual(calls, [
      ['task-cancel', 'script-bg'],
      ['task-cleanup', 'script-bg'],
      ['review-cancel', 'review-bg'],
      ['review-cleanup', 'review-bg']
    ])
    assert.deepStrictEqual(statePort.readSessionState('session-123', 'task_lifecycle').async.pending, [])
    assert.strictEqual(statePort.readSessionState('session-123', 'session_control').cancel, null)
  })

  it('cancels active parallel work through provider hooks when a clean cancel request is observed', () => {
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
        requestSessionCancel(statePort, 'session-123')
        return { pass: true, reason: 'serial gate passed' }
      },
      cancelTasks (handles) { calls.push(['cancel', handles.map(handle => handle.id).join(',')]) },
      cleanupTasks (handles) { calls.push(['cleanup', handles.map(handle => handle.id).join(',')]) },
      settleParallelBatch () {
        calls.push(['settle'])
        return []
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
    assert.match(effect.reason, /Cancelled by user/)
    assert.deepStrictEqual(calls, [
      ['start', 'slow_parallel'],
      ['run', 'serial_gate'],
      ['cancel', 'parallel-1'],
      ['cleanup', 'parallel-1']
    ])
    assert.strictEqual(statePort.readSessionState('session-123', 'session_control').cancel, null)
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
