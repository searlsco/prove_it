const { SESSION_KEYS } = require('../session')

const VALID_PHASES = ['unknown', 'plan', 'implement', 'refactor']

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readStateValue (statePort, sessionId, key) {
  if (!statePort || !key) return null
  try {
    if (typeof statePort.readSessionState === 'function') return statePort.readSessionState(sessionId, key)
    if (typeof statePort.read === 'function') return statePort.read(sessionId, key)
    if (typeof statePort.getSessionState === 'function') return statePort.getSessionState(sessionId, key)
  } catch {}
  return null
}

function writeStateValue (statePort, sessionId, key, value) {
  if (!statePort || !key) return false
  try {
    if (typeof statePort.writeSessionState === 'function') return statePort.writeSessionState(sessionId, key, value) !== false
    if (typeof statePort.write === 'function') return statePort.write(sessionId, key, value) !== false
    if (typeof statePort.setSessionState === 'function') return statePort.setSessionState(sessionId, key, value) !== false
  } catch {}
  return false
}

function normalizePhaseRecord (value, options = {}) {
  if (typeof value === 'string') {
    if (!VALID_PHASES.includes(value)) return null
    return { phase: value, at: options.now ?? Date.now() }
  }
  if (!isObject(value) || !VALID_PHASES.includes(value.phase)) return null
  return {
    phase: value.phase,
    at: value.at ?? null
  }
}

function readPhaseRecord (statePort, sessionId) {
  return normalizePhaseRecord(readStateValue(statePort, sessionId, SESSION_KEYS.PHASE))
}

function readPhase (statePort, sessionId) {
  return readPhaseRecord(statePort, sessionId)?.phase || 'unknown'
}

function setPhase (statePort, sessionId, phase, options = {}) {
  const record = normalizePhaseRecord(phase, { now: options.now })
  if (!record) return { ok: false, reason: 'invalid_phase', phase: null }

  const ok = writeStateValue(statePort, sessionId, SESSION_KEYS.PHASE, record)
  return {
    ok,
    reason: ok ? null : 'state_unavailable',
    phase: ok ? record : null
  }
}

function parsePhaseCommand (command) {
  const text = String(command || '').trim()
  const match = text.match(/^(?:\S+\/)?prove_it\s+phase\s+(\S+)/)
  if (!match) return null

  const phase = match[1]
  return {
    matched: true,
    valid: VALID_PHASES.includes(phase),
    phase
  }
}

module.exports = {
  VALID_PHASES,
  parsePhaseCommand,
  readPhase,
  readPhaseRecord,
  setPhase
}
