const fs = require('fs')

const { behaviorForCapability } = require('../../adapter_capabilities')
const { gitHead, gitRoot, gitStatusHash } = require('../../git')
const { clearDispatcherPid, logReview, SESSION_KEYS, writeDispatcherPid } = require('../../session')
const {
  SIGNAL_PLAN_MARKER,
  PHASE_PLAN_MARKER,
  SIGNAL_TASK_PATTERN,
  detectLastNumberedHeading,
  detectPlanPhase,
  buildSignalBlock,
  buildPhaseBlock,
  findPlanFile,
  appendPlanBlock
} = require('../../plan')
const { loadEffectiveConfig, projectConfigPath } = require('../../redesign/config')
const { readSignal, setSignal } = require('../../redesign/signal_lifecycle')
const { isSessionDisabled } = require('../../redesign/session_control')
const { normalizeLifecycleEvent } = require('../../redesign/events')
const { runWorkflowEngine } = require('../../redesign/engine')
const { recordObservationFacts } = require('../../redesign/observations')
const { createScriptTaskPort } = require('../../redesign/script_task_port')
const protocol = require('../../dispatcher/protocol')
const { emitClaudePreToolUseEffect, emitClaudeStopEffect } = require('./effects')
const { createClaudeBackchannelPort } = require('./backchannel_port')
const { createClaudeReviewerPort } = require('./reviewer_port')

function strictConfigDiagnostic (error) {
  return `⚠️ prove_it invalid strict .prove_it/config.json — Claude clean-runtime hooks are disabled until this is fixed.\n\n${error.message}`
}

function emitInvalidConfigDiagnostic (hookEvent, error, options = {}) {
  const message = strictConfigDiagnostic(error)

  if (hookEvent === 'SessionStart') {
    protocol.emitSessionStart({ additionalContext: message, systemMessage: message })
  } else if (hookEvent === 'PreToolUse') {
    protocol.emitPreToolUseContext(message, { systemMessage: message })
  } else if (hookEvent === 'PostToolUse') {
    protocol.emitPostToolUse({ additionalContext: message })
  } else if (hookEvent === 'PostToolUseFailure') {
    protocol.emitPostToolUseFailure({ additionalContext: message })
  } else if (hookEvent === 'Stop') {
    const signal = readSignal(options.statePort, options.sessionId)
    if (signal?.type === 'done') {
      emitClaudeStopEffect({
        effect: 'fail',
        reason: message,
        capability: 'completion_verification',
        enforcement: 'hard_block',
        signalLifecycle: {
          ok: true,
          action: 'preserve',
          signal
        }
      })
    } else {
      protocol.emitStop('approve', message, message)
    }
  }
}

