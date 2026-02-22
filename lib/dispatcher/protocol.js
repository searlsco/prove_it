const { emitJson } = require('../io')

/**
 * Protocol adapters for Claude Code hook output schemas.
 * Each event type has a different output format.
 */

function emitPreToolUse (decision, reason, systemMessage) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason || ''
    }
  }
  if (systemMessage) output.systemMessage = systemMessage
  emitJson(output)
}

function emitStop (decision, reason, systemMessage) {
  const output = {
    decision,
    reason: reason || ''
  }
  if (systemMessage) output.systemMessage = systemMessage
  emitJson(output)
}

function emitSessionStart ({ additionalContext, systemMessage } = {}) {
  const output = {}
  if (additionalContext) output.additionalContext = additionalContext
  if (systemMessage) output.systemMessage = systemMessage
  if (Object.keys(output).length > 0) {
    emitJson(output)
  }
}

/**
 * Emit the correct protocol output for a given event type.
 *
 * For PreToolUse: decision is "allow", "deny", or "ask"
 * For Stop: decision is "block" or "approve"
 *
 * SessionStart has a different signature—call emitSessionStart() directly.
 */
function emit (event, decision, reason, systemMessage) {
  switch (event) {
    case 'PreToolUse':
      emitPreToolUse(decision, reason, systemMessage)
      break
    case 'Stop':
      emitStop(decision, reason, systemMessage)
      break
    default:
      emitStop(decision, reason, systemMessage)
  }
}

/**
 * Map check results to protocol decisions.
 * PreToolUse uses allow/deny; Stop uses approve/block.
 */
function passDecision (event) {
  return event === 'Stop' ? 'approve' : 'allow'
}

function failDecision (event) {
  return event === 'Stop' ? 'block' : 'deny'
}

module.exports = {
  emit,
  emitPreToolUse,
  emitStop,
  emitSessionStart,
  passDecision,
  failDecision
}
