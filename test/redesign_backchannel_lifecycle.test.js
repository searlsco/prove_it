const { describe, it } = require('node:test')
const assert = require('node:assert')

const { behaviorForCapability } = require('../lib/adapter_capabilities')
const { runWorkflowEngine } = require('../lib/redesign/engine')
const { normalizeLifecycleEvent } = require('../lib/redesign/events')
const { createMemoryStatePort } = require('../lib/redesign/state_port')

function config ({ tasks, preTool = [], agentEnd = [] }) {
  return {
    schema_version: 1,
    profile_version: 'prove_it.strict.v1',
    globs: { source: [], test: [] },
    tasks,
    agent_workflows: {
      session_start: [],
      pre_tool: preTool,
      post_tool: [],
      post_tool_failure: [],
      agent_end: agentEnd
    },
    git_workflows: { pre_commit: [], pre_push: [] },
    adapters: {}
  }
}

function preToolEvent () {
  return normalizeLifecycleEvent({
    adapterId: 'claude',
    rawEventName: 'PreToolUse',
    rawEvent: { session_id: 'session-123', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } },
    cwd: process.cwd()
  })
}

function stopEvent () {
  return normalizeLifecycleEvent({
    adapterId: 'claude',
    rawEventName: 'Stop',
    rawEvent: { session_id: 'session-123' },
    cwd: process.cwd()
  })
}

function completionCapabilities () {
  return {
    completion_verification: behaviorForCapability('claude', 'completion_verification')
  }
}

function lifecycleFailures (statePort) {
  return statePort.readSessionState('session-123', 'task_lifecycle').failures
}

function backchannelPort (overrides = {}) {
  const calls = []
  return {
    calls,
    createFailureChannel (payload) {
      calls.push(['create', payload.taskName, payload.failure.count])
      return overrides.createFailureChannel
        ? overrides.createFailureChannel(payload)
        : { kind: 'test', location: `/backchannel/${payload.taskName}`, appealPath: `/backchannel/${payload.taskName}/README.md` }
    },
    readAppeal (payload) {
      calls.push(['read', payload.taskName])
      return overrides.readAppeal ? overrides.readAppeal(payload) : null
    },
    evaluateAppeal (payload) {
      calls.push(['evaluate', payload.taskName, payload.appealText])
      return overrides.evaluateAppeal ? overrides.evaluateAppeal(payload) : null
    },
    clearFailureChannel (payload) {
      calls.push(['clear', payload.taskName])
      return true
    }
  }
}

