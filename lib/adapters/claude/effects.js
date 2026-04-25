const { behaviorForCapability } = require('../../adapter_capabilities')
const protocol = require('../../dispatcher/protocol')
const { approveEffect, failEffect } = require('../../redesign/effects')
const { settleSignalAfterVerification } = require('../../redesign/signal_lifecycle')

const LEGACY_CONFIG_DENY_REASON = 'prove_it: Cannot modify prove_it config files\n\n' +
  'These files are for user configuration. ' +
  'To modify them, run the command directly in your terminal (not through Claude).'

function effectMessage (effect) {
  return effect?.legacyReason || effect?.reason || effect?.message || ''
}

function emitClaudePreToolUseEffect (effect) {
  if (effect?.effect === 'block' || effect?.effect === 'fail') {
    const reason = effectMessage(effect)
    protocol.emitPreToolUse('deny', reason, { systemMessage: reason })
    return true
  }

  if (effect?.effect === 'allow' && effect.reason) {
    protocol.emitPreToolUseContext(effect.reason)
    return true
  }

  return false
}

function claudeStopEffectFromVerification ({ passed, reason, statePort, sessionId } = {}) {
  const behavior = behaviorForCapability('claude', 'completion_verification')
  const fields = {
    capability: 'completion_verification',
    enforcement: behavior.strength,
    signalLifecycle: settleSignalAfterVerification(statePort, sessionId, Boolean(passed))
  }

  return passed
    ? approveEffect(reason, fields)
    : failEffect(reason, fields)
}

function emitClaudeStopEffect (effect) {
  const reason = effectMessage(effect)
  if (effect?.effect === 'block' || effect?.effect === 'fail' || effect?.effect === 'remediation') {
    protocol.emitStop('block', reason, reason)
    return true
  }

  if (effect?.effect === 'approve' || effect?.effect === 'allow') {
    protocol.emitStop('approve', reason)
    return true
  }

  return false
}

module.exports = {
  LEGACY_CONFIG_DENY_REASON,
  claudeStopEffectFromVerification,
  emitClaudePreToolUseEffect,
  emitClaudeStopEffect
}
