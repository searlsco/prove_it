const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { behaviorForCapability } = require('../lib/adapter_capabilities')
const { loadProjectConfig, PROFILE_VERSION } = require('../lib/redesign/config')
const { normalizeLifecycleEvent, normalizePiToolCall } = require('../lib/redesign/events')
const { runWorkflowEngine } = require('../lib/redesign/engine')
const { readSignal } = require('../lib/redesign/signal_lifecycle')
const { createMemoryStatePort } = require('../lib/redesign/state_port')

function tmpRepo (tasks = {
  protect_custom_config: {
    type: 'config_guard',
    protected_paths: ['.prove_it/config.json']
  }
}, preTool = ['protect_custom_config'], agentEnd = []) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_engine_'))
  fs.mkdirSync(path.join(repo, '.prove_it'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.prove_it', 'config.json'), JSON.stringify({
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    tasks,
    agent_workflows: {
      pre_tool: preTool,
      agent_end: agentEnd
    },
    adapters: {
      pi: { enabled: true }
    }
  }, null, 2))
  return repo
}

function piCapabilities () {
  return {
    pre_tool_blocking: behaviorForCapability('pi', 'pre_tool_blocking')
  }
}

function tmpCompletionRepo (agentEnd = ['completion_check']) {
  return tmpRepo({
    completion_check: {
      type: 'script',
      command: './script/test_fast'
    }
  }, [], agentEnd)
}

function agentEndEvent (adapterId, repo, sessionId = 'session-123') {
  return normalizeLifecycleEvent({
    adapterId,
    rawEventName: adapterId === 'claude' ? 'Stop' : 'agent_end',
    rawEvent: { session_id: sessionId },
    cwd: repo
  })
}

