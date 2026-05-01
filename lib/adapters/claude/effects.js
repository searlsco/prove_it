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

  if (effect?.effect === 'allow' && effect.permissionDecision === 'allow') {
    protocol.emitPreToolUse('allow', effectMessage(effect))
    return true
  }

  if (effect?.effect === 'allow' && effect.reason) {
    protocol.emitPreToolUseContext(effect.reason, effect.systemMessage ? { systemMessage: effect.systemMessage } : {})
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

function appendClaudeCompletionRemediation (reason, effect) {
  if (effect?.capability !== 'completion_verification') return reason
  if (effect?.signalLifecycle?.action !== 'preserve') return reason
  if (effect?.signalLifecycle?.signal?.type !== 'done') return reason
  if (/done signal is preserved/i.test(reason)) return reason

  return [
    reason,
    '',
    'The done signal is preserved. Fix the issues, run focused verification, then try completing again.'
  ].join('\n')
}

function emitClaudeStopEffect (effect) {
  const reason = effectMessage(effect)
  if (effect?.effect === 'block' || effect?.effect === 'fail' || effect?.effect === 'remediation') {
    const blockReason = appendClaudeCompletionRemediation(reason, effect)
    protocol.emitStop('block', blockReason, blockReason)
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
