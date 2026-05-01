const { SESSION_KEYS, loadSessionState, saveSessionState } = require('../session')

const DEFAULT_MEMORY_SESSION = '__prove_it_adapter_session__'

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeRead (fn, fallback = null) {
  try {
    const value = fn()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function safeWrite (fn) {
  try {
    return fn() !== false
  } catch {
    return false
  }
}

function normalizeSessionKey (sessionId, options = {}) {
  if (sessionId) return sessionId
  if (options.requireSessionId === false) return options.defaultSessionId || DEFAULT_MEMORY_SESSION
  return null
}

function createStatePort (adapter = {}) {
  function readSessionState (sessionId, key) {
    if ((!sessionId && adapter.requireSessionId !== false) || !key || typeof adapter.readSessionState !== 'function') return null
    return safeRead(() => adapter.readSessionState(sessionId, key), null)
  }

  function writeSessionState (sessionId, key, value) {
    if ((!sessionId && adapter.requireSessionId !== false) || !key || typeof adapter.writeSessionState !== 'function') return false
    return safeWrite(() => adapter.writeSessionState(sessionId, key, value))
  }

  function readSignal (sessionId) {
    if (typeof adapter.readSignal === 'function') {
      return safeRead(() => adapter.readSignal(sessionId), null)
    }
    return readSessionState(sessionId, SESSION_KEYS.SIGNAL)
  }

  function writeSignal (sessionId, signal) {
    if (typeof adapter.writeSignal === 'function') {
      return safeWrite(() => adapter.writeSignal(sessionId, signal))
    }
    return writeSessionState(sessionId, SESSION_KEYS.SIGNAL, signal)
  }

  function clearSignal (sessionId) {
    if (typeof adapter.clearSignal === 'function') {
      return safeWrite(() => adapter.clearSignal(sessionId))
    }
    return writeSignal(sessionId, null)
  }

  return {
    read: readSessionState,
    write: writeSessionState,
    readSessionState,
    writeSessionState,
    getSessionState: readSessionState,
    setSessionState: writeSessionState,
    readSignal,
    writeSignal,
    clearSignal
  }
}

function createSessionStatePort () {
  return createStatePort({
    readSessionState: loadSessionState,
    writeSessionState: saveSessionState
  })
}

function createObjectStatePort (store = {}, options = {}) {
  const state = isObject(store) ? store : {}

  function sessionBucket (sessionId, create = false) {
    const sessionKey = normalizeSessionKey(sessionId, options)
    if (!sessionKey) return null

    if (!isObject(state.sessions)) {
      if (!create) return null
      state.sessions = {}
    }

    if (!isObject(state.sessions[sessionKey])) {
      if (!create) return null
      state.sessions[sessionKey] = {}
    }

    return state.sessions[sessionKey]
  }

  return createStatePort({
    requireSessionId: options.requireSessionId !== false,
    readSessionState (sessionId, key) {
      const bucket = sessionBucket(sessionId, false)
      if (!bucket) return null
      return bucket[key] ?? null
    },
    writeSessionState (sessionId, key, value) {
      const bucket = sessionBucket(sessionId, true)
      if (!bucket) return false
      bucket[key] = value
      return true
    }
  })
}

function createMemoryStatePort (initialState = {}, options = {}) {
  return createObjectStatePort(initialState, options)
}

function createAdapterStatePort (ctx = {}) {
  if (ctx.statePort) return ctx.statePort
  if (ctx.sessionState && isObject(ctx.sessionState)) {
    return createObjectStatePort(ctx.sessionState, { requireSessionId: false })
  }
  if (ctx.state && isObject(ctx.state)) {
    return createObjectStatePort(ctx.state, { requireSessionId: false })
  }
  return null
}

module.exports = {
  DEFAULT_MEMORY_SESSION,
  createAdapterStatePort,
  createMemoryStatePort,
  createObjectStatePort,
  createSessionStatePort,
  createStatePort
}
