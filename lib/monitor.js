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

/**
 * Format a single JSONL entry as a human-readable line.
 * Format: HH:MM:SS  STATUS  reviewer-name  reason
 */
function formatEntry (entry, maxWidth) {
  const time = formatTime(entry.at)
  const status = (entry.status || '???').padEnd(5)
  const reviewer = (entry.reviewer || 'unknown').padEnd(20)
  const prefix = `${time}  ${status}  ${reviewer}  `

  let reason = (entry.reason || '').split('\n')[0]
  if (maxWidth && prefix.length + reason.length > maxWidth) {
    reason = reason.slice(0, maxWidth - prefix.length - 1) + '\u2026'
  }

  return `${prefix}${reason}`
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
function watchFile (filePath, offset, width) {
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
          console.log(formatEntry(entry, width))
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
function monitorSession (sessionId) {
  const sessionsDir = path.join(getProveItDir(), 'sessions')
  const logFile = path.join(sessionsDir, `${sessionId}.jsonl`)
  const width = termWidth()

  // Load and print session info
  const info = loadSessionInfo(sessionsDir, sessionId)
  printHeader(sessionId, info)

  // Print existing entries
  const entries = readEntries(logFile)
  for (const entry of entries) {
    console.log(formatEntry(entry, width))
  }

  // Get current file size for watch offset
  let offset = 0
  try {
    const stat = fs.statSync(logFile)
    offset = stat.size
  } catch {}

  // Also find associated project log
  const cleanups = []
  cleanups.push(watchFile(logFile, offset, width))

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
      cleanups.push(watchFile(projectLog, projectOffset, width))
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
function monitorAll () {
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
    console.log(formatEntry(entry, width))
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
    cleanups.push(watchFile(f, offset, width))
    watchedFiles.add(f)
  }

  // Re-scan for new log files every 5 seconds
  const scanInterval = setInterval(() => {
    const currentFiles = findAllLogFiles(sessionsDir)
    for (const f of currentFiles) {
      if (watchedFiles.has(f)) continue
      watchedFiles.add(f)
      cleanups.push(watchFile(f, 0, width))
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
 * Main entry point for the monitor command.
 *
 * @param {object} opts
 * @param {boolean} opts.all - Monitor all log files
 * @param {string} [opts.sessionId] - Specific session ID to monitor
 */
function monitor (opts) {
  if (opts.all) {
    return monitorAll()
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
      return monitorSession(match)
    }
    console.error(`Session log not found: ${logFile}`)
    process.exit(1)
  }

  return monitorSession(sessionId)
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

module.exports = { monitor, findLatestSession, formatEntry, formatTime }
