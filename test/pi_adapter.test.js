const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

function tmpRepo () {
  const { PROFILE_VERSION } = require('../lib/redesign/config')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_pi_'))
  fs.mkdirSync(path.join(dir, '.prove_it'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.prove_it', 'config.json'), JSON.stringify({
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    tasks: {
      protect_prove_it_config: {
        type: 'config_guard',
        protected_paths: ['.prove_it/config.json', '.prove_it/config.local.json']
      }
    },
    agent_workflows: {
      pre_tool: ['protect_prove_it_config']
    }
  }, null, 2))
  return dir
}

function fakePi () {
  const handlers = {}
  const tools = {}
  const entries = []
  const sentUserMessages = []
  const pi = {
    handlers,
    tools,
    entries,
    sentUserMessages,
    on (eventName, handler) {
      handlers[eventName] = handler
    },
    registerTool (definition) {
      tools[definition.name] = definition
    },
    appendEntry (customType, data) {
      entries.push({ type: 'custom', customType, data })
    },
    async sendUserMessage (content, options) {
      await new Promise(resolve => setImmediate(resolve))
      sentUserMessages.push({ content, options })
    }
  }
  return pi
}

function fakePiCtx (pi, repo, extra = {}) {
  return {
    cwd: repo,
    sessionManager: {
      getEntries () {
        return pi.entries
      }
    },
    ...extra
  }
}

function tmpCompletionRepo () {
  const { PROFILE_VERSION } = require('../lib/redesign/config')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_pi_completion_'))
  fs.mkdirSync(path.join(dir, '.prove_it'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.prove_it', 'config.json'), JSON.stringify({
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    tasks: {
      completion_check: {
        type: 'script',
        command: './script/test_fast'
      }
    },
    agent_workflows: {
      pre_tool: [],
      agent_end: ['completion_check']
    },
    adapters: {
      pi: { enabled: true }
    }
  }, null, 2))
  return dir
}

