const { behaviorForCapability } = require('../../adapter_capabilities')
const { loadProjectConfig } = require('../../redesign/config')
const { normalizeLifecycleEvent, normalizePiToolCall } = require('../../redesign/events')
const { runWorkflowEngine } = require('../../redesign/engine')
const { createPiReviewerPort, createPiTaskPort } = require('./task_port')
const { createAdapterStatePort, createObjectStatePort, createStatePort } = require('../../redesign/state_port')
const { VALID_SIGNALS, readSignal, setSignal } = require('../../redesign/signal_lifecycle')

const PI_STATE_ENTRY = 'prove_it_state'
const PI_REMEDIATION_STATE_KEY = 'pi_completion_remediation'

function renderToolCallEffect (effect) {
  if (!effect || effect.effect === 'allow') return undefined
  if (effect.effect === 'block') {
    return { block: true, reason: effect.reason }
  }
  return undefined
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function readPiStateFromEntries (ctx = {}) {
  const entries = typeof ctx.sessionManager?.getEntries === 'function'
    ? ctx.sessionManager.getEntries()
    : []
  if (!Array.isArray(entries)) return {}

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type === 'custom' && entry.customType === PI_STATE_ENTRY && isObject(entry.data)) {
      return clone(entry.data)
    }
  }
  return {}
}

function appendPiStateEntry (pi, state) {
  if (!pi || typeof pi.appendEntry !== 'function') return false
  pi.appendEntry(PI_STATE_ENTRY, clone(state))
  return true
}

function createPiStatePort (pi, ctx = {}) {
  const adapterStatePort = createAdapterStatePort(ctx)
  if (adapterStatePort) return adapterStatePort
  if (!pi || typeof pi.appendEntry !== 'function' || typeof ctx.sessionManager?.getEntries !== 'function') return null

  return createStatePort({
    requireSessionId: false,
    readSessionState (sessionId, key) {
      return createObjectStatePort(readPiStateFromEntries(ctx), { requireSessionId: false })
        .readSessionState(sessionId, key)
    },
    writeSessionState (sessionId, key, value) {
      const state = readPiStateFromEntries(ctx)
      const port = createObjectStatePort(state, { requireSessionId: false })
      if (!port.writeSessionState(sessionId, key, value)) return false
      return appendPiStateEntry(pi, state)
    }
  })
}

function signalToolText (result, type) {
  if (result.ok) return `prove_it: signal "${type}" recorded`
  if (result.reason === 'invalid_signal') return `prove_it: invalid signal "${type}". Expected one of: ${VALID_SIGNALS.join(', ')}`
  return 'prove_it: signal could not be recorded because Pi session state is unavailable'
}

function signalToolResult (result, type) {
  const isError = !result.ok
  return {
    content: [{ type: 'text', text: signalToolText(result, type) }],
    details: {
      ok: result.ok,
      reason: result.reason,
      signal: result.signal
    },
    ...(isError ? { isError } : {})
  }
}

async function handleSignalTool (params = {}, ctx = {}, pi = null) {
  const type = params.signal || params.type
  const result = setSignal(createPiStatePort(pi, ctx), null, type, params.message)
  return signalToolResult(result, type)
}

async function handleToolCall (event, ctx = {}, pi = null) {
  const cwd = ctx.cwd || event?.cwd || process.cwd()
  let config

  try {
    config = loadProjectConfig(cwd)
  } catch (error) {
    return {
      block: true,
      reason: `prove_it: invalid .prove_it/config.json: ${error.message}`
    }
  }

  if (!config) return undefined

  const normalizedEvent = normalizePiToolCall(event, { ...ctx, cwd })
  const effect = runWorkflowEngine({
    event: normalizedEvent,
    effectiveConfig: config,
    adapterCapabilities: {
      pre_tool_blocking: behaviorForCapability('pi', 'pre_tool_blocking')
    },
    taskPort: ctx.taskPort || ctx.taskRunnerPort || createPiTaskPort(pi, ctx),
    reviewerPort: ctx.reviewerPort || ctx.reviewerRunnerPort || createPiReviewerPort(pi, ctx),
    statePort: createPiStatePort(pi, ctx)
  })
  return renderToolCallEffect(effect)
}

function remediationMessage (effect) {
  return [
    'prove_it completion verification failed:',
    '',
    effect.message || effect.reason || 'Completion verification failed.',
    '',
    'The done signal is preserved. Fix the issues, run focused verification, then call prove_it_signal with signal="done" again.'
  ].join('\n')
}

