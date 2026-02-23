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
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
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
  EXEC: '\x1b[36m',
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
 * Format: HH:MM  STATUS  reviewer  dur  reason  hook-tag
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

/**
 * Convert a hook event name to a lowercase kebab-case tag.
 * PascalCase events (PreToolUse, SessionStart, Stop) become pre-tool-use,
 * session-start, stop. Already-kebab names (pre-commit) pass through.
 */
function normalizeHookTag (hookEvent) {
  return hookEvent.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Middle-truncate a file path, keeping the start and filename.
 */
function middleTruncatePath (p, maxLen) {
  if (p.length <= maxLen) return p
  if (maxLen <= 3) return p.slice(0, maxLen - 1) + '\u2026'
  const lastSlash = p.lastIndexOf('/')
  if (lastSlash < 0) return p.slice(0, maxLen - 1) + '\u2026'
  const tail = p.slice(lastSlash)
  if (tail.length + 1 >= maxLen) return p.slice(0, maxLen - 1) + '\u2026'
  const headLen = maxLen - tail.length - 1
  return p.slice(0, headLen) + '\u2026' + tail
}

/**
 * Truncate a reason string to fit in available width.
 * Tries middle-truncating file paths before hard-truncating.
 */
function truncateReason (reason, available) {
  if (available <= 0) return ''
  if (reason.length <= available) return reason
  if (/^[/.]/.test(reason)) {
    const truncated = middleTruncatePath(reason, available)
    if (truncated.length <= available) return truncated
  }
  return available > 1 ? reason.slice(0, available - 1) + '\u2026' : '\u2026'
}

/**
 * Progressively truncate a reason to fit maxWidth.
 * 1. Drop hook tag  2. Middle-truncate paths  3. Hard-truncate
 */
function progressiveTruncate (reason, prefixWidth, hookTag, maxWidth) {
  if (!reason) return { reason: '', showHookTag: !!hookTag }
  const hookSpace = hookTag ? 2 + hookTag.length : 0
  const availableWithHook = maxWidth - prefixWidth - hookSpace
  if (availableWithHook >= reason.length) return { reason, showHookTag: true }
  const available = maxWidth - prefixWidth
  if (available >= reason.length) return { reason, showHookTag: false }
  return { reason: truncateReason(reason, available), showHookTag: false }
}

function formatEntry (entry, maxWidth, opts) {
  const time = formatTime(entry.at)
  const rawStatus = (entry.status || '???')
  const displayStatus = rawStatus === 'RUNNING' ? 'EXEC' : rawStatus
  const reviewer = entry.reviewer || 'unknown'
  const duration = entry.durationMs != null ? formatDuration(entry.durationMs) : ''
  const hookTag = entry.hookEvent ? normalizeHookTag(entry.hookEvent) : ''

  const sessionPrefix = opts && opts.showSession
    ? `[${(entry.sessionId || 'git').slice(0, 8).padEnd(8)}]  `
    : ''

  const color = useColor()
  const statusColor = color ? (COLOR_MAP[displayStatus] || '') : ''
  const reset = color ? RESET : ''
  const dim = color ? DIM : ''

  // Plain prefix: "time  STATUS  reviewer" + optional "  dur"
  let plainCore = `${time}  ${displayStatus}  ${reviewer}`
  if (duration) plainCore += `  ${duration}`
  const plainPrefix = sessionPrefix + plainCore

  let reason = (entry.reason || '').split('\n')[0]
  let showTag = !!hookTag

  if (maxWidth && (reason || hookTag)) {
    const prefixWidth = plainPrefix.length + 2
    const result = progressiveTruncate(reason, prefixWidth, hookTag, maxWidth)
    reason = result.reason
    showTag = result.showHookTag && !!hookTag
  }

  // Colored output
  const coloredTime = dim ? `${dim}${time}${reset}` : time
  const coloredStatus = statusColor ? `${statusColor}${displayStatus}${reset}` : displayStatus
  const coloredDur = duration
    ? (dim ? `  ${dim}${duration}${reset}` : `  ${duration}`)
    : ''

  let line = `${sessionPrefix}${coloredTime}  ${coloredStatus}  ${reviewer}${coloredDur}`

  if (reason) line += `  ${reason}`

  if (showTag) {
    const coloredTag = dim ? `${dim}${hookTag}${reset}` : hookTag
    if (maxWidth) {
      const plainSoFar = plainPrefix + (reason ? `  ${reason}` : '')
      const gap = maxWidth - plainSoFar.length - hookTag.length
      line += (gap >= 2 ? ' '.repeat(gap) : '  ') + coloredTag
    } else {
      line += '  ' + coloredTag
    }
  }

  return line
}

/**
 * Format verbose data from an entry as a box-drawn block.
 * Returns an array of lines (without trailing newlines), or empty array if no verbose data.
 */
function formatVerbose (entry) {
  if (!entry.verbose) return []
  const v = entry.verbose
  const color = useColor()
  const dim = color ? DIM : ''
  const reset = color ? RESET : ''

  const lines = []
  const INDENT = '          '

  function box (label, content) {
    if (content == null) return
    const text = String(content).trimEnd()
    if (!text) return
    lines.push(`${INDENT}${dim}\u250c\u2500 ${reset}${label}${dim} ${'─'.repeat(Math.max(0, 40 - label.length))}${reset}`)
    for (const l of text.split('\n')) {
      lines.push(`${INDENT}${dim}\u2502${reset} ${l}`)
    }
    lines.push(`${INDENT}${dim}\u2514${'─'.repeat(45)}${reset}`)
  }

  // Agent check verbose data
  if (v.prompt != null) {
    const modelSuffix = v.model ? ` (model: ${v.model})` : ''
    box(`prompt${modelSuffix}`, v.prompt)
    box('response', v.response)
    if (v.backchannel) {
      lines.push(`${INDENT}${dim}\u2502${reset} backchannel: active`)
    }
  }

  // Script check verbose data
  if (v.command != null && v.prompt == null) {
    box('command', v.command)
    const exitSuffix = v.exitCode != null ? ` (exit ${v.exitCode})` : ''
    box(`output${exitSuffix}`, v.output)
  }

  return lines
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
function readChunk (filePath, from, to, width, opts) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(to - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    fs.closeSync(fd)

    const chunk = buf.toString('utf8')
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (opts && opts.statusFilter && !opts.statusFilter.includes(entry.status)) continue
        console.log(formatEntry(entry, width, opts))
        if (opts && opts.verbose) {
          for (const vl of formatVerbose(entry)) console.log(vl)
        }
      } catch {}
    }
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

/**
 * Watch a file for new entries, calling a callback with each parsed entry.
 * Returns a cleanup function.
 */
function watchFileCallback (filePath, offset, callback) {
  let currentSize = offset

  // Read any content already beyond the offset
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > currentSize) {
      readChunkCallback(filePath, currentSize, stat.size, callback)
      currentSize = stat.size
    }
  } catch {}

  const listener = (curr) => {
    if (curr.size <= currentSize) return
    readChunkCallback(filePath, currentSize, curr.size, callback)
    currentSize = curr.size
  }

  fs.watchFile(filePath, { interval: 500 }, listener)
  return () => fs.unwatchFile(filePath, listener)
}

