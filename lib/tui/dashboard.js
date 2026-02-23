'use strict'

const path = require('path')
const {
  enterAltScreen, leaveAltScreen, writeAt,
  topBorder, divider, bottomBorder, boxLine,
  DIM, BOLD, RESET, INVERSE
} = require('./screen')
const { calculateLayout, innerWidth } = require('./layout')
const { createInputHandler } = require('./input')
const { createSessionsPanel } = require('./panels/sessions')
const { createEntriesPanel } = require('./panels/entries')
const { createDetailPanel } = require('./panels/detail')
const {
  getSessionsList, readEntries, watchFileCallback
} = require('../monitor')
const { getProveItDir } = require('../config')

const PANELS = ['sessions', 'entries', 'detail']

/**
 * Create and run the interactive TUI dashboard.
 *
 * @param {object} opts
 * @param {string} [opts.sessionId] - Pre-select a session
 * @param {string} [opts.project] - Filter to project directory
 * @param {ReadableStream} [opts.stdin] - Input stream (default: process.stdin)
 * @param {WritableStream} [opts.stdout] - Output stream (default: process.stdout)
 */
function createDashboard (opts = {}) {
  const stdin = opts.stdin || process.stdin
  const stdout = opts.stdout || process.stdout
  const sessionsDir = path.join(getProveItDir(), 'sessions')

  // Panels
  const sessionsPanel = createSessionsPanel()
  const entriesPanel = createEntriesPanel()
  const detailPanel = createDetailPanel()

  // State
  let focusIndex = 0
  let layout = null
  let showHelp = false
  let running = false
  let watchCleanups = []
  let sessionRefreshInterval = null

  function focusedPanel () {
    return PANELS[focusIndex]
  }

  // ── Data loading ──

  function refreshSessions () {
    const list = getSessionsList(sessionsDir, opts.project || undefined)
    sessionsPanel.setSessions(list)
  }

  function loadSession (sessionId) {
    const logFile = path.join(sessionsDir, `${sessionId}.jsonl`)
    const entries = readEntries(logFile)
    entriesPanel.setEntries(entries)
    detailPanel.clear()

    // Stop existing watchers
    for (const cleanup of watchCleanups) cleanup()
    watchCleanups = []

    // Watch for new entries
    let offset = 0
    try {
      const fs = require('fs')
      const stat = fs.statSync(logFile)
      offset = stat.size
    } catch {}

    watchCleanups.push(watchFileCallback(logFile, offset, (entry) => {
      entriesPanel.addEntry(entry)
      render()
    }))
  }

  // ── Rendering ──

  function render () {
    if (!layout) updateLayout()
    if (layout.tooSmall) {
      writeAt(stdout, 1, 1, 'Terminal too small. Resize to at least 40x15.')
      return
    }

    const w = layout.width
    const iw = innerWidth(layout)

    // Top border with sessions label
    const sessionsFocused = focusedPanel() === 'sessions'
    writeAt(stdout, layout.sessions.topBorderRow, 1, topBorder(w, 'Sessions', sessionsFocused))

    // Sessions content
    const sessionsLines = sessionsPanel.render(layout.sessions.contentHeight, iw, sessionsFocused)
    for (let i = 0; i < sessionsLines.length; i++) {
      writeAt(stdout, layout.sessions.contentStart + i, 1, boxLine(sessionsLines[i], w))
    }

    // Entries divider
    const entriesFocused = focusedPanel() === 'entries'
    const entriesLabel = entriesPanel.searchMode
      ? `Search: ${entriesPanel.searchInput}\u2588`
      : entriesPanel.label()
    writeAt(stdout, layout.entries.dividerRow, 1, divider(w, entriesLabel, entriesFocused))

    // Entries content
    const entriesLines = entriesPanel.render(layout.entries.contentHeight, iw, entriesFocused)
    for (let i = 0; i < entriesLines.length; i++) {
      writeAt(stdout, layout.entries.contentStart + i, 1, boxLine(entriesLines[i], w))
    }

    // Detail divider
    const detailFocused = focusedPanel() === 'detail'
    writeAt(stdout, layout.detail.dividerRow, 1, divider(w, 'Detail', detailFocused))

    // Detail content
    const detailLines = detailPanel.render(layout.detail.contentHeight, iw, detailFocused)
    for (let i = 0; i < detailLines.length; i++) {
      writeAt(stdout, layout.detail.contentStart + i, 1, boxLine(detailLines[i], w))
    }

    // Bottom border
    writeAt(stdout, layout.bottomBorderRow, 1, bottomBorder(w))

    // Status bar
    const statusText = showHelp
      ? buildHelpText(iw)
      : buildStatusText(iw)
    writeAt(stdout, layout.statusBar.row, 1, ' ' + statusText)

    // Help overlay
    if (showHelp) {
      renderHelpOverlay()
    }
  }

  function buildStatusText (width) {
    const parts = [
      `${DIM}[\u2191\u2193]${RESET} navigate`,
      `${DIM}[Tab]${RESET} panel`,
      `${DIM}[f]${RESET} filter`,
      `${DIM}[/]${RESET} search`,
      `${DIM}[?]${RESET} help`,
      `${DIM}[q]${RESET} quit`
    ]
    return parts.join('  ')
  }

  function buildHelpText () {
    return `${INVERSE} ? ${RESET} Press any key to close help`
  }

  function renderHelpOverlay () {
    // Render help in the entries panel area
    const helpLines = [
      `${BOLD}Keyboard shortcuts${RESET}`,
      '',
      `  ${DIM}\u2191/k \u2193/j${RESET}     Navigate / scroll`,
      `  ${DIM}Tab${RESET}         Cycle focus: sessions \u2192 entries \u2192 detail`,
      `  ${DIM}Shift+Tab${RESET}   Cycle focus backwards`,
      `  ${DIM}Enter${RESET}       Load session / show detail`,
      `  ${DIM}f${RESET}           Cycle filter: ALL \u2192 PASS \u2192 FAIL \u2192 SKIP \u2192 CRASH`,
      `  ${DIM}/  ${RESET}         Search entries (Enter to confirm, Esc to cancel)`,
      `  ${DIM}r${RESET}           Refresh session list`,
      `  ${DIM}Esc${RESET}         Return focus to entries / cancel search`,
      `  ${DIM}q  ${RESET}         Quit`,
      `  ${DIM}?${RESET}           Toggle this help`
    ]

    const w = layout.width
    const startRow = layout.entries.contentStart
    const maxLines = layout.entries.contentHeight
    for (let i = 0; i < Math.min(helpLines.length, maxLines); i++) {
      writeAt(stdout, startRow + i, 1, boxLine(helpLines[i], w))
    }
    // Clear remaining lines in entries area
    for (let i = helpLines.length; i < maxLines; i++) {
      writeAt(stdout, startRow + i, 1, boxLine('', w))
    }
  }

  // ── Input handling ──

  function buildHandlers () {
    const handlers = {}

    // Quit
    handlers.q = () => stop()
    handlers['ctrl-c'] = () => stop()

    // Focus cycling
    handlers.tab = () => {
      if (entriesPanel.searchMode) return
      focusIndex = (focusIndex + 1) % PANELS.length
      render()
    }
    handlers['shift-tab'] = () => {
      if (entriesPanel.searchMode) return
      focusIndex = (focusIndex - 1 + PANELS.length) % PANELS.length
      render()
    }

    // Navigation
    handlers.up = () => handleNav('up')
    handlers.k = () => {
      if (entriesPanel.searchMode) { entriesPanel.appendSearchChar('k'); render(); return }
      handleNav('up')
    }
    handlers.down = () => handleNav('down')
    handlers.j = () => {
      if (entriesPanel.searchMode) { entriesPanel.appendSearchChar('j'); render(); return }
      handleNav('down')
    }

    // Enter
    handlers.enter = () => {
      if (entriesPanel.searchMode) {
        entriesPanel.confirmSearch()
        render()
        return
      }
      const panel = focusedPanel()
      if (panel === 'sessions') {
        const session = sessionsPanel.selectedSession()
        if (session) {
          loadSession(session.id)
          focusIndex = 1 // entries
        }
        render()
      } else if (panel === 'entries') {
        const entry = entriesPanel.selectedEntry()
        if (entry) {
          detailPanel.setEntry(entry)
          focusIndex = 2 // detail
        }
        render()
      }
    }

    // Escape
    handlers.escape = () => {
      if (entriesPanel.searchMode) {
        entriesPanel.exitSearch()
        render()
        return
      }
      if (showHelp) {
        showHelp = false
        render()
        return
      }
      if (focusedPanel() === 'detail') {
        focusIndex = 1 // back to entries
        render()
      }
    }

    // Filter
    handlers.f = () => {
      if (entriesPanel.searchMode) { entriesPanel.appendSearchChar('f'); render(); return }
      if (focusedPanel() === 'entries' || focusedPanel() === 'sessions') {
        entriesPanel.cycleFilter()
        render()
      }
    }

    // Search
    handlers['/'] = () => {
      if (entriesPanel.searchMode) { entriesPanel.appendSearchChar('/'); render(); return }
      entriesPanel.enterSearch()
      focusIndex = 1
      render()
    }

    // Refresh
    handlers.r = () => {
      if (entriesPanel.searchMode) { entriesPanel.appendSearchChar('r'); render(); return }
      refreshSessions()
      render()
    }

    // Help toggle
    handlers['?'] = () => {
      if (entriesPanel.searchMode) { entriesPanel.appendSearchChar('?'); render(); return }
      showHelp = !showHelp
      render()
    }

    // Backspace (for search)
    handlers.backspace = () => {
      if (entriesPanel.searchMode) {
        entriesPanel.backspaceSearch()
        render()
      }
    }

    // Wildcard for search mode characters
    handlers['*'] = (key) => {
      if (showHelp) {
        showHelp = false
        render()
        return
      }
      if (entriesPanel.searchMode && key.length === 1 && key.charCodeAt(0) >= 32) {
        entriesPanel.appendSearchChar(key)
        render()
      }
    }

    return handlers
  }

  function handleNav (direction) {
    const panel = focusedPanel()
    if (panel === 'sessions') {
      direction === 'up' ? sessionsPanel.moveUp() : sessionsPanel.moveDown()
    } else if (panel === 'entries') {
      direction === 'up' ? entriesPanel.moveUp() : entriesPanel.moveDown()
    } else if (panel === 'detail') {
      direction === 'up'
        ? detailPanel.scrollUp()
        : detailPanel.scrollDown(layout.detail.contentHeight)
    }
    render()
  }

  // ── Lifecycle ──

  const inputHandler = createInputHandler(stdin, buildHandlers())

  function updateLayout () {
    const cols = stdout.columns || 80
    const rows = stdout.rows || 24
    layout = calculateLayout(cols, rows)
  }

  function onResize () {
    updateLayout()
    // Clear and re-render
    stdout.write('\x1b[2J')
    render()
  }

  function start () {
    running = true
    enterAltScreen(stdout)
    updateLayout()
    refreshSessions()

    // Auto-load first/specified session
    if (opts.sessionId) {
      loadSession(opts.sessionId)
    } else if (sessionsPanel.sessions.length > 0) {
      loadSession(sessionsPanel.sessions[0].id)
    }

    // Periodic session refresh
    sessionRefreshInterval = setInterval(() => {
      refreshSessions()
      render()
    }, 5000)

    stdout.on('resize', onResize)
    inputHandler.start()
    render()
  }

  function cleanup () {
    for (const c of watchCleanups) c()
    watchCleanups = []

    if (sessionRefreshInterval) {
      clearInterval(sessionRefreshInterval)
      sessionRefreshInterval = null
    }
  }

  function stop () {
    if (!running) return
    running = false

    inputHandler.stop()
    stdout.removeListener('resize', onResize)
    cleanup()
    leaveAltScreen(stdout)
    process.exit(0)
  }

  return { start, stop, cleanup, render, focusedPanel, refreshSessions, loadSession }
}

module.exports = { createDashboard }