describe('pi adapter pre-tool config guard', () => {
  it('loads a fake Pi extension and blocks edits to .prove_it/config.json', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const repo = tmpRepo()
    const pi = fakePi()
    registerPiExtension(pi)

    const result = await pi.handlers.tool_call({
      toolName: 'edit',
      input: { path: '.prove_it/config.json' }
    }, { cwd: repo })

    assert.deepStrictEqual(result, {
      block: true,
      reason: 'prove_it: Cannot modify protected prove_it config path .prove_it/config.json'
    })
  })

  it('blocks edits to .prove_it/config.local.json from Pi input.path payloads', async () => {
    const { handleToolCall } = require('../lib/adapters/pi/bridge')
    const repo = tmpRepo()

    const result = await handleToolCall({
      toolName: 'write',
      input: { path: path.join(repo, '.prove_it', 'config.local.json') }
    }, { cwd: repo })

    assert.strictEqual(result.block, true)
    assert.match(result.reason, /\.prove_it\/config\.local\.json/)
  })

  it('persists prove_it signal commands through Pi adapter-native state', async () => {
    const { handleToolCall } = require('../lib/adapters/pi/bridge')
    const { readSignal } = require('../lib/redesign/signal_lifecycle')
    const { createObjectStatePort } = require('../lib/redesign/state_port')
    const repo = tmpRepo()
    const state = {}
    const result = await handleToolCall({
      toolName: 'Bash',
      input: { command: 'prove_it signal done --message "ready"' }
    }, { cwd: repo, state })
    const statePort = createObjectStatePort(state, { requireSessionId: false })

    assert.strictEqual(result, undefined)
    assert.strictEqual(readSignal(statePort, null).type, 'done')
    assert.strictEqual(readSignal(statePort, null).message, 'ready')
  })

  it('recognizes Pi-style top-level path payloads', async () => {
    const { handleToolCall } = require('../lib/adapters/pi/bridge')
    const repo = tmpRepo()

    const result = await handleToolCall({
      toolName: 'edit',
      path: '.prove_it/config.json',
      input: {}
    }, { cwd: repo })

    assert.strictEqual(result.block, true)
  })

  it('emits an allow effect for unrelated Pi tool calls', () => {
    const { loadProjectConfig } = require('../lib/redesign/config')
    const { normalizePiToolCall } = require('../lib/redesign/events')
    const { runPreToolWorkflow } = require('../lib/redesign/engine')
    const repo = tmpRepo()

    const config = loadProjectConfig(repo)
    const event = normalizePiToolCall({
      toolName: 'edit',
      input: { path: 'src/app.js' }
    }, { cwd: repo })

    assert.deepStrictEqual(runPreToolWorkflow(config, event), {
      effect: 'allow'
    })
  })

  it('does not read legacy .claude/prove_it config for Pi tool calls', async () => {
    const { handleToolCall } = require('../lib/adapters/pi/bridge')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_pi_legacy_'))
    fs.mkdirSync(path.join(repo, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.claude', 'prove_it', 'config.json'), JSON.stringify({
      hooks: {
        pi: {
          tool_call: [{ name: 'legacy-guard', type: 'config_guard' }]
        }
      }
    }))

    const result = await handleToolCall({
      toolName: 'edit',
      input: { path: '.prove_it/config.json' }
    }, { cwd: repo })

    assert.strictEqual(result, undefined)
  })

  it('rejects hook-shaped legacy keys in the strict .prove_it config', () => {
    const { loadProjectConfig } = require('../lib/redesign/config')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_pi_strict_'))
    fs.mkdirSync(path.join(repo, '.prove_it'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.prove_it', 'config.json'), JSON.stringify({
      schema_version: 1,
      hooks: { pi: { tool_call: [] } },
      tasks: {},
      agent_workflows: { pre_tool: [] }
    }))

    assert.throws(
      () => loadProjectConfig(repo),
      /unknown top-level key "hooks"/
    )
  })

  it('injects minimal prove_it methodology guidance before the agent starts', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const pi = fakePi()
    registerPiExtension(pi)

    const result = await pi.handlers.before_agent_start({
      systemPrompt: 'Base system prompt'
    }, { cwd: process.cwd() })

    assert.match(result.systemPrompt, /Base system prompt/)
    const { renderMethodologySummary } = require('../lib/methodology')
    assert.match(result.systemPrompt, /prove_it methodology/)
    assert.match(result.systemPrompt, /verify claims with evidence/)
    assert.ok(result.systemPrompt.includes(renderMethodologySummary()), 'Pi guidance should render from shared methodology')
  })

  it('registers a model-callable prove_it_signal tool and persists done in Pi session entries', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const { createPiStatePort } = require('../lib/adapters/pi/bridge')
    const { readSignal } = require('../lib/redesign/signal_lifecycle')
    const repo = tmpRepo()
    const pi = fakePi()
    registerPiExtension(pi)

    assert.strictEqual(typeof pi.tools.prove_it_signal.execute, 'function')
    assert.match(pi.tools.prove_it_signal.description, /completion signal/i)

    const result = await pi.tools.prove_it_signal.execute(
      'tool-call-1',
      { signal: 'done', message: 'ready for verification' },
      undefined,
      undefined,
      fakePiCtx(pi, repo)
    )

    const signal = readSignal(createPiStatePort(pi, fakePiCtx(pi, repo)), null)
    assert.match(result.content[0].text, /signal "done" recorded/)
    assert.strictEqual(signal.type, 'done')
    assert.strictEqual(signal.message, 'ready for verification')
    assert.strictEqual(pi.entries.at(-1).customType, 'prove_it_state')
  })

  it('failed Pi agent_end verification returns remediation and preserves done', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const { createPiStatePort } = require('../lib/adapters/pi/bridge')
    const { readSignal } = require('../lib/redesign/signal_lifecycle')
    const repo = tmpCompletionRepo()
    const pi = fakePi()
    registerPiExtension(pi)
    const ctx = fakePiCtx(pi, repo, {
      taskPort: {
        run () {
          return { pass: false, reason: 'reviewer found missing tests' }
        }
      }
    })
    await pi.tools.prove_it_signal.execute('tool-call-1', { signal: 'done', message: 'ready' }, undefined, undefined, ctx)

    const effect = await pi.handlers.agent_end({ messages: [] }, ctx)

    assert.strictEqual(effect.effect, 'remediation')
    assert.strictEqual(readSignal(createPiStatePort(pi, ctx), null).type, 'done')
  })

  it('queues a remediation follow-up from Pi turn_end when completion verification fails', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const { createPiStatePort } = require('../lib/adapters/pi/bridge')
    const { readSignal } = require('../lib/redesign/signal_lifecycle')
    const repo = tmpCompletionRepo()
    const pi = fakePi()
    registerPiExtension(pi)
    const ctx = fakePiCtx(pi, repo, {
      taskPort: {
        run () {
          return { pass: false, reason: 'reviewer found missing tests' }
        }
      }
    })
    await pi.tools.prove_it_signal.execute('tool-call-1', { signal: 'done', message: 'ready' }, undefined, undefined, ctx)

    const effect = await pi.handlers.turn_end({ message: {}, toolResults: [] }, ctx)

    assert.strictEqual(effect.effect, 'remediation')
    assert.strictEqual(pi.sentUserMessages.length, 1)
    assert.match(pi.sentUserMessages[0].content, /reviewer found missing tests/)
    assert.match(pi.sentUserMessages[0].content, /done signal is preserved/)
    assert.deepStrictEqual(pi.sentUserMessages[0].options, { deliverAs: 'followUp', triggerTurn: true })
    assert.strictEqual(readSignal(createPiStatePort(pi, ctx), null).type, 'done')

    const agentEndEffect = await pi.handlers.agent_end({ messages: [] }, ctx)
    assert.strictEqual(agentEndEffect.effect, 'allow')
    assert.strictEqual(pi.sentUserMessages.length, 1)
  })

  it('prefers and awaits ctx.sendUserMessage when queueing remediation', async () => {
    const { queueRemediation } = require('../lib/adapters/pi/bridge')
    const repo = tmpCompletionRepo()
    const pi = fakePi()
    const ctxMessages = []
    let awaited = false
    const ctx = fakePiCtx(pi, repo, {
      async sendUserMessage (content, options) {
        await new Promise(resolve => setImmediate(resolve))
        ctxMessages.push({ content, options })
        awaited = true
      }
    })

    const queued = await queueRemediation(pi, ctx, {
      effect: 'remediation',
      message: 'focused verification failed'
    })

    assert.strictEqual(queued, true)
    assert.strictEqual(awaited, true)
    assert.strictEqual(ctxMessages.length, 1)
    assert.match(ctxMessages[0].content, /focused verification failed/)
    assert.deepStrictEqual(ctxMessages[0].options, { deliverAs: 'followUp', triggerTurn: true })
    assert.deepStrictEqual(pi.sentUserMessages, [])
  })

  it('does not repeat automatic remediation for the same done signal', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const repo = tmpCompletionRepo()
    const pi = fakePi()
    registerPiExtension(pi)
    let runs = 0
    const ctx = fakePiCtx(pi, repo, {
      taskPort: {
        run () {
          runs += 1
          return { pass: false, reason: `completion failure ${runs}` }
        }
      }
    })
    await pi.tools.prove_it_signal.execute('tool-call-1', { signal: 'done', message: 'ready' }, undefined, undefined, ctx)

    const first = await pi.handlers.turn_end({ turnIndex: 1, message: {}, toolResults: [] }, ctx)
    const second = await pi.handlers.turn_end({ turnIndex: 2, message: {}, toolResults: [] }, ctx)

    assert.strictEqual(first.effect, 'remediation')
    assert.strictEqual(second.effect, 'allow')
    assert.strictEqual(runs, 1)
    assert.strictEqual(pi.sentUserMessages.length, 1)

    await pi.tools.prove_it_signal.execute('tool-call-2', { signal: 'done', message: 'ready after remediation' }, undefined, undefined, ctx)
    const third = await pi.handlers.turn_end({ turnIndex: 3, message: {}, toolResults: [] }, ctx)

    assert.strictEqual(third.effect, 'remediation')
    assert.strictEqual(runs, 2)
    assert.strictEqual(pi.sentUserMessages.length, 2)
    assert.match(pi.sentUserMessages[1].content, /completion failure 2/)
  })

  it('clears done without queuing remediation after successful Pi turn_end verification', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const { createPiStatePort } = require('../lib/adapters/pi/bridge')
    const { readSignal } = require('../lib/redesign/signal_lifecycle')
    const repo = tmpCompletionRepo()
    const pi = fakePi()
    registerPiExtension(pi)
    const ctx = fakePiCtx(pi, repo, {
      taskPort: {
        run () {
          return { pass: true }
        }
      }
    })
    await pi.tools.prove_it_signal.execute('tool-call-1', { signal: 'done', message: 'ready' }, undefined, undefined, ctx)

    const effect = await pi.handlers.turn_end({ messages: [] }, ctx)

    assert.strictEqual(effect.effect, 'approve')
    assert.strictEqual(readSignal(createPiStatePort(pi, ctx), null), null)
    assert.deepStrictEqual(pi.sentUserMessages, [])
  })
})
