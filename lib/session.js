const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson, writeJson, ensureDir } = require('./io')
const { getProveItDir } = require('./config')

function projectLogName (projectDir) {
  const hash = crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 12)
  return `_project_${hash}.jsonl`
}

function logReview (sessionId, projectDir, reviewerType, status, reason) {
  const baseDir = path.join(getProveItDir(), 'sessions')
  const fileName = sessionId ? `${sessionId}.jsonl` : projectLogName(projectDir)
  const logFile = path.join(baseDir, fileName)

  const entry = {
    at: Date.now(),
    reviewer: reviewerType,
    status,
    reason: reason || null,
    projectDir,
    sessionId: sessionId || null
  }

  try {
    ensureDir(baseDir)
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // Best-effort logging - don't fail the hook if logging fails
  }
}

function loadSessionState (sessionId, key) {
  if (!sessionId) return null
  const stateFile = path.join(getProveItDir(), 'sessions', `${sessionId}.json`)
  const data = loadJson(stateFile)
  return data?.[key] ?? null
}

function saveSessionState (sessionId, key, value) {
  if (!sessionId) return
  const baseDir = path.join(getProveItDir(), 'sessions')
  const stateFile = path.join(baseDir, `${sessionId}.json`)
  try {
    ensureDir(baseDir)
    const data = loadJson(stateFile) || {}
    data[key] = value
    writeJson(stateFile, data)
  } catch {
    // Best-effort — don't fail the hook
  }
}

function getSessionJsonlPath (sessionId, projectDir) {
  if (!sessionId) return null
  const encoded = projectDir.replace(/[^a-zA-Z0-9-]/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
}

function getFileHistoryDir (sessionId) {
  if (!sessionId) return null
  return path.join(os.homedir(), '.claude', 'file-history', sessionId)
}

function getLatestSnapshot (sessionId, projectDir) {
  const jsonlPath = getSessionJsonlPath(sessionId, projectDir)
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return null

  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').reverse()
    for (const line of lines) {
      if (!line.trim()) continue
      const entry = JSON.parse(line)
      if (entry.type === 'file-history-snapshot' && entry.snapshot) {
        return entry.snapshot
      }
    }
  } catch (e) {
    console.error(`prove_it: failed to read snapshot: ${e.message}`)
  }
  return null
}

function getEditedFilesSince (sessionId, projectDir, previousMessageId) {
  const currentSnapshot = getLatestSnapshot(sessionId, projectDir)
  if (!currentSnapshot) return []

  const currentFiles = Object.keys(currentSnapshot.trackedFileBackups || {})
  if (!previousMessageId) return currentFiles

  const jsonlPath = getSessionJsonlPath(sessionId, projectDir)
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return currentFiles

  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')
    let previousSnapshot = null
    for (const line of lines) {
      if (!line.trim()) continue
      const entry = JSON.parse(line)
      if (entry.type === 'file-history-snapshot' && entry.snapshot?.messageId === previousMessageId) {
        previousSnapshot = entry.snapshot
        break
      }
    }

    if (!previousSnapshot) return currentFiles

    const previousBackups = previousSnapshot.trackedFileBackups || {}
    const currentBackups = currentSnapshot.trackedFileBackups || {}
    const editedFiles = []

    for (const [filePath, info] of Object.entries(currentBackups)) {
      const prev = previousBackups[filePath]
      if (!prev || prev.version !== info.version) {
        editedFiles.push(filePath)
      }
    }
    return editedFiles
  } catch {
    return currentFiles
  }
}

