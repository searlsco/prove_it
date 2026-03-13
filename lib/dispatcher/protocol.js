const { emitJson } = require('../io')

/**
 * Protocol adapters for Claude Code hook output schemas.
 * Each event type has a different output format.
 */

function emitPreToolUse (decision, reason, opts = {}) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason || ''
    }
  }
  if (opts.additionalContext) output.hookSpecificOutput.additionalContext = opts.additionalContext
  if (opts.systemMessage) output.systemMessage = opts.systemMessage
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
  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext
    }
  }
  if (systemMessage) output.systemMessage = systemMessage
  if (Object.keys(output).length > 0) {
    emitJson(output)
  }
}

function emitPostToolUse (opts = {}) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse'
    }
  }
  if (opts.decision) output.decision = opts.decision
  if (opts.reason) output.reason = opts.reason
  if (opts.additionalContext) output.hookSpecificOutput.additionalContext = opts.additionalContext
  emitJson(output)
}

function emitPostToolUseFailure (opts = {}) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure'
    }
  }
  if (opts.additionalContext) output.hookSpecificOutput.additionalContext = opts.additionalContext
  emitJson(output)
}

/**
 * Emit the correct protocol output for a given event type.
 *
 * For PreToolUse: decision is "allow", "deny", or "ask"
 * For Stop: decision is "block" or "approve"
 * For PostToolUse: no decision control needed (tool already ran)
 * For PostToolUseFailure: no decision control (additionalContext only)
 *
 * SessionStart has a different signature—call emitSessionStart() directly.
 */
function emit (event, decision, reason, systemMessage) {
  switch (event) {
    case 'PreToolUse':
      emitPreToolUse(decision, reason, { systemMessage })
      break
    case 'PostToolUse':
      emitPostToolUse({ decision, reason, additionalContext: reason })
      break
    case 'PostToolUseFailure':
      emitPostToolUseFailure({ additionalContext: reason })
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
 * PostToolUse/PostToolUseFailure cannot block (tool already ran).
 */
function passDecision (event) {
  if (event === 'Stop') return 'approve'
  if (event === 'PostToolUse') return 'approve'
  return 'allow'
}

function failDecision (event) {
  if (event === 'Stop') return 'block'
  if (event === 'PostToolUse') return 'block'
  return 'deny'
}

module.exports = {
  emit,
  emitPreToolUse,
  emitPostToolUse,
  emitPostToolUseFailure,
  emitStop,
  emitSessionStart,
  passDecision,
  failDecision
}
