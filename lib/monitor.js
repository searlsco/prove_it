'use strict'

const fs = require('fs')
const path = require('path')
const { getProveItDir } = require('./config')
const { loadJson } = require('./io')

/**
 * Find the most recently modified session .jsonl file.
 * Excludes test-session* and _project_* files.
 */
function findLatestSession (sessionsDir) {
  let files
  try {
    files = fs.readdirSync(sessionsDir)
  } catch {
    return null
  }

  let best = null
  let bestMtime = 0

  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    if (f.startsWith('test-session')) continue
    if (f.startsWith('_project_')) continue

    const full = path.join(sessionsDir, f)
    try {
      const stat = fs.statSync(full)
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs
        best = f
      }
    } catch {}
  }

  if (!best) return null
  return best.replace('.jsonl', '')
}

/**
 * Find all active .jsonl files (sessions + project logs).
 */
function findAllLogFiles (sessionsDir) {
  let files
  try {
    files = fs.readdirSync(sessionsDir)
  } catch {
    return []
  }

  return files
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('test-session'))
    .map(f => path.join(sessionsDir, f))
}

/**
 * Load session state (.json) for a session ID.
 */
function loadSessionInfo (sessionsDir, sessionId) {
  const stateFile = path.join(sessionsDir, `${sessionId}.json`)
  return loadJson(stateFile)
}

/**
 * Format a timestamp as local HH:MM:SS.
 */