function shellExportValue (value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

function writeClaudeEnvFile (vars, env = process.env) {
  const envFile = env.CLAUDE_ENV_FILE
  if (!envFile) {
    return {
      written: false,
      reason: 'CLAUDE_ENV_FILE is not set; prove_it could not export session environment variables.'
    }
  }

  const lines = Object.entries(vars).map(([key, value]) => `export ${key}="${shellExportValue(value)}"`)
  fs.appendFileSync(envFile, lines.join('\n') + '\n', 'utf8')
  return {
    written: true,
    vars: Object.keys(vars)
  }
}

function renderCleanClaudeEffect (hookEvent, effect) {
  if (effect?.effect === 'batch') {
    return renderCleanClaudeEffects(hookEvent, effect.effects || [])
  }

  if (hookEvent === 'PreToolUse') return emitClaudePreToolUseEffect(effect)

  if (hookEvent === 'Stop') {
    if (effect?.effect === 'allow' && !effect.reason && !effect.message) return false
    return emitClaudeStopEffect(effect)
  }

  const context = effect?.reason || effect?.message || effect?.context || null
  if (!context) return false

  if (hookEvent === 'SessionStart') {
    protocol.emitSessionStart({ additionalContext: context })
    return true
  }
  if (hookEvent === 'PostToolUse') {
    protocol.emitPostToolUse({ additionalContext: context })
    return true
  }
  if (hookEvent === 'PostToolUseFailure') {
    protocol.emitPostToolUseFailure({ additionalContext: context })
    return true
  }
  return false
}

function renderCleanClaudeEffects (hookEvent, effects) {
  if (hookEvent !== 'SessionStart') {
    let emitted = false
    for (const effect of effects) emitted = renderCleanClaudeEffect(hookEvent, effect) || emitted
    return emitted
  }

  const contextParts = []
  const systemMessages = []
  for (const effect of effects) {
    if (effect?.effect === 'context_injection') {
      if (effect.context) contextParts.push(effect.context)
    } else if (effect?.effect === 'env_update') {
      const result = writeClaudeEnvFile(effect.env || {})
      if (result.written && result.vars.length > 0) {
        contextParts.push(`prove_it: set env vars: ${result.vars.join(', ')}`)
      } else if (!result.written) {
        contextParts.push(`prove_it: ${result.reason}`)
      }
    } else if (effect?.effect === 'fail' || effect?.effect === 'block') {
      const message = effect.reason || effect.message
      if (message) systemMessages.push(message)
    } else {
      const context = effect?.reason || effect?.message || effect?.context
      if (context) contextParts.push(context)
    }
  }

  if (contextParts.length === 0 && systemMessages.length === 0) return false
  protocol.emitSessionStart({
    additionalContext: contextParts.join('\n\n') || null,
    systemMessage: systemMessages.join('\n\n') || null
  })
  return true
}

function normalizeClaudeHookEvent ({ hookEvent, input, projectDir }) {
  return normalizeLifecycleEvent({
    adapterId: 'claude',
    rawEventName: hookEvent,
    rawEvent: input,
    cwd: input?.cwd || projectDir || process.cwd(),
    projectDir,
    rootDir: projectDir
  })
}

function cleanClaudeAdapterCapabilities () {
  return {
    pre_tool_blocking: behaviorForCapability('claude', 'pre_tool_blocking'),
    completion_verification: behaviorForCapability('claude', 'completion_verification')
  }
}

function whenHasDoneSignal (when) {
  if (!when) return false
  const clauses = Array.isArray(when) ? when : [when]
  return clauses.some(clause => clause?.signal === 'done')
}

function hasCleanDoneSignalGatedTask (effectiveConfig) {
  const tasks = effectiveConfig?.tasks || {}
  return Object.values(tasks).some(task => whenHasDoneSignal(task?.when))
}

function autoSignalDoneForTaskCompleted ({ input, event, effectiveConfig, statePort, projectDir } = {}) {
  const sessionId = event?.sessionId || input?.session_id || input?.sessionId || null
  const subject = input?.task_subject || input?.taskSubject || ''

  if (!hasCleanDoneSignalGatedTask(effectiveConfig)) {
    return { handled: true, action: 'noop', reason: 'no_clean_done_gated_tasks' }
  }

  if (!SIGNAL_TASK_PATTERN.test(subject)) {
    return { handled: true, action: 'noop', reason: 'task_subject_did_not_match_signal_done_pattern' }
  }

  const existing = readSignal(statePort, sessionId)
  if (existing?.type === 'done') {
    return { handled: true, action: 'preserve', reason: 'done_signal_already_active', signal: existing }
  }

  const signalLifecycle = setSignal(statePort, sessionId, 'done', null)
  if (signalLifecycle.ok) {
    logReview(sessionId, projectDir || event?.projectDir || event?.cwd, 'signal', 'SET', 'done (auto)', null, 'TaskCompleted', {
      source: 'clean_claude_task_completed',
      autoSignalReason: 'task_completed_signal_done_subject',
      taskSubject: subject,
      signalLifecycle
    })
  }

  return {
    handled: true,
    action: signalLifecycle.ok ? 'set' : 'failed',
    reason: signalLifecycle.ok ? 'task_completed_signal_done_subject' : signalLifecycle.reason,
    signalLifecycle
  }
}

function injectCleanPlanBlocks (toolInput, effectiveConfig) {
  try {
    if (!hasCleanDoneSignalGatedTask(effectiveConfig)) return null
    const planText = (toolInput && toolInput.plan) || ''
    if (!planText.trim()) return null

    const filePath = findPlanFile(planText.trim())
    if (!filePath) return null

    let content
    try { content = fs.readFileSync(filePath, 'utf8') } catch { return null }
    const lastHeading = detectLastNumberedHeading(content)
    const level = lastHeading ? lastHeading.level : 2
    const stepNum = lastHeading ? lastHeading.number + 1 : 1
    appendPlanBlock(filePath, {
      marker: SIGNAL_PLAN_MARKER,
      block: buildSignalBlock(level, stepNum),
      position: 'before-verification'
    })

    try { content = fs.readFileSync(filePath, 'utf8') } catch {}
    appendPlanBlock(filePath, {
      marker: PHASE_PLAN_MARKER,
      block: buildPhaseBlock(detectPlanPhase(content)),
      position: 'before-steps'
    })
    return filePath
  } catch {
    return null
  }
}

function readState (statePort, sessionId, key) {
  if (!statePort || !sessionId) return null
  if (typeof statePort.readSessionState === 'function') return statePort.readSessionState(sessionId, key)
  if (typeof statePort.read === 'function') return statePort.read(sessionId, key)
  if (typeof statePort.getSessionState === 'function') return statePort.getSessionState(sessionId, key)
  return null
}

function writeState (statePort, sessionId, key, value) {
  if (!statePort || !sessionId) return false
  if (typeof statePort.writeSessionState === 'function') return statePort.writeSessionState(sessionId, key, value)
  if (typeof statePort.write === 'function') return statePort.write(sessionId, key, value)
  if (typeof statePort.setSessionState === 'function') return statePort.setSessionState(sessionId, key, value)
  return false
}

function emitDisabledSessionReminder ({ hookEvent, event, input } = {}) {
  if (hookEvent !== 'SessionStart') return false

  const sessionId = event?.sessionId || input?.session_id || input?.sessionId || null
  const source = input?.source || event?.source?.kind || ''
  if (sessionId && (source === 'startup' || source === 'resume')) {
    writeClaudeEnvFile({ PROVE_IT_SESSION_ID: sessionId })
  }
  protocol.emitSessionStart({
    systemMessage: '⚠️ prove_it is disabled for this session. Run `! prove_it enable` to re-enable hooks.'
  })
  return true
}

function recordCleanClaudeSessionBaseline ({ statePort, sessionId, projectDir } = {}) {
  if (!statePort || !sessionId) return false
  if (readState(statePort, sessionId, SESSION_KEYS.GIT)) return false

  const repoRoot = gitRoot(projectDir)
  const root = repoRoot || projectDir
  const head = repoRoot ? gitHead(root) : null
  const statusHash = repoRoot ? gitStatusHash(root) : null
  const git = repoRoot
    ? { is_repo: true, root, head, status_hash: statusHash }
    : { is_repo: false, root: projectDir, head: null, status_hash: null }

  writeState(statePort, sessionId, 'session_id', sessionId)
  writeState(statePort, sessionId, 'project_dir', projectDir)
  writeState(statePort, sessionId, 'root_dir', root)
  writeState(statePort, sessionId, 'started_at', new Date().toISOString())
  writeState(statePort, sessionId, SESSION_KEYS.GIT, git)
  return true
}

function testOnlyLegacyClaudeOracleEnabled () {
  return process.env.NODE_ENV === 'test' &&
    process.env.PROVE_IT_LEGACY_CLAUDE_ORACLE === '1' &&
    process.env.PROVE_IT_TEST_LEGACY_CLAUDE_ORACLE === '1'
}

function dispatchCleanClaudeHookIfEnabled ({ hookEvent, input, projectDir, statePort, taskPort = null, reviewerPort = null, backchannelPort = null, effectPort = null } = {}) {
  const cwd = projectDir || input?.cwd || process.cwd()
  const strictProjectConfigPath = projectConfigPath(cwd)
  if (!fs.existsSync(strictProjectConfigPath)) {
    // Legacy Claude dispatch is quarantined as an explicit test oracle only;
    // normal hook execution must not treat .claude/prove_it as a fallback source.
    if (testOnlyLegacyClaudeOracleEnabled()) {
      return { handled: false, reason: 'test_only_legacy_claude_oracle_enabled' }
    }
    return { handled: true, reason: 'missing_strict_project_config_no_legacy_fallback' }
  }

  const event = normalizeClaudeHookEvent({ hookEvent, input, projectDir: cwd })
  if (isSessionDisabled(statePort, event.sessionId)) {
    if (event.stage === 'session_start') {
      recordCleanClaudeSessionBaseline({ statePort, sessionId: event.sessionId, projectDir: cwd })
      emitDisabledSessionReminder({ hookEvent, event, input })
    }
    return { handled: true, reason: 'clean_claude_session_disabled', event }
  }

  let explained
  try {
    explained = loadEffectiveConfig(cwd)
  } catch (error) {
    emitInvalidConfigDiagnostic(hookEvent, error, {
      statePort,
      sessionId: input?.session_id || input?.sessionId || null
    })
    return { handled: true, reason: 'invalid_strict_config', error }
  }

  const effectiveConfig = explained.effective
  if (effectiveConfig?.adapters?.claude?.enabled !== true) {
    return { handled: true, reason: 'claude_adapter_disabled' }
  }

  if (event.stage === 'session_start') {
    recordCleanClaudeSessionBaseline({ statePort, sessionId: event.sessionId, projectDir: cwd })
  }
  if (hookEvent === 'TaskCompleted') {
    const taskCompleted = autoSignalDoneForTaskCompleted({ input, event, effectiveConfig, statePort, projectDir: cwd })
    return { handled: true, reason: 'clean_claude_task_completed', event, effect: null, taskCompleted }
  }
  if (event.stage === 'pre_tool' && String(event.toolName || '').toLowerCase() === 'exitplanmode') {
    injectCleanPlanBlocks(input?.tool_input || input?.toolInput || input?.input || {}, effectiveConfig)
  }
  recordObservationFacts({ statePort, event, config: effectiveConfig })
  const activeBackchannelPort = backchannelPort || createClaudeBackchannelPort()
  if (typeof activeBackchannelPort.isBackchannelWriteAllowed === 'function' && activeBackchannelPort.isBackchannelWriteAllowed(event)) {
    const effect = { effect: 'allow', permissionDecision: 'allow' }
    renderCleanClaudeEffect(hookEvent, effect)
    return { handled: true, reason: 'clean_claude_backchannel_bypass', event, effect }
  }
  let effect
  if (event.sessionId) writeDispatcherPid(event.sessionId, { pid: process.pid, event: hookEvent, startedAt: Date.now(), runtime: 'clean' })
  try {
    effect = runWorkflowEngine({
      event,
      effectiveConfig,
      adapterCapabilities: cleanClaudeAdapterCapabilities(),
      statePort,
      taskPort: taskPort || createScriptTaskPort(),
      reviewerPort: reviewerPort || createClaudeReviewerPort(),
      backchannelPort: activeBackchannelPort,
      effectPort
    })
  } finally {
    if (event.sessionId) clearDispatcherPid(event.sessionId)
  }
  renderCleanClaudeEffect(hookEvent, effect)
  return { handled: true, reason: 'clean_claude_route', event, effect }
}

module.exports = {
  cleanClaudeAdapterCapabilities,
  dispatchCleanClaudeHookIfEnabled,
  emitDisabledSessionReminder,
  autoSignalDoneForTaskCompleted,
  emitInvalidConfigDiagnostic,
  normalizeClaudeHookEvent,
  hasCleanDoneSignalGatedTask,
  injectCleanPlanBlocks,
  recordCleanClaudeSessionBaseline,
  renderCleanClaudeEffect,
  renderCleanClaudeEffects,
  strictConfigDiagnostic,
  writeClaudeEnvFile
}
