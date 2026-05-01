const VALID_SIGNALS = ['done', 'stuck', 'idle']

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeMessage (message) {
  return message == null || message === '' ? null : String(message)
}

function normalizeSignal (type, message, now = Date.now()) {
  if (!VALID_SIGNALS.includes(type)) return null
  return {
    type,
    message: normalizeMessage(message),
    at: now
  }
}

function readSignal (statePort, sessionId) {
  if (!statePort || typeof statePort.readSignal !== 'function') return null
  try {
    const signal = statePort.readSignal(sessionId)
    if (!isObject(signal)) return null
    if (!VALID_SIGNALS.includes(signal.type)) return null
    return signal
  } catch {
    return null
  }
}

function writeSignal (statePort, sessionId, signal) {
  if (!statePort || typeof statePort.writeSignal !== 'function') return false
  try {
    return statePort.writeSignal(sessionId, signal) !== false
  } catch {
    return false
  }
}

function setSignal (statePort, sessionId, type, message, options = {}) {
  const signal = normalizeSignal(type, message, options.now != null ? options.now : Date.now())
  if (!signal) return { ok: false, reason: 'invalid_signal', signal: null }

  const ok = writeSignal(statePort, sessionId, signal)
  return {
    ok,
    reason: ok ? null : 'state_unavailable',
    signal: ok ? signal : null
  }
}

function clearSignal (statePort, sessionId) {
  if (!statePort || typeof statePort.clearSignal !== 'function') return false
  try {
    return statePort.clearSignal(sessionId) !== false
  } catch {
    return false
  }
}

function preserveSignalOnFailure (statePort, sessionId) {
  return {
    ok: true,
    action: 'preserve',
    signal: readSignal(statePort, sessionId)
  }
}

function clearSignalOnPass (statePort, sessionId) {
  const signal = readSignal(statePort, sessionId)
  if (!signal) {
    return { ok: true, action: 'none', signal: null }
  }

  const ok = clearSignal(statePort, sessionId)
  return {
    ok,
    action: ok ? 'clear' : 'preserve',
    signal
  }
}

function settleSignalAfterVerification (statePort, sessionId, passed) {
  if (passed) return clearSignalOnPass(statePort, sessionId)
  return preserveSignalOnFailure(statePort, sessionId)
}

function parseSignalCommand (command) {
  const text = String(command || '').trim()
  const match = text.match(/^(?:\S+\/)?prove_it\s+signal\s+(\S+)/)
  if (!match) return null

  const type = match[1]
  const msgMatch = text.match(/(?:--message|-m)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/)
  const message = msgMatch ? (msgMatch[1] ?? msgMatch[2] ?? msgMatch[3]) : null

  return {
    matched: true,
    valid: VALID_SIGNALS.includes(type),
    type,
    message
  }
}

module.exports = {
  VALID_SIGNALS,
  clearSignal,
  clearSignalOnPass,
  normalizeSignal,
  parseSignalCommand,
  preserveSignalOnFailure,
  readSignal,
  setSignal,
  settleSignalAfterVerification
}