async function queueRemediation (pi, ctx, effect) {
  const sendUserMessage = typeof ctx?.sendUserMessage === 'function'
    ? ctx.sendUserMessage.bind(ctx)
    : typeof pi?.sendUserMessage === 'function'
      ? pi.sendUserMessage.bind(pi)
      : null
  if (!sendUserMessage) return false
  await sendUserMessage(remediationMessage(effect), { deliverAs: 'followUp', triggerTurn: true })
  return true
}

function readStateValue (statePort, sessionId, key) {
  if (!statePort || typeof statePort.readSessionState !== 'function') return null
  return statePort.readSessionState(sessionId, key)
}

function writeStateValue (statePort, sessionId, key, value) {
  if (!statePort || typeof statePort.writeSessionState !== 'function') return false
  return statePort.writeSessionState(sessionId, key, value)
}

function remediationKey (effect, signal) {
  if (signal?.type === 'done') return `done:${signal.at}:${signal.message || ''}`
  return `effect:${effect?.message || effect?.reason || 'completion verification failed'}`
}

function alreadyRemediatedForKey (statePort, sessionId, key) {
  const state = readStateValue(statePort, sessionId, PI_REMEDIATION_STATE_KEY)
  return isObject(state) && state.key === key && (state.status === 'queued' || state.status === 'delivered')
}

function currentDoneSignal (statePort, sessionId) {
  const signal = readSignal(statePort, sessionId)
  return signal?.type === 'done' ? signal : null
}

function completionAlreadyRemediated (statePort, sessionId) {
  const signal = currentDoneSignal(statePort, sessionId)
  return signal ? alreadyRemediatedForKey(statePort, sessionId, remediationKey(null, signal)) : false
}

function markRemediation (statePort, sessionId, key, status, effect) {
  writeStateValue(statePort, sessionId, PI_REMEDIATION_STATE_KEY, {
    key,
    status,
    message: effect?.message || effect?.reason || null,
    at: Date.now()
  })
}

async function queueRemediationOnce (pi, ctx, effect, statePort, sessionId) {
  const signal = currentDoneSignal(statePort, sessionId)
  const key = remediationKey(effect, signal)
  if (alreadyRemediatedForKey(statePort, sessionId, key)) return false

  markRemediation(statePort, sessionId, key, 'queued', effect)
  const queued = await queueRemediation(pi, ctx, effect)
  if (queued) markRemediation(statePort, sessionId, key, 'delivered', effect)
  return queued
}

async function runCompletionVerification (event, ctx = {}, pi = null, options = {}) {
  const cwd = ctx.cwd || event?.cwd || process.cwd()
  const statePort = createPiStatePort(pi, ctx)
  const sessionId = ctx.sessionId || ctx.session_id || event?.sessionId || event?.session_id || null

  if (completionAlreadyRemediated(statePort, sessionId)) return { effect: 'allow' }

  let config
  try {
    config = loadProjectConfig(cwd)
  } catch (error) {
    const effect = {
      effect: 'remediation',
      message: `prove_it: invalid .prove_it/config.json: ${error.message}`
    }
    if (options.queueRemediation) await queueRemediationOnce(pi, ctx, effect, statePort, sessionId)
    return effect
  }

  if (!config) return { effect: 'allow' }

  const normalizedEvent = normalizeLifecycleEvent({
    adapterId: 'pi',
    rawEventName: 'agent_end',
    rawEvent: event,
    ...ctx,
    cwd
  })
  const effect = runWorkflowEngine({
    event: normalizedEvent,
    effectiveConfig: config,
    adapterCapabilities: {
      completion_verification: behaviorForCapability('pi', 'completion_verification')
    },
    taskPort: ctx.taskPort || ctx.taskRunnerPort || createPiTaskPort(pi, ctx),
    reviewerPort: ctx.reviewerPort || ctx.reviewerRunnerPort || createPiReviewerPort(pi, ctx),
    statePort,
    effectPort: ctx.effectPort || ctx.effectsPort
  })

  if (effect.effect === 'remediation' && options.queueRemediation) {
    await queueRemediationOnce(pi, ctx, effect, statePort, normalizedEvent.sessionId)
  }
  return effect
}

async function handleTurnEnd (event, ctx = {}, pi = null) {
  return runCompletionVerification(event, ctx, pi, { queueRemediation: true })
}

async function handleAgentEnd (event, ctx = {}, pi = null) {
  return runCompletionVerification(event, ctx, pi, { queueRemediation: true })
}

module.exports = {
  PI_REMEDIATION_STATE_KEY,
  PI_STATE_ENTRY,
  createPiStatePort,
  handleAgentEnd,
  handleSignalTool,
  handleToolCall,
  handleTurnEnd,
  queueRemediation,
  remediationMessage,
  renderToolCallEffect
}