describe('shared workflow engine', () => {
  it('emits harness-neutral allow and block effects for a Pi-shaped pre_tool config guard workflow', () => {
    const repo = tmpRepo()
    const emitted = []
    const effectPort = {
      emit (effect, context) {
        emitted.push({ effect, context })
      }
    }

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const adapterCapabilities = piCapabilities()
      const statePort = { read: () => ({}) }
      const taskPort = { run: () => assert.fail('config_guard should not run through a shell task port') }

      const allowed = runWorkflowEngine({
        event: normalizePiToolCall({
          toolName: 'edit',
          input: { path: 'src/app.js' }
        }, { cwd: repo }),
        effectiveConfig,
        adapterCapabilities,
        statePort,
        taskPort,
        effectPort,
        dependencies: {}
      })

      const blocked = runWorkflowEngine({
        event: normalizePiToolCall({
          toolName: 'write',
          input: { path: '.prove_it/config.json' }
        }, { cwd: repo }),
        effectiveConfig,
        adapterCapabilities,
        statePort,
        taskPort,
        effectPort,
        dependencies: {}
      })

      assert.deepStrictEqual(allowed, { effect: 'allow' })
      assert.deepStrictEqual(blocked, {
        effect: 'block',
        reason: 'prove_it: Cannot modify protected prove_it config path .prove_it/config.json'
      })
      assert.deepStrictEqual(emitted.map(entry => entry.effect), [allowed, blocked])
      assert.strictEqual(emitted[0].context.adapterCapabilities, adapterCapabilities)
      assert.strictEqual(emitted[0].context.ports.state, statePort)
      assert.strictEqual(emitted[0].context.ports.task, taskPort)
      assert.strictEqual(emitted[0].context.event.stage, 'pre_tool')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('emits allow when a Pi pre_tool script task passes through the injected task runner port', () => {
    const repo = tmpRepo({
      preflight: {
        type: 'script',
        command: './script/preflight'
      }
    }, ['preflight'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const event = normalizePiToolCall({
        toolName: 'edit',
        input: { path: 'src/app.js' }
      }, { cwd: repo })
      const calls = []
      const taskPort = {
        run (context) {
          calls.push(context)
          return { pass: true, reason: './script/preflight passed' }
        }
      }

      const effect = runWorkflowEngine({
        event,
        effectiveConfig,
        adapterCapabilities: piCapabilities(),
        taskPort
      })

      assert.deepStrictEqual(effect, { effect: 'allow' })
      assert.strictEqual(calls.length, 1)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('emits block with an actionable reason when a Pi pre_tool script task fails', () => {
    const repo = tmpRepo({
      preflight: {
        type: 'script',
        command: './script/preflight'
      }
    }, ['preflight'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const event = normalizePiToolCall({
        toolName: 'write',
        input: { path: 'src/app.js' }
      }, { cwd: repo })
      const taskPort = {
        run () {
          return {
            pass: false,
            reason: 'Run ./script/preflight and fix the reported errors before retrying.'
          }
        }
      }

      const effect = runWorkflowEngine({
        event,
        effectiveConfig,
        adapterCapabilities: piCapabilities(),
        taskPort
      })

      assert.strictEqual(effect.effect, 'block')
      assert.match(effect.reason, /preflight/)
      assert.match(effect.reason, /Run \.\/script\/preflight/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('invokes script tasks with the normalized event and effective config context', () => {
    const repo = tmpRepo({
      preflight: {
        type: 'script',
        command: './script/preflight',
        timeout_ms: 1234
      }
    }, ['preflight'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const adapterCapabilities = piCapabilities()
      const statePort = { read: () => ({}) }
      const event = normalizePiToolCall({
        toolName: 'edit',
        input: { path: 'src/app.js' },
        session_id: 'session-123'
      }, { cwd: repo })
      let callContext
      const taskPort = {
        run (context) {
          callContext = context
          return { pass: true }
        }
      }

      runWorkflowEngine({
        event,
        effectiveConfig,
        adapterCapabilities,
        statePort,
        taskPort
      })

      assert.strictEqual(callContext.taskName, 'preflight')
      assert.deepStrictEqual(callContext.task, effectiveConfig.tasks.preflight)
      assert.strictEqual(callContext.event, event)
      assert.strictEqual(callContext.normalizedEvent, event)
      assert.strictEqual(callContext.config, effectiveConfig)
      assert.strictEqual(callContext.effectiveConfig, effectiveConfig)
      assert.strictEqual(callContext.adapterCapabilities, adapterCapabilities)
      assert.strictEqual(callContext.statePort, statePort)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('runs pre_tool tasks in order and stops at the first script failure', () => {
    const repo = tmpRepo({
      first: {
        type: 'script',
        command: './script/first'
      },
      second: {
        type: 'script',
        command: './script/second'
      },
      third: {
        type: 'script',
        command: './script/third'
      }
    }, ['first', 'second', 'third'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const event = normalizePiToolCall({
        toolName: 'edit',
        input: { path: 'src/app.js' }
      }, { cwd: repo })
      const order = []
      const taskPort = {
        run ({ taskName }) {
          order.push(taskName)
          if (taskName === 'second') return { pass: false, reason: 'second failed' }
          return { pass: true }
        }
      }

      const effect = runWorkflowEngine({
        event,
        effectiveConfig,
        adapterCapabilities: piCapabilities(),
        taskPort
      })

      assert.deepStrictEqual(order, ['first', 'second'])
      assert.strictEqual(effect.effect, 'block')
      assert.match(effect.reason, /second failed/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not run completion verification until the done signal is active', () => {
    const repo = tmpCompletionRepo()

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const taskPort = { run: () => assert.fail('agent_end workflow should be signal-gated by done') }

      const effect = runWorkflowEngine({
        event: agentEndEvent('claude', repo),
        effectiveConfig,
        adapterCapabilities: {
          completion_verification: behaviorForCapability('claude', 'completion_verification')
        },
        statePort: createMemoryStatePort(),
        taskPort
      })

      assert.deepStrictEqual(effect, { effect: 'allow' })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('passing completion verification clears the done signal', () => {
    const repo = tmpCompletionRepo()

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
      const taskPort = { run: () => ({ pass: true }) }

      const effect = runWorkflowEngine({
        event: agentEndEvent('claude', repo),
        effectiveConfig,
        adapterCapabilities: {
          completion_verification: behaviorForCapability('claude', 'completion_verification')
        },
        statePort,
        taskPort
      })

      assert.strictEqual(effect.effect, 'approve')
      assert.strictEqual(effect.signalLifecycle.action, 'clear')
      assert.strictEqual(readSignal(statePort, 'session-123'), null)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('remediation-only completion verification fails with a remediation effect and preserves the done signal', () => {
    const repo = tmpCompletionRepo()

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort({}, { requireSessionId: false })
      statePort.writeSignal(null, { type: 'done', message: 'ready', at: 123 })
      const taskPort = {
        run () {
          return { pass: false, reason: 'reviewer found missing tests' }
        }
      }

      const effect = runWorkflowEngine({
        event: agentEndEvent('pi', repo, null),
        effectiveConfig,
        adapterCapabilities: {
          completion_verification: behaviorForCapability('pi', 'completion_verification')
        },
        statePort,
        taskPort
      })

      assert.strictEqual(effect.effect, 'remediation')
      assert.match(effect.message, /reviewer found missing tests/)
      assert.strictEqual(effect.enforcement, 'remediation')
      assert.deepStrictEqual(readSignal(statePort, null), { type: 'done', message: 'ready', at: 123 })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('hard-block capable completion verification fails with a fail effect and preserves the done signal', () => {
    const repo = tmpCompletionRepo()

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
      const taskPort = {
        run () {
          return { pass: false, reason: 'tests failed' }
        }
      }

      const effect = runWorkflowEngine({
        event: agentEndEvent('claude', repo),
        effectiveConfig,
        adapterCapabilities: {
          completion_verification: behaviorForCapability('claude', 'completion_verification')
        },
        statePort,
        taskPort
      })

      assert.strictEqual(effect.effect, 'fail')
      assert.match(effect.reason, /tests failed/)
      assert.strictEqual(effect.enforcement, 'hard_block')
      assert.deepStrictEqual(readSignal(statePort, 'session-123'), { type: 'done', message: 'ready', at: 123 })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('records prove_it signal commands through the shared state port before task workflow evaluation', () => {
    const repo = tmpRepo({
      shouldNotRun: {
        type: 'script',
        command: 'exit 1'
      }
    }, ['shouldNotRun'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      const taskPort = { run: () => assert.fail('signal interception should not run script tasks') }
      const effect = runWorkflowEngine({
        event: normalizePiToolCall({
          toolName: 'Bash',
          input: { command: 'prove_it signal done --message "ready"' },
          session_id: 'session-123'
        }, { cwd: repo }),
        effectiveConfig,
        adapterCapabilities: piCapabilities(),
        statePort,
        taskPort
      })

      const signal = readSignal(statePort, 'session-123')
      assert.strictEqual(effect.effect, 'allow')
      assert.match(effect.reason, /signal "done" recorded/)
      assert.strictEqual(signal.type, 'done')
      assert.strictEqual(signal.message, 'ready')
      assert.strictEqual(typeof signal.at, 'number')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not import Claude hook protocol rendering in the shared engine', () => {
    const source = fs.readFileSync(path.join(__dirname, '../lib/redesign/engine.js'), 'utf8')

    assert.doesNotMatch(source, /dispatcher\/protocol/)
    assert.doesNotMatch(source, /permissionDecision/)
    assert.doesNotMatch(source, /hookSpecificOutput/)
  })
})