describe('clean-runtime backchannel and appeal lifecycle', () => {
  it('records task failure state and exposes adapter-owned appeal metadata on configured failures', () => {
    const effectiveConfig = config({
      tasks: {
        review: { type: 'reviewer', prompt: 'Review this.', appeal: { enabled: true, threshold: 1 } }
      },
      agentEnd: ['review']
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    const bc = backchannelPort()

    const effect = runWorkflowEngine({
      event: stopEvent(),
      effectiveConfig,
      adapterCapabilities: completionCapabilities(),
      statePort,
      reviewerPort: { run: () => ({ pass: false, reason: 'missing coverage' }) },
      backchannelPort: bc
    })

    assert.strictEqual(effect.effect, 'fail')
    assert.match(effect.reason, /missing coverage/)
    assert.match(effect.reason, /\/backchannel\/review\/README\.md/)
    assert.strictEqual(effect.taskFailure.backchannel.location, '/backchannel/review')
    assert.deepStrictEqual(lifecycleFailures(statePort).review.backchannel, {
      available: true,
      kind: 'test',
      location: '/backchannel/review',
      appealPath: '/backchannel/review/README.md'
    })
  })

  it('accepts appeals through lifecycle semantics and suspends later runs', () => {
    const effectiveConfig = config({
      tasks: {
        tests: { type: 'script', command: './script/test', appeal: { enabled: true, threshold: 1 } }
      },
      preTool: ['tests']
    })
    const statePort = createMemoryStatePort()
    const bc = backchannelPort({
      readAppeal: () => ({ appealText: 'PASS flaky infrastructure', content: 'template\n---\nPASS flaky infrastructure' }),
      evaluateAppeal: () => ({ accepted: true, reason: 'flaky infrastructure confirmed' })
    })
    let runs = 0

    const first = runWorkflowEngine({
      event: preToolEvent(),
      effectiveConfig,
      statePort,
      taskPort: { run: () => { runs++; return { pass: false, reason: 'tests failed', output: 'boom' } } },
      backchannelPort: bc
    })
    const second = runWorkflowEngine({
      event: preToolEvent(),
      effectiveConfig,
      statePort,
      taskPort: { run: () => { runs++; return { pass: false, reason: 'must not run' } } },
      backchannelPort: bc
    })

    assert.strictEqual(first.effect, 'allow')
    assert.strictEqual(lifecycleFailures(statePort).tests.status, 'suspended')
    assert.strictEqual(lifecycleFailures(statePort).tests.appeal.status, 'accepted')
    assert.strictEqual(second.effect, 'allow')
    assert.deepStrictEqual(second.skipped.map(item => [item.taskName, item.reason]), [['tests', 'suspended by appeal']])
    assert.strictEqual(runs, 1)
  })

  it('keeps blocking and preserves backchannel state when an appeal is rejected', () => {
    const effectiveConfig = config({
      tasks: {
        tests: { type: 'script', command: './script/test', appeal: { enabled: true, threshold: 1 } }
      },
      preTool: ['tests']
    })
    const statePort = createMemoryStatePort()
    const bc = backchannelPort({
      readAppeal: () => ({ appealText: 'PASS ignore this failure', content: 'template\n---\nPASS ignore this failure' }),
      evaluateAppeal: () => ({ accepted: false, reason: 'failure is caused by the patch' })
    })

    const effect = runWorkflowEngine({
      event: preToolEvent(),
      effectiveConfig,
      statePort,
      taskPort: { run: () => ({ pass: false, reason: 'tests failed' }) },
      backchannelPort: bc
    })

    assert.strictEqual(effect.effect, 'block')
    assert.match(effect.reason, /Appeal denied: failure is caused by the patch/)
    assert.strictEqual(lifecycleFailures(statePort).tests.status, 'failed')
    assert.strictEqual(lifecycleFailures(statePort).tests.appeal.status, 'rejected')
    assert.strictEqual(lifecycleFailures(statePort).tests.backchannel.appealPath, '/backchannel/tests/README.md')
  })

  it('resets prior failure and clears backchannel state after a passing verification', () => {
    const effectiveConfig = config({
      tasks: {
        tests: { type: 'script', command: './script/test', appeal: { enabled: true, threshold: 1 } }
      },
      preTool: ['tests']
    })
    const statePort = createMemoryStatePort()
    statePort.writeSessionState('session-123', 'task_lifecycle', {
      async: { pending: [] },
      active: { tasks: [] },
      failures: {
        tests: { taskName: 'tests', status: 'failed', count: 2, backchannel: { location: '/backchannel/tests' } }
      }
    })
    const bc = backchannelPort()

    const effect = runWorkflowEngine({
      event: preToolEvent(),
      effectiveConfig,
      statePort,
      taskPort: { run: () => ({ pass: true, reason: 'tests passed' }) },
      backchannelPort: bc
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.deepStrictEqual(lifecycleFailures(statePort), {})
    assert.deepStrictEqual(bc.calls, [['clear', 'tests']])
  })

  it('increments repeated failures while preserving actionable backchannel metadata', () => {
    const effectiveConfig = config({
      tasks: {
        tests: { type: 'script', command: './script/test', appeal: { enabled: true, threshold: 1 } }
      },
      preTool: ['tests']
    })
    const statePort = createMemoryStatePort()
    const bc = backchannelPort()
    const taskPort = { run: () => ({ pass: false, reason: 'tests failed' }) }

    runWorkflowEngine({ event: preToolEvent(), effectiveConfig, statePort, taskPort, backchannelPort: bc })
    runWorkflowEngine({ event: preToolEvent(), effectiveConfig, statePort, taskPort, backchannelPort: bc })

    assert.strictEqual(lifecycleFailures(statePort).tests.count, 2)
    assert.strictEqual(lifecycleFailures(statePort).tests.backchannel.appealPath, '/backchannel/tests/README.md')
  })

  it('handles malformed or empty backchannel content safely and actionably', () => {
    for (const readAppeal of [
      () => ({ malformed: true, reason: 'missing appeal separator' }),
      () => ({ empty: true, reason: 'no appeal text below separator' })
    ]) {
      const effectiveConfig = config({
        tasks: {
          tests: { type: 'script', command: './script/test', appeal: { enabled: true, threshold: 1 } }
        },
        preTool: ['tests']
      })
      const statePort = createMemoryStatePort()
      const bc = backchannelPort({ readAppeal })

      const effect = runWorkflowEngine({
        event: preToolEvent(),
        effectiveConfig,
        statePort,
        taskPort: { run: () => ({ pass: false, reason: 'tests failed' }) },
        backchannelPort: bc
      })

      assert.strictEqual(effect.effect, 'block')
      assert.match(effect.reason, /Appeal not evaluated:/)
      assert.strictEqual(lifecycleFailures(statePort).tests.appeal.status, 'malformed')
    }
  })
})