function readChunkCallback (filePath, from, to, callback) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(to - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    fs.closeSync(fd)

    const chunk = buf.toString('utf8')
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      try {
        callback(JSON.parse(line))
      } catch {}
    }
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

function watchFile (filePath, offset, width, opts) {
  let currentSize = offset

  // Immediately read any content already in the file beyond the offset.
  // Without this, files discovered by re-scan that were fully written before
  // the watch started would never be displayed (fs.watchFile only fires on
  // stat changes *after* the watch begins).
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > currentSize) {
      readChunk(filePath, currentSize, stat.size, width, opts)
      currentSize = stat.size
    }
  } catch {}

  const listener = (curr) => {
    if (curr.size <= currentSize) return
    readChunk(filePath, currentSize, curr.size, width, opts)
    currentSize = curr.size
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
    if (opts && opts.verbose) {
      for (const vl of formatVerbose(entry)) console.log(vl)
    }
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
    const hash = projectHash(info.project_dir)
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
 * Compute the project hash used for project log filenames.
 */
function projectHash (projectDir) {
  const crypto = require('crypto')
  return crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 12)
}

/**
 * Find log files that belong to a specific project.
 * Returns the project aggregate log + any session logs whose .json state matches.
 */
function findProjectLogFiles (sessionsDir, projectDir) {
  const resolvedDir = path.resolve(projectDir)
  const results = []
  const seen = new Set()

  // Project aggregate log—session.js hashes the absolute projectDir from the
  // dispatcher (CLAUDE_PROJECT_DIR), so we must hash the resolved path to match.
  const hash = projectHash(resolvedDir)
  const projectLog = path.join(sessionsDir, `_project_${hash}.jsonl`)
  if (fs.existsSync(projectLog)) {
    results.push(projectLog)
    seen.add(projectLog)
  }

  // Session-specific logs whose state matches
  let files
  try {
    files = fs.readdirSync(sessionsDir)
  } catch {
    return results
  }

  for (const f of files) {
    if (!f.endsWith('.json')) continue
    if (f.startsWith('test-session') || f.startsWith('_project_')) continue
    const sessionId = f.replace('.json', '')
    const info = loadSessionInfo(sessionsDir, sessionId)
    if (!info || path.resolve(info.project_dir || '') !== resolvedDir) continue

    const logFile = path.join(sessionsDir, `${sessionId}.jsonl`)
    if (fs.existsSync(logFile) && !seen.has(logFile)) results.push(logFile)

    // Also pick up the project log via the session's raw project_dir
    // (covers cases where the --project arg differs in form from the stored path)
    if (info.project_dir) {
      const sessionHash = projectHash(info.project_dir)
      const sessionProjectLog = path.join(sessionsDir, `_project_${sessionHash}.jsonl`)
      if (fs.existsSync(sessionProjectLog) && !seen.has(sessionProjectLog)) {
        results.push(sessionProjectLog)
        seen.add(sessionProjectLog)
      }
    }
  }

  return results
}

