const { emitJson } = require('../io')

/**
 * Protocol adapters for Claude Code hook output schemas.
 * Each event type has a different output format.
 */

function emitPreToolUse (decision, reason) {
  emitJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason || ''
    }
  })
}

function emitStop (decision, reason) {
  emitJson({
    decision,
    reason: reason || ''
  })
}

function emitSessionStart (text) {
  process.stdout.write(text || '')
}

/**
 * Emit the correct protocol output for a given event type.
 *
 * For PreToolUse: decision is "allow", "deny", or "ask"
 * For Stop: decision is "block" or "approve"
 * For SessionStart: decision is ignored, reason is text output
 */
function emit (event, decision, reason) {
  switch (event) {
    case 'PreToolUse':
      emitPreToolUse(decision, reason)
      break
    case 'Stop':
      emitStop(decision, reason)
      break
    case 'SessionStart':
      emitSessionStart(reason)
      break
    default:
      emitSessionStart(reason)
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