function generateDiffsSince (sessionId, projectDir, previousMessageId, maxChars) {
  const editedFiles = getEditedFilesSince(sessionId, projectDir, previousMessageId)
  if (editedFiles.length === 0) return []

  const fileHistoryDir = getFileHistoryDir(sessionId)
  const currentSnapshot = getLatestSnapshot(sessionId, projectDir)
  if (!currentSnapshot || !fileHistoryDir) return []

  const diffs = []
  let totalChars = 0

  for (const filePath of editedFiles) {
    const info = currentSnapshot.trackedFileBackups[filePath]
    if (!info || !info.backupFileName) continue

    const backupPath = path.join(fileHistoryDir, info.backupFileName)
    if (!fs.existsSync(backupPath)) continue

    const currentPath = path.isAbsolute(filePath) ? filePath : path.join(projectDir, filePath)
    if (!fs.existsSync(currentPath)) continue

    try {
      const backupContent = fs.readFileSync(backupPath, 'utf8')
      const currentContent = fs.readFileSync(currentPath, 'utf8')
      const diff = generateUnifiedDiff(filePath, backupContent, currentContent)

      if (diff && (!maxChars || totalChars + diff.length <= maxChars)) {
        diffs.push({ file: filePath, diff })
        totalChars += diff.length
      } else if (diff && maxChars) {
        const remaining = maxChars - totalChars
        if (remaining > 100) {
          diffs.push({ file: filePath, diff: diff.slice(0, remaining) + '\n... (truncated)' })
        }
        break
      }
    } catch {}
  }
  return diffs
}

function generateUnifiedDiff (fileName, oldContent, newContent) {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  if (oldContent === newContent) return null

  const diff = [`--- a/${fileName}`, `+++ b/${fileName}`]
  let inHunk = false
  let hunkOldStart = 0
  let hunkNewStart = 0
  let hunkLines = []
  let oldIdx = 0
  let newIdx = 0

  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]

    if (oldLine !== newLine) {
      if (!inHunk) {
        inHunk = true
        const ctxStart = Math.max(0, i - 2)
        hunkOldStart = ctxStart
        hunkNewStart = ctxStart
        oldIdx = ctxStart
        newIdx = ctxStart
        for (let j = ctxStart; j < i; j++) {
          if (oldLines[j] !== undefined) {
            hunkLines.push(` ${oldLines[j]}`)
            oldIdx++
            newIdx++
          }
        }
      }
      if (oldLine !== undefined && newLine !== undefined) {
        hunkLines.push(`-${oldLine}`)
        hunkLines.push(`+${newLine}`)
        oldIdx++
        newIdx++
      } else if (oldLine !== undefined) {
        hunkLines.push(`-${oldLine}`)
        oldIdx++
      } else if (newLine !== undefined) {
        hunkLines.push(`+${newLine}`)
        newIdx++
      }
    } else if (inHunk) {
      hunkLines.push(` ${oldLine}`)
      oldIdx++
      newIdx++
      if (hunkLines.filter((l) => l.startsWith(' ')).length >= 2) {
        const oldCount = oldIdx - hunkOldStart
        const newCount = newIdx - hunkNewStart
        diff.push(`@@ -${hunkOldStart + 1},${oldCount} +${hunkNewStart + 1},${newCount} @@`)
        diff.push(...hunkLines)
        hunkLines = []
        inHunk = false
      }
    }
  }

  if (hunkLines.length > 0) {
    const oldCount = oldIdx - hunkOldStart
    const newCount = newIdx - hunkNewStart
    diff.push(`@@ -${hunkOldStart + 1},${oldCount} +${hunkNewStart + 1},${newCount} @@`)
    diff.push(...hunkLines)
  }

  return diff.length > 2 ? diff.join('\n') : null
}

function recordWrite (sessionId, lineCount) {
  if (!sessionId || lineCount <= 0) return
  const current = loadSessionState(sessionId, 'writtenLines') || 0
  saveSessionState(sessionId, 'writtenLines', current + lineCount)
}

function recordTaskRun (sessionId, taskName) {
  if (!sessionId || !taskName) return
  const runs = loadSessionState(sessionId, 'taskRuns') || {}
  const current = loadSessionState(sessionId, 'writtenLines') || 0
  runs[taskName] = current
  saveSessionState(sessionId, 'taskRuns', runs)
}

function linesWrittenSince (sessionId, taskName) {
  if (!sessionId) return 0
  const total = loadSessionState(sessionId, 'writtenLines') || 0
  const runs = loadSessionState(sessionId, 'taskRuns') || {}
  const lastRun = runs[taskName]
  if (lastRun === undefined || lastRun === null) return total
  return total - lastRun
}

module.exports = {
  logReview,
  projectLogName,
  loadSessionState,
  saveSessionState,
  getLatestSnapshot,
  generateDiffsSince,
  generateUnifiedDiff,
  recordWrite,
  recordTaskRun,
  linesWrittenSince
}
