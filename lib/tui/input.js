'use strict'

/**
 * Raw-mode keypress handler for the TUI.
 *
 * Parses raw stdin bytes into named key events and dispatches them
 * to a handler map. Supports arrow keys, Tab, Enter, Escape, Ctrl+C,
 * and printable characters.
 */

/**
 * Parse a raw buffer/string from stdin into a key name.
 *
 * @param {Buffer|string} data - Raw input data
 * @returns {string} Named key (e.g. 'up', 'down', 'tab', 'enter', 'q', 'ctrl-c')
 */
function parseKey (data) {
  const s = typeof data === 'string' ? data : data.toString('utf8')
  const bytes = Buffer.from(s)

  // Ctrl+C
  if (bytes.length === 1 && bytes[0] === 3) return 'ctrl-c'

  // Escape sequences
  if (s.startsWith('\x1b')) {
    // Arrow keys
    if (s === '\x1b[A') return 'up'
    if (s === '\x1b[B') return 'down'
    if (s === '\x1b[C') return 'right'
    if (s === '\x1b[D') return 'left'

    // Shift+Tab
    if (s === '\x1b[Z') return 'shift-tab'

    // Bare escape
    if (s === '\x1b') return 'escape'

    return 'unknown'
  }

  // Tab
  if (bytes.length === 1 && bytes[0] === 9) return 'tab'

  // Enter
  if (bytes.length === 1 && (bytes[0] === 13 || bytes[0] === 10)) return 'enter'

  // Backspace
  if (bytes.length === 1 && bytes[0] === 127) return 'backspace'

  // Printable character
  if (s.length === 1 && s.charCodeAt(0) >= 32) return s

  return 'unknown'
}

/**
 * Create an input handler that reads from a stream and dispatches key events.
 *
 * @param {ReadableStream} stream - Typically process.stdin
 * @param {Object} handlers - Map of key names to handler functions
 * @returns {{ start(), stop() }}
 */
function createInputHandler (stream, handlers) {
  let active = false

  function onData (data) {
    const key = parseKey(data)
    const handler = handlers[key]
    if (handler) {
      handler(key)
    } else if (handlers['*']) {
      handlers['*'](key)
    }
  }

  return {
    start () {
      if (active) return
      active = true
      if (stream.setRawMode) stream.setRawMode(true)
      stream.resume()
      stream.on('data', onData)
    },

    stop () {
      if (!active) return
      active = false
      stream.removeListener('data', onData)
      if (stream.setRawMode) stream.setRawMode(false)
      stream.pause()
    }
  }
}

module.exports = { parseKey, createInputHandler }