/**
 * Run the monitor for a specific project directory.
 */
function monitorProject (projectDir, opts) {
  const sessionsDir = path.join(getProveItDir(), 'sessions')
  const resolvedDir = path.resolve(projectDir)
  const logFiles = findProjectLogFiles(sessionsDir, resolvedDir)
  const width = termWidth()

  if (logFiles.length === 0) {
    console.log(`No log files found for project: ${resolvedDir}`)
    return
  }

  console.log(`Project: ${resolvedDir}`)
  console.log(`Monitoring ${logFiles.length} log files\n`)

  // Print recent entries from all matching files (last 20 combined)
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
    if (opts && opts.verbose) {
      for (const vl of formatVerbose(entry)) console.log(vl)
    }
  }

  // Watch all matching files
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

  // Re-scan for new matching log files every 5 seconds
  const scanInterval = setInterval(() => {
    const currentFiles = findProjectLogFiles(sessionsDir, resolvedDir)
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
 * Run the monitor for all active log files.
 */
function monitorAll (opts) {
  const sessionsDir = path.join(getProveItDir(), 'sessions')

  // If --project is set, delegate to monitorProject
  if (opts && opts.project) {
    return monitorProject(opts.project, opts)
  }

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
    if (opts && opts.verbose) {
      for (const vl of formatVerbose(entry)) console.log(vl)
    }
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
 * Build a sessions list array (data only, no printing).
 *
 * @param {string} sessionsDir - Path to sessions directory
 * @param {string} [projectDir] - If provided, only include sessions for this project
 * @returns {Array<{id, project, started, entries}>} sorted by started_at descending
 */
function getSessionsList (sessionsDir, projectDir) {
  const filterDir = projectDir ? path.resolve(projectDir) : null
  let files
  try {
    files = fs.readdirSync(sessionsDir)
  } catch {
    return []
  }

  const sessions = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    if (f.startsWith('test-session')) continue
    if (f.startsWith('_project_')) continue

    const sessionId = f.replace('.json', '')
    const info = loadSessionInfo(sessionsDir, sessionId)
    if (!info) continue

    if (filterDir && path.resolve(info.project_dir || '') !== filterDir) continue

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

  sessions.sort((a, b) => {
    if (!a.started && !b.started) return 0
    if (!a.started) return 1
    if (!b.started) return -1
    return new Date(b.started) - new Date(a.started)
  })

  return sessions
}

/**
 * List all sessions with summary info.
 *
 * @param {string} [projectDir] - If provided, only show sessions for this project directory
 */
function listSessions (projectDir) {
  const sessionsDir = path.join(getProveItDir(), 'sessions')
  const sessions = getSessionsList(sessionsDir, projectDir)

  if (sessions.length === 0) {
    console.log('No sessions found.')
    return
  }

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
 * @param {string} [opts.project] - Project directory to scope to
 * @param {boolean} [opts.verbose] - Show full prompts, responses, and script output
 */
function monitor (opts) {
  if (opts.list) {
    return listSessions(opts.project || undefined)
  }

  const displayOpts = {}
  if (opts.showSession) displayOpts.showSession = true
  if (opts.statusFilter) displayOpts.statusFilter = opts.statusFilter
  if (opts.verbose) displayOpts.verbose = true
  if (opts.project) displayOpts.project = opts.project

  // --project without --all or session ID → monitor that project
  if (opts.project && !opts.all && !opts.sessionId) {
    return monitorProject(opts.project, Object.keys(displayOpts).length > 0 ? displayOpts : undefined)
  }

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

module.exports = { monitor, findLatestSession, listSessions, getSessionsList, monitorProject, findProjectLogFiles, projectHash, formatEntry, formatVerbose, formatTime, formatDuration, useColor, stripAnsi, visualWidth, normalizeHookTag, middleTruncatePath, truncateReason, progressiveTruncate, watchFile, watchFileCallback, readEntries, loadSessionInfo, readChunkCallback }
