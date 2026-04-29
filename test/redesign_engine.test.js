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
const { readPhase, setPhase } = require('../lib/redesign/phase_state')
const { createMemoryStatePort } = require('../lib/redesign/state_port')

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function tmpRepo (tasks = {
  protect_custom_config: {
    type: 'config_guard',
    protected_paths: ['.prove_it/config.json']
  }
}, preTool = ['protect_custom_config'], agentEnd = []) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_engine_'))
  writeJson(path.join(repo, '.prove_it', 'config.json'), {
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
  })
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

  it('does not run a Claude parity pre_tool task removed by local strict config', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_engine_claude_remove_'))

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        profile: 'claude',
        adapters: { claude: { enabled: true } }
      })
      writeJson(path.join(repo, '.prove_it', 'config.local.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        agent_workflows: {
          pre_tool: { remove: ['test_first'] }
        }
      })

      const effectiveConfig = loadProjectConfig(repo)
      const event = normalizeLifecycleEvent({
        adapterId: 'claude',
        rawEventName: 'PreToolUse',
        rawEvent: { session_id: 'session-1', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } },
        cwd: repo,
        projectDir: repo,
        rootDir: repo
      })
      const calls = []
      const effect = runWorkflowEngine({
        event,
        effectiveConfig,
        taskPort: {
          run (context) {
            calls.push(context)
            return { pass: true }
          }
        }
      })

      assert.deepStrictEqual(effect, { effect: 'allow' })
      assert.deepStrictEqual(calls, [])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('runs a locally shadowed Claude parity task definition at the inherited pipeline position', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_engine_claude_shadow_'))

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        profile: 'claude',
        adapters: { claude: { enabled: true } }
      })
      writeJson(path.join(repo, '.prove_it', 'config.local.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          test_first: {
            type: 'script',
            command: 'echo local test_first',
            matcher: 'Write',
            output: 'failures_only'
          }
        }
      })

      const effectiveConfig = loadProjectConfig(repo)
      const event = normalizeLifecycleEvent({
        adapterId: 'claude',
        rawEventName: 'PreToolUse',
        rawEvent: { session_id: 'session-1', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } },
        cwd: repo,
        projectDir: repo,
        rootDir: repo
      })
      const calls = []
      const effect = runWorkflowEngine({
        event,
        effectiveConfig,
        taskPort: {
          run (context) {
            calls.push({ taskName: context.taskName, command: context.task.command })
            return { pass: true, reason: 'ok' }
          }
        }
      })

      assert.strictEqual(effect.effect, 'allow')
      assert.deepStrictEqual(calls, [{ taskName: 'test_first', command: 'echo local test_first' }])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('suppresses routine pass output for failures-only script tasks without hiding failures', () => {
    const repo = tmpRepo({
      quiet_preflight: {
        type: 'script',
        command: './script/preflight',
        output: 'failures_only'
      }
    }, ['quiet_preflight'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const event = normalizePiToolCall({
        toolName: 'edit',
        input: { path: 'src/app.js' }
      }, { cwd: repo })

      const passEffect = runWorkflowEngine({
        event,
        effectiveConfig,
        adapterCapabilities: piCapabilities(),
        taskPort: { run: () => ({ pass: true, reason: 'passed', output: 'noisy pass details' }) }
      })
      assert.strictEqual(passEffect.effect, 'allow')
      assert.strictEqual(passEffect.reason, undefined)
      assert.strictEqual(passEffect.routineOutputSuppressed, true)

      const failEffect = runWorkflowEngine({
        event,
        effectiveConfig,
        adapterCapabilities: piCapabilities(),
        taskPort: { run: () => ({ pass: false, reason: 'important failure' }) }
      })
      assert.strictEqual(failEffect.effect, 'block')
      assert.match(failEffect.reason, /quiet_preflight/)
      assert.match(failEffect.reason, /important failure/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('suppresses skipped-task context for failures-only tasks', () => {
    const repo = tmpRepo({
      quiet_skip: {
        type: 'config_guard',
        output: 'failures_only',
        when: { phase: 'refactor' }
      }
    }, ['quiet_skip'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      assert.strictEqual(setPhase(statePort, 'session-123', 'implement', { now: 123 }).ok, true)
      const effect = runWorkflowEngine({
        event: normalizePiToolCall({
          toolName: 'edit',
          input: { path: 'src/app.js' },
          session_id: 'session-123'
        }, { cwd: repo }),
        effectiveConfig,
        statePort,
        taskPort: { run: () => assert.fail('phase-gated tasks should skip') }
      })

      assert.strictEqual(effect.effect, 'allow')
      assert.strictEqual(effect.skipped, undefined)
      assert.strictEqual(effect.routineOutputSuppressed, true)
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
      const cfgPath = path.join(repo, '.prove_it', 'config.json')
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      raw.tasks.completion_check.output = 'failures_only'
      fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2))
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

  it('records prove_it phase commands through shared state before task workflow evaluation', () => {
    const repo = tmpRepo({
      shouldNotRun: {
        type: 'script',
        command: 'exit 1'
      }
    }, ['shouldNotRun'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      const taskPort = { run: () => assert.fail('phase interception should not run script tasks') }
      const effect = runWorkflowEngine({
        event: normalizePiToolCall({
          toolName: 'Bash',
          input: { command: 'prove_it phase refactor' },
          session_id: 'session-123'
        }, { cwd: repo }),
        effectiveConfig,
        adapterCapabilities: piCapabilities(),
        statePort,
        taskPort
      })

      assert.strictEqual(effect.effect, 'allow')
      assert.match(effect.reason, /phase "refactor" recorded/)
      assert.match(effect.systemMessage, /continue/)
      assert.strictEqual(readPhase(statePort, 'session-123'), 'refactor')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('falls through for unknown prove_it phase commands without corrupting phase state', () => {
    const repo = tmpRepo({
      bash_task: {
        type: 'script',
        command: './script/preflight',
        matcher: 'Bash'
      }
    }, ['bash_task'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      assert.strictEqual(setPhase(statePort, 'session-123', 'implement', { now: 123 }).ok, true)
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }
      const effect = runWorkflowEngine({
        event: normalizePiToolCall({
          toolName: 'Bash',
          input: { command: 'prove_it phase design' },
          session_id: 'session-123'
        }, { cwd: repo }),
        effectiveConfig,
        adapterCapabilities: piCapabilities(),
        statePort,
        taskPort
      })

      assert.strictEqual(effect.effect, 'allow')
      assert.deepStrictEqual(calls, ['bash_task'])
      assert.strictEqual(readPhase(statePort, 'session-123'), 'implement')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('sets plan phase on EnterPlanMode and still runs matching pre_tool tasks', () => {
    const repo = tmpRepo({
      plan_entry: {
        type: 'script',
        command: './script/plan-entry',
        matcher: 'EnterPlanMode'
      }
    }, ['plan_entry'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }
      const effect = runWorkflowEngine({
        event: normalizeLifecycleEvent({
          adapterId: 'claude',
          rawEventName: 'PreToolUse',
          rawEvent: { tool_name: 'EnterPlanMode', tool_input: {}, session_id: 'session-123' },
          cwd: repo
        }),
        effectiveConfig,
        statePort,
        taskPort
      })

      assert.strictEqual(effect.effect, 'allow')
      assert.deepStrictEqual(calls, ['plan_entry'])
      assert.strictEqual(readPhase(statePort, 'session-123'), 'plan')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('matches tasks gated by the clean phase condition and reports skipped phase mismatches', () => {
    const repo = tmpRepo({
      implement_check: {
        type: 'script',
        command: './script/implement',
        when: { phase: 'implement' }
      },
      refactor_check: {
        type: 'script',
        command: './script/refactor',
        when: { phase: 'refactor' }
      }
    }, ['implement_check', 'refactor_check'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      assert.strictEqual(setPhase(statePort, 'session-123', 'implement', { now: 123 }).ok, true)
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }

      const effect = runWorkflowEngine({
        event: normalizePiToolCall({
          toolName: 'edit',
          input: { path: 'src/app.js' },
          session_id: 'session-123'
        }, { cwd: repo }),
        effectiveConfig,
        statePort,
        taskPort
      })

      assert.strictEqual(effect.effect, 'allow')
      assert.deepStrictEqual(calls, ['implement_check'])
      assert.deepStrictEqual(effect.skipped.map(skip => skip.taskName), ['refactor_check'])
      assert.match(effect.skipped[0].reason, /phase is "implement", not "refactor"/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('resets phase to unknown after successful done completion verification only', () => {
    const repo = tmpCompletionRepo(['completion_check', 'stuck_check'])
    const cfgPath = path.join(repo, '.prove_it', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.tasks.stuck_check = { type: 'script', command: './script/stuck', when: { signal: 'stuck' } }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      const taskPort = { run: () => ({ pass: true }) }
      const capabilities = { completion_verification: behaviorForCapability('claude', 'completion_verification') }

      statePort.writeSignal('done-session', { type: 'done', message: null, at: 123 })
      setPhase(statePort, 'done-session', 'implement', { now: 123 })
      const doneEffect = runWorkflowEngine({
        event: agentEndEvent('claude', repo, 'done-session'),
        effectiveConfig,
        adapterCapabilities: capabilities,
        statePort,
        taskPort
      })
      assert.strictEqual(doneEffect.effect, 'approve')
      assert.strictEqual(readPhase(statePort, 'done-session'), 'unknown')

      statePort.writeSignal('stuck-session', { type: 'stuck', message: null, at: 456 })
      setPhase(statePort, 'stuck-session', 'refactor', { now: 456 })
      const stuckEffect = runWorkflowEngine({
        event: agentEndEvent('claude', repo, 'stuck-session'),
        effectiveConfig,
        adapterCapabilities: capabilities,
        statePort,
        taskPort
      })
      assert.strictEqual(stuckEffect.effect, 'approve')
      assert.strictEqual(readPhase(statePort, 'stuck-session'), 'refactor')
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

  it('skips signal-gated tasks unless the active signal matches and reports the skip without running the task', () => {
    const repo = tmpRepo({
      done_check: {
        type: 'script',
        command: './script/done',
        when: { signal: 'done' }
      },
      stuck_check: {
        type: 'script',
        command: './script/stuck',
        when: { signal: 'stuck' }
      }
    }, ['done_check', 'stuck_check'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const statePort = createMemoryStatePort()
      const event = normalizePiToolCall({
        toolName: 'edit',
        input: { path: 'src/app.js' },
        session_id: 'session-123'
      }, { cwd: repo })
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }

      const noSignal = runWorkflowEngine({ event, effectiveConfig, statePort, taskPort })
      statePort.writeSignal('session-123', { type: 'stuck', message: 'blocked', at: 123 })
      const stuck = runWorkflowEngine({ event, effectiveConfig, statePort, taskPort })
      statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 456 })
      const done = runWorkflowEngine({ event, effectiveConfig, statePort, taskPort })

      assert.strictEqual(noSignal.effect, 'allow')
      assert.deepStrictEqual(noSignal.skipped.map(skip => skip.taskName), ['done_check', 'stuck_check'])
      assert.deepStrictEqual(calls, ['stuck_check', 'done_check'])
      assert.strictEqual(stuck.effect, 'allow')
      assert.deepStrictEqual(stuck.skipped.map(skip => skip.taskName), ['done_check'])
      assert.strictEqual(done.effect, 'allow')
      assert.deepStrictEqual(done.skipped.map(skip => skip.taskName), ['stuck_check'])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('classifies edited source and test files with strict globs before running when-gated tasks', () => {
    const repo = tmpRepo({
      source_check: {
        type: 'script',
        command: './script/source',
        when: { sourceFilesEdited: true }
      },
      test_check: {
        type: 'script',
        command: './script/test',
        when: { testFilesEdited: true }
      }
    }, ['source_check', 'test_check'])
    const cfgPath = path.join(repo, '.prove_it', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.globs = { source: ['src/**/*.js'], test: ['test/**/*.test.js'] }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }

      const sourceEdit = runWorkflowEngine({
        event: normalizePiToolCall({ toolName: 'edit', input: { path: 'src/app.js' } }, { cwd: repo }),
        effectiveConfig,
        taskPort
      })
      const testEdit = runWorkflowEngine({
        event: normalizePiToolCall({ toolName: 'edit', input: { path: 'test/app.test.js' } }, { cwd: repo }),
        effectiveConfig,
        taskPort
      })

      assert.deepStrictEqual(calls, ['source_check', 'test_check'])
      assert.deepStrictEqual(sourceEdit.skipped.map(skip => skip.taskName), ['test_check'])
      assert.deepStrictEqual(testEdit.skipped.map(skip => skip.taskName), ['source_check'])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('uses Claude adapter file-editing tool config for direct edited-file event fallback only on Claude events', () => {
    const repo = tmpRepo({
      source_check: {
        type: 'script',
        command: './script/source',
        when: { sourceFilesEdited: true }
      }
    }, ['source_check'])
    const cfgPath = path.join(repo, '.prove_it', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.globs = { source: ['src/**/*.js'], test: ['test/**/*.test.js'] }
    cfg.adapters.claude = {
      enabled: true,
      file_editing_tools: ['mcp__filesystem__write_file']
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }

      const claudeEffect = runWorkflowEngine({
        event: normalizeLifecycleEvent({
          adapterId: 'claude',
          rawEventName: 'PreToolUse',
          rawEvent: {
            tool_name: 'MCP__FILESYSTEM__WRITE_FILE',
            tool_input: { file_path: 'src/app.js' }
          },
          cwd: repo
        }),
        effectiveConfig,
        taskPort
      })
      const piEffect = runWorkflowEngine({
        event: normalizePiToolCall({
          toolName: 'mcp__filesystem__write_file',
          input: { path: 'src/app.js' }
        }, { cwd: repo }),
        effectiveConfig,
        taskPort
      })

      assert.deepStrictEqual(calls, ['source_check'])
      assert.strictEqual(claudeEffect.effect, 'allow')
      assert.strictEqual(piEffect.effect, 'allow')
      assert.deepStrictEqual(piEffect.skipped.map(skip => skip.taskName), ['source_check'])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('uses injected observation facts for edited-file conditions when adapter observation recording is not present', () => {
    const repo = tmpRepo({
      source_check: {
        type: 'script',
        command: './script/source',
        when: { sourceFilesEdited: true }
      },
      test_check: {
        type: 'script',
        command: './script/test',
        when: { testFilesEdited: true }
      }
    }, ['source_check', 'test_check'])
    const cfgPath = path.join(repo, '.prove_it', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.globs = { source: ['src/**/*.js'], test: ['test/**/*.test.js'] }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }
      const observationPort = {
        getFacts () {
          return { editedFiles: ['test/app.test.js'] }
        }
      }

      const effect = runWorkflowEngine({
        event: normalizePiToolCall({ toolName: 'custom_observer_only_tool', input: {} }, { cwd: repo }),
        effectiveConfig,
        taskPort,
        observationPort
      })

      assert.deepStrictEqual(calls, ['test_check'])
      assert.deepStrictEqual(effect.skipped.map(skip => skip.taskName), ['source_check'])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('supports sources-modified-since-last-run facts without running skipped tasks', () => {
    const repo = tmpRepo({
      stale_check: {
        type: 'script',
        command: './script/stale',
        when: { sourcesModifiedSinceLastRun: true }
      },
      fresh_check: {
        type: 'script',
        command: './script/fresh',
        when: { sourcesModifiedSinceLastRun: true }
      }
    }, ['stale_check', 'fresh_check'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }
      const observationPort = {
        getFacts () {
          return {
            sourcesModifiedSinceLastRun: {
              stale_check: { modified: false, evidence: 'last passing run covers current source snapshot' },
              fresh_check: { modified: true, evidence: 'src/app.js changed after last passing run' }
            }
          }
        }
      }

      const effect = runWorkflowEngine({
        event: normalizePiToolCall({ toolName: 'edit', input: { path: 'README.md' } }, { cwd: repo }),
        effectiveConfig,
        taskPort,
        observationPort
      })

      assert.deepStrictEqual(calls, ['fresh_check'])
      assert.deepStrictEqual(effect.skipped.map(skip => skip.taskName), ['stale_check'])
      assert.match(effect.skipped[0].reason, /no sources were modified since the last run/)
      assert.match(effect.skipped[0].evidence, /last passing run covers/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('evaluates net linesChanged and gross linesWritten churn thresholds with explicit semantics', () => {
    const repo = tmpRepo({
      net_check: {
        type: 'script',
        command: './script/net',
        when: { linesChanged: 5 }
      },
      net_pass: {
        type: 'script',
        command: './script/net-pass',
        when: { linesChanged: 4 }
      },
      gross_check: {
        type: 'script',
        command: './script/gross',
        when: { linesWritten: 10 }
      },
      gross_fail: {
        type: 'script',
        command: './script/gross-fail',
        when: { linesWritten: 13 }
      }
    }, ['net_check', 'net_pass', 'gross_check', 'gross_fail'])

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const calls = []
      const taskPort = { run: ({ taskName }) => { calls.push(taskName); return { pass: true } } }
      const observationPort = {
        getFacts () {
          return {
            churn: {
              netLinesChanged: { net_check: 4, net_pass: 4, gross_check: 4, gross_fail: 4 },
              grossLinesWritten: { net_check: 12, net_pass: 12, gross_check: 12, gross_fail: 12 }
            }
          }
        }
      }

      const effect = runWorkflowEngine({
        event: normalizePiToolCall({ toolName: 'edit', input: { path: 'src/app.js' } }, { cwd: repo }),
        effectiveConfig,
        taskPort,
        observationPort
      })

      assert.deepStrictEqual(calls, ['net_pass', 'gross_check'])
      assert.deepStrictEqual(effect.skipped.map(skip => skip.taskName), ['net_check', 'gross_fail'])
      assert.match(effect.skipped[0].reason, /only 4 of 5 net lines changed/)
      assert.strictEqual(effect.skipped[0].semantics, 'net:additions_plus_deletions_since_last_successful_run')
      assert.match(effect.skipped[1].reason, /only 12 of 13 gross lines were written/)
      assert.strictEqual(effect.skipped[1].semantics, 'gross:lines_written_by_edit_observations_since_last_successful_run')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('runs clean session_env tasks on startup/resume and emits parsed env_update effects without blocking', () => {
    const repo = tmpRepo({
      json_env: { type: 'session_env', command: './script/json-env' },
      shell_env: { type: 'session_env', command: './script/shell-env' },
      bad_env: { type: 'session_env', command: './script/bad-env' },
      failing_env: { type: 'session_env', command: './script/failing-env' }
    }, [], [])
    const cfgPath = path.join(repo, '.prove_it', 'config.json')
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    raw.agent_workflows.session_start = ['json_env', 'shell_env', 'bad_env', 'failing_env']
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2))

    try {
      const effectiveConfig = loadProjectConfig(repo)
      const calls = []
      const event = normalizeLifecycleEvent({
        adapterId: 'claude',
        rawEventName: 'SessionStart',
        rawEvent: { session_id: 'session-123', source: 'startup' },
        cwd: repo
      })
      const effect = runWorkflowEngine({
        event,
        effectiveConfig,
        adapterCapabilities: { session_env: { supported: true } },
        taskPort: {
          runSessionEnvTask ({ taskName }) {
            calls.push(taskName)
            if (taskName === 'json_env') return { pass: true, stdout: '{"FOO":"bar"}' }
            if (taskName === 'shell_env') return { pass: true, stdout: 'export API_BASE_URL="http://localhost:3000"' }
            if (taskName === 'bad_env') return { pass: true, stdout: '{"123BAD":"nope"}' }
            return { pass: false, exitCode: 7, stdout: '', stderr: 'boom' }
          }
        }
      })

      assert.strictEqual(effect.effect, 'batch')
      assert.deepStrictEqual(calls, ['json_env', 'shell_env', 'bad_env', 'failing_env'])
      const envUpdates = effect.effects.filter(item => item.effect === 'env_update').map(item => item.env)
      assert.deepStrictEqual(envUpdates, [
        { PROVE_IT_SESSION_ID: 'session-123' },
        { FOO: 'bar' },
        { API_BASE_URL: 'http://localhost:3000' }
      ])
      const diagnostics = effect.effects.map(item => item.context || item.reason || item.message || '').join('\n')
      assert.match(diagnostics, /session_env task "bad_env" failed to parse output/)
      assert.match(diagnostics, /invalid variable name "123BAD"/)
      assert.match(diagnostics, /session_env task "failing_env" failed/)
      assert.match(diagnostics, /boom/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('skips session_env tasks on clear and reports non-Claude SessionStart env degradation clearly', () => {
    const repo = tmpRepo({
      load_env: { type: 'session_env', command: './script/session-env' }
    }, [], [])
    const cfgPath = path.join(repo, '.prove_it', 'config.json')
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    raw.agent_workflows.session_start = ['load_env']
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2))

    try {
      const effectiveConfig = loadProjectConfig(repo)
      let calls = 0
      const taskPort = {
        runSessionEnvTask () {
          calls += 1
          return { pass: true, stdout: 'FOO=bar' }
        }
      }

      const clear = runWorkflowEngine({
        event: normalizeLifecycleEvent({
          adapterId: 'claude',
          rawEventName: 'SessionStart',
          rawEvent: { session_id: 'clear-session', source: 'clear' },
          cwd: repo
        }),
        effectiveConfig,
        adapterCapabilities: { session_env: { supported: true } },
        taskPort
      })
      assert.strictEqual(calls, 0)
      assert.strictEqual(clear.effects.some(item => item.effect === 'env_update'), false)

      const pi = runWorkflowEngine({
        event: normalizeLifecycleEvent({
          adapterId: 'pi',
          rawEventName: 'before_agent_start',
          rawEvent: { source: 'startup' },
          cwd: repo
        }),
        effectiveConfig,
        adapterCapabilities: {},
        taskPort
      })
      assert.strictEqual(calls, 0)
      assert.strictEqual(pi.effects.some(item => item.effect === 'env_update' && item.env.FOO === 'bar'), false)
      assert.match(pi.effects.map(item => item.context || '').join('\n'), /adapter "pi" does not support session_env delivery/)
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
