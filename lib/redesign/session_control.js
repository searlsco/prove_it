const { SESSION_KEYS } = require('../session')

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readStateValue (statePort, sessionId, key) {
  if (!statePort || !sessionId || !key) return null
  try {
    if (typeof statePort.readSessionState === 'function') return statePort.readSessionState(sessionId, key)
    if (typeof statePort.read === 'function') return statePort.read(sessionId, key)
    if (typeof statePort.getSessionState === 'function') return statePort.getSessionState(sessionId, key)
  } catch {}
  return null
}

function writeStateValue (statePort, sessionId, key, value) {
  if (!statePort || !sessionId || !key) return false
  try {
    if (typeof statePort.writeSessionState === 'function') return statePort.writeSessionState(sessionId, key, value) !== false
    if (typeof statePort.write === 'function') return statePort.write(sessionId, key, value) !== false
    if (typeof statePort.setSessionState === 'function') return statePort.setSessionState(sessionId, key, value) !== false
  } catch {}
  return false
}

function normalizeControlState (state) {
  const control = isObject(state) ? { ...state } : {}
  control.disabled = isObject(control.disabled) && control.disabled.active === true
    ? { ...control.disabled, active: true }
    : null
  control.cancel = isObject(control.cancel) && control.cancel.requested === true
    ? { ...control.cancel, requested: true }
    : null
  return control
}

function readSessionControl (statePort, sessionId) {
  return normalizeControlState(readStateValue(statePort, sessionId, SESSION_KEYS.SESSION_CONTROL))
}

function writeSessionControl (statePort, sessionId, control) {
  return writeStateValue(statePort, sessionId, SESSION_KEYS.SESSION_CONTROL, normalizeControlState(control))
}

function setSessionDisabled (statePort, sessionId, options = {}) {
  const control = readSessionControl(statePort, sessionId)
  control.disabled = {
    active: true,
    at: options.at ?? Date.now()
  }
  return writeSessionControl(statePort, sessionId, control)
}

function clearSessionDisabled (statePort, sessionId) {
  const control = readSessionControl(statePort, sessionId)
  control.disabled = null
  return writeSessionControl(statePort, sessionId, control)
}

function isSessionDisabled (statePort, sessionId) {
  return readSessionControl(statePort, sessionId).disabled?.active === true
}

function requestSessionCancel (statePort, sessionId, options = {}) {
  const control = readSessionControl(statePort, sessionId)
  control.cancel = {
    requested: true,
    at: options.at ?? Date.now()
  }
  return writeSessionControl(statePort, sessionId, control)
}

function clearSessionCancel (statePort, sessionId) {
  const control = readSessionControl(statePort, sessionId)
  const previous = control.cancel
  control.cancel = null
  const ok = writeSessionControl(statePort, sessionId, control)
  return { ok, previous }
}

function consumeSessionCancel (statePort, sessionId) {
  const control = readSessionControl(statePort, sessionId)
  if (control.cancel?.requested !== true) {
    return { canceled: false, ok: true, previous: null }
  }
  const previous = control.cancel
  control.cancel = null
  const ok = writeSessionControl(statePort, sessionId, control)
  return { canceled: true, ok, previous }
}

module.exports = {
  clearSessionCancel,
  clearSessionDisabled,
  consumeSessionCancel,
  isSessionDisabled,
  readSessionControl,
  requestSessionCancel,
  setSessionDisabled,
  writeSessionControl
}
