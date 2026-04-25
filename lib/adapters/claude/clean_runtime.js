const fs = require('fs')

const { behaviorForCapability } = require('../../adapter_capabilities')
const { loadEffectiveConfig, projectConfigPath } = require('../../redesign/config')
const { normalizeLifecycleEvent } = require('../../redesign/events')
const { runWorkflowEngine } = require('../../redesign/engine')
const protocol = require('../../dispatcher/protocol')
const { emitClaudePreToolUseEffect, emitClaudeStopEffect } = require('./effects')

function strictConfigDiagnostic (error) {
  return `⚠️ prove_it invalid strict .prove_it/config.json — Claude clean-runtime hooks are disabled until this is fixed.\n\n${error.message}`
}

function emitInvalidConfigDiagnostic (hookEvent, error) {
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
    protocol.emitStop('approve', message, message)
  }
}

function renderCleanClaudeEffect (hookEvent, effect) {
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

function dispatchCleanClaudeHookIfEnabled ({ hookEvent, input, projectDir, statePort, taskPort = null, effectPort = null } = {}) {
  const cwd = projectDir || input?.cwd || process.cwd()
  const strictProjectConfigPath = projectConfigPath(cwd)
  if (!fs.existsSync(strictProjectConfigPath)) return { handled: false, reason: 'missing_strict_project_config' }

  let explained
  try {
    explained = loadEffectiveConfig(cwd)
  } catch (error) {
    emitInvalidConfigDiagnostic(hookEvent, error)
    return { handled: true, reason: 'invalid_strict_config', error }
  }

  const effectiveConfig = explained.effective
  if (effectiveConfig?.adapters?.claude?.enabled !== true) {
    return { handled: true, reason: 'claude_adapter_disabled' }
  }

  const event = normalizeClaudeHookEvent({ hookEvent, input, projectDir: cwd })
  const effect = runWorkflowEngine({
    event,
    effectiveConfig,
    adapterCapabilities: cleanClaudeAdapterCapabilities(),
    statePort,
    taskPort,
    effectPort
  })
  renderCleanClaudeEffect(hookEvent, effect)
  return { handled: true, reason: 'clean_claude_route', event, effect }
}

module.exports = {
  cleanClaudeAdapterCapabilities,
  dispatchCleanClaudeHookIfEnabled,
  emitInvalidConfigDiagnostic,
  normalizeClaudeHookEvent,
  renderCleanClaudeEffect,
  strictConfigDiagnostic
}