function formatTime (epochMs) {
  const d = new Date(epochMs)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Format a date+time for the header.
 */
function formatDateTime (isoString) {
  const d = new Date(isoString)
  return d.toLocaleString('en-US', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// ── ANSI color support ──

const COLOR_MAP = {
  PASS: '\x1b[32m',
  FAIL: '\x1b[31m',
  SKIP: '\x1b[33m',
  CRASH: '\x1b[35m',
  RUNNING: '\x1b[36m',
  APPEAL: '\x1b[34m'
}
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function useColor () {
  if (process.env.NO_COLOR !== undefined) return false
  try { return !!process.stdout.isTTY } catch { return false }
}

function stripAnsi (str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Format a single JSONL entry as a human-readable line.
 * Format: HH:MM:SS  STATUS  reviewer-name  reason
 */
function formatDuration (ms) {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${String(secs).padStart(2, '0')}s`
}

/**
 * Compute the visual width of a string accounting for tab stops (every 8 chars).
 */
function visualWidth (str) {
  let col = 0
  for (const ch of str) {
    if (ch === '\t') {
      col = (Math.floor(col / 8) + 1) * 8
    } else {
      col++
    }
  }
  return col
}

function formatEntry (entry, maxWidth, opts) {
  const time = formatTime(entry.at)
  const rawStatus = (entry.status || '???')
  const reviewer = entry.reviewer || 'unknown'
  const duration = entry.durationMs != null ? `[${formatDuration(entry.durationMs)}]` : ''
  const hook = entry.hookEvent ? `(${entry.hookEvent})` : ''

  const sessionPrefix = opts && opts.showSession
    ? `[${(entry.sessionId || 'git').slice(0, 8).padEnd(8)}]\t`
    : ''
  const trigger = entry.triggerProgress ? `{${entry.triggerProgress}}` : ''

  const color = useColor()
  const statusColor = color ? (COLOR_MAP[rawStatus] || '') : ''
  const reset = color ? RESET : ''
  const dim = color ? DIM : ''

  // Build suffix parts (duration, hook, trigger) — only show non-empty ones
  const suffixParts = [duration, hook, trigger].filter(Boolean)
  const suffix = suffixParts.length > 0 ? '\t' + suffixParts.join(' ') : ''

  const plainPrefix = `${sessionPrefix}${time}\t${rawStatus}\t${reviewer}${suffix}\t`

  let reason = (entry.reason || '').split('\n')[0]
  const prefixWidth = visualWidth(plainPrefix)
  if (maxWidth && prefixWidth + reason.length > maxWidth) {
    const available = maxWidth - prefixWidth - 1
    reason = available > 0 ? reason.slice(0, available) + '\u2026' : ''
  }

  const coloredStatus = statusColor ? `${statusColor}${rawStatus}${reset}` : rawStatus
  const coloredSuffixParts = []
  if (duration) coloredSuffixParts.push(duration)
  if (hook) coloredSuffixParts.push(dim ? `${dim}${hook}${reset}` : hook)
  if (trigger) coloredSuffixParts.push(dim ? `${dim}${trigger}${reset}` : trigger)
  const coloredSuffix = coloredSuffixParts.length > 0 ? '\t' + coloredSuffixParts.join(' ') : ''

  return `${sessionPrefix}${time}\t${coloredStatus}\t${reviewer}${coloredSuffix}\t${reason}`
}

/**
 * Get terminal width, defaulting to 120.
 */
function termWidth () {
  try {
    return process.stdout.columns || 120
  } catch {
    return 120
  }
}

/**
 * Read all entries from a .jsonl file.
 */
function readEntries (filePath) {
  let content
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }

  const entries = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {}
  }
  return entries
}

/**
 * Print a session header.
 */
function printHeader (sessionId, info) {
  const shortId = sessionId.slice(0, 8)
  const project = info?.project_dir || '(unknown)'
  const started = info?.started_at ? formatDateTime(info.started_at) : '(unknown)'
  console.log(`Session: ${shortId} | ${project} | started ${started}`)
  console.log('')
}

/**
 * Watch a single file for new entries appended.
 * Returns a cleanup function.
 */
function watchFile (filePath, offset, width, opts) {
  let currentSize = offset

  const listener = (curr) => {
    if (curr.size <= currentSize) return

    let fd
    try {
      fd = fs.openSync(filePath, 'r')
      const buf = Buffer.alloc(curr.size - currentSize)
      fs.readSync(fd, buf, 0, buf.length, currentSize)
      fs.closeSync(fd)
      currentSize = curr.size

      const chunk = buf.toString('utf8')
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (opts && opts.statusFilter && !opts.statusFilter.includes(entry.status)) continue
          console.log(formatEntry(entry, width, opts))
        } catch {}
      }
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd) } catch {}
    }
  }

  fs.watchFile(filePath, { interval: 500 }, listener)
  return () => fs.unwatchFile(filePath, listener)
}

/**
 * Run the monitor for a specific session.
 */
function monitorSession (sessionId, opts) {
  const sessionsDir = path.join(getProveItDir(), 'sessions')
  const logFile = path.join(sessionsDir, `${sessionId}.jsonl`)
  const width = termWidth()

  // Load and print session info
  const info = loadSessionInfo(sessionsDir, sessionId)
  printHeader(sessionId, info)

  // Print existing entries
  const entries = readEntries(logFile)
  for (const entry of entries) {
    if (opts && opts.statusFilter && !opts.statusFilter.includes(entry.status)) continue
    console.log(formatEntry(entry, width, opts))
  }

  // Get current file size for watch offset
  let offset = 0
  try {
    const stat = fs.statSync(logFile)
    offset = stat.size
  } catch {}

  // Also find associated project log
  const cleanups = []
  cleanups.push(watchFile(logFile, offset, width, opts))

  if (info?.project_dir) {
    const crypto = require('crypto')
    const hash = crypto.createHash('sha256').update(info.project_dir).digest('hex').slice(0, 12)
    const projectLog = path.join(sessionsDir, `_project_${hash}.jsonl`)
    if (fs.existsSync(projectLog)) {
      let projectOffset = 0
      try {
        const stat = fs.statSync(projectLog)
        projectOffset = stat.size
      } catch {}
      cleanups.push(watchFile(projectLog, projectOffset, width, opts))
    }
  }

  if (entries.length > 0) console.log('')
  console.log('watching for new entries\u2026 (ctrl-c to stop)')

  process.on('SIGINT', () => {
    for (const cleanup of cleanups) cleanup()
    process.exit(0)
  })
}

/**
 * Run the monitor for all active log files.
 */
function monitorAll (opts) {
  const sessionsDir = path.join(getProveItDir(), 'sessions')
  const logFiles = findAllLogFiles(sessionsDir)
  const width = termWidth()

  if (logFiles.length === 0) {
    console.log('No log files found.')
    return
  }

  console.log(`Monitoring ${logFiles.length} log files\n`)

  // Print recent entries from all files (last 20 combined)
  const allEntries = []
  for (const f of logFiles) {
    for (const entry of readEntries(f)) {
      allEntries.push(entry)
    }
  }
  allEntries.sort((a, b) => a.at - b.at)
  const recent = allEntries.slice(-20)
  for (const entry of recent) {
    if (opts && opts.statusFilter && !opts.statusFilter.includes(entry.status)) continue
    console.log(formatEntry(entry, width, opts))
  }

  // Watch all files
  const cleanups = []
  const watchedFiles = new Set()
  for (const f of logFiles) {
    let offset = 0
    try {
      const stat = fs.statSync(f)
      offset = stat.size
    } catch {}
    cleanups.push(watchFile(f, offset, width, opts))
    watchedFiles.add(f)
  }

  // Re-scan for new log files every 5 seconds
  const scanInterval = setInterval(() => {
    const currentFiles = findAllLogFiles(sessionsDir)
    for (const f of currentFiles) {
      if (watchedFiles.has(f)) continue
      watchedFiles.add(f)
      cleanups.push(watchFile(f, 0, width, opts))
    }
  }, 5000)

  if (recent.length > 0) console.log('')
  console.log('watching for new entries\u2026 (ctrl-c to stop)')

  process.on('SIGINT', () => {
    clearInterval(scanInterval)
    for (const cleanup of cleanups) cleanup()
    process.exit(0)
  })
}

/**
 * List all sessions with summary info.
 */
function listSessions () {
  const sessionsDir = path.join(getProveItDir(), 'sessions')
  let files
  try {
    files = fs.readdirSync(sessionsDir)
  } catch {
    console.log('No sessions found.')
    return
  }

  const sessions = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    if (f.startsWith('test-session')) continue
    if (f.startsWith('_project_')) continue

    const sessionId = f.replace('.json', '')
    const info = loadSessionInfo(sessionsDir, sessionId)
    if (!info) continue

    const logFile = path.join(sessionsDir, `${sessionId}.jsonl`)
    let entryCount = 0
    try {
      const content = fs.readFileSync(logFile, 'utf8')
      entryCount = content.trim().split('\n').filter(l => l.trim()).length
    } catch {}

    sessions.push({
      id: sessionId,
      project: info.project_dir || '(unknown)',
      started: info.started_at || null,
      entries: entryCount
    })
  }

  if (sessions.length === 0) {
    console.log('No sessions found.')
    return
  }

  // Sort by started_at descending (most recent first)
  sessions.sort((a, b) => {
    if (!a.started && !b.started) return 0
    if (!a.started) return 1
    if (!b.started) return -1
    return new Date(b.started) - new Date(a.started)
  })

  // Print table
  console.log('ID        Project                              Started               Entries')
  console.log('--------  -----------------------------------  --------------------  -------')
  for (const s of sessions) {
    const shortId = s.id.slice(0, 8)
    const project = s.project.length > 35 ? '\u2026' + s.project.slice(-34) : s.project.padEnd(35)
    const started = s.started ? formatDateTime(s.started).padEnd(20) : '(unknown)'.padEnd(20)
    console.log(`${shortId}  ${project}  ${started}  ${String(s.entries).padStart(7)}`)
  }
}

/**
 * Main entry point for the monitor command.
 *
 * @param {object} opts
 * @param {boolean} opts.all - Monitor all log files
 * @param {boolean} opts.list - List all sessions
 * @param {string} [opts.sessionId] - Specific session ID to monitor
 */
function monitor (opts) {
  if (opts.list) {
    return listSessions()
  }

  const displayOpts = {}
  if (opts.showSession) displayOpts.showSession = true
  if (opts.statusFilter) displayOpts.statusFilter = opts.statusFilter

  if (opts.all) {
    return monitorAll(Object.keys(displayOpts).length > 0 ? displayOpts : undefined)
  }

  const sessionsDir = path.join(getProveItDir(), 'sessions')

  let sessionId = opts.sessionId
  if (!sessionId) {
    sessionId = findLatestSession(sessionsDir)
    if (!sessionId) {
      console.error('No prove_it sessions found.')
      console.error(`Looked in: ${sessionsDir}`)
      process.exit(1)
    }
  }

  // Verify the session log exists
  const logFile = path.join(sessionsDir, `${sessionId}.jsonl`)
  if (!fs.existsSync(logFile)) {
    // Try prefix match for short IDs
    const match = findByPrefix(sessionsDir, sessionId)
    if (match) {
      return monitorSession(match, Object.keys(displayOpts).length > 0 ? displayOpts : undefined)
    }
    console.error(`Session log not found: ${logFile}`)
    process.exit(1)
  }

  return monitorSession(sessionId, Object.keys(displayOpts).length > 0 ? displayOpts : undefined)
}

/**
 * Find a session ID by prefix match.
 */
function findByPrefix (sessionsDir, prefix) {
  let files
  try {
    files = fs.readdirSync(sessionsDir)
  } catch {
    return null
  }

  const matches = files
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('_project_') && !f.startsWith('test-session'))
    .filter(f => f.startsWith(prefix))
    .map(f => f.replace('.jsonl', ''))

  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    console.error(`Ambiguous session prefix "${prefix}". Matches:`)
    for (const m of matches) console.error(`  ${m}`)
    process.exit(1)
  }
  return null
}

module.exports = { monitor, findLatestSession, listSessions, formatEntry, formatTime, formatDuration, useColor, stripAnsi, visualWidth }
