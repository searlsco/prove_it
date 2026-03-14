const fs = require('fs')
const path = require('path')
const { getSignal, getPhase, getFileEdits } = require('./session')
const { isSourceFile } = require('./globs')
const { churnSinceRef, sanitizeRefName, grossChurnSince } = require('./git')
const { resolveTestRoot, getLatestMtime, loadRunData, runResult } = require('./testing')

const BUILTIN_EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']

// Activity conditions are always fully evaluated (no short-circuit) because
// churn functions have bootstrap side effects (churnSinceRef and grossChurnSince
// create git refs on first call).
const ACTIVITY_KEYS = [
  'linesChanged', 'linesWritten',
  'sourcesModifiedSinceLastRun', 'toolsUsed', 'sourceFilesEditedThisTurn'
]

/**
 * Evaluate the sourceFilesEditedThisTurn trigger.
 * @returns {true} if the trigger passes, or a skip-reason string
 */
function evaluateSourceFilesEditedThisTurn (when, context) {
  if (context.hookEvent === 'SessionStart') {
    return 'Skipped because sourceFilesEditedThisTurn is not applicable to SessionStart'
  }
  if (context.hookEvent === 'PreToolUse') {
    const editTools = context.fileEditingTools || BUILTIN_EDIT_TOOLS
    if (!editTools.includes(context.toolName)) {
      return 'Skipped because no source files were edited this turn'
    }
    const filePath = context.toolInput?.file_path || context.toolInput?.notebook_path || ''
    if (!filePath) {
      return 'Skipped because no source files were edited this turn'
    }
    let resolvedRoot = context.rootDir
    try { resolvedRoot = fs.realpathSync(context.rootDir) } catch {}
    let resolvedFile = filePath
    if (path.isAbsolute(filePath)) {
      try { resolvedFile = fs.realpathSync(filePath) } catch {
        try {
          const dir = fs.realpathSync(path.dirname(filePath))
          resolvedFile = path.join(dir, path.basename(filePath))
        } catch {}
      }
    }
    const relativePath = path.isAbsolute(resolvedFile)
      ? path.relative(resolvedRoot, resolvedFile)
      : filePath
    if (relativePath.startsWith('..') || !isSourceFile(relativePath, context.rootDir, context.sources)) {
      return 'Skipped because no source files were edited this turn'
    }
  } else if (context.hookEvent === 'Stop') {
    const edits = getFileEdits(context.sessionId)
    if (!edits || edits.files.length === 0) {
      return 'Skipped because no source files were edited this turn'
    }
  }
  return true
}

/**
 * Evaluate a single `when` clause (object form).
 *
 * All conditions are AND'd—every condition must pass.
 *
 * Two-phase implementation for efficiency:
 *   Phase 1—Cheap gates (short-circuit OK): fileExists, envSet, envNotSet,
 *     variablesPresent, signal. These are pure lookups with no side effects.
 *   Phase 2—Activity conditions (no short-circuit): linesChanged, linesWritten,
 *     sourcesModifiedSinceLastRun, toolsUsed, sourceFilesEditedThisTurn. Always fully
 *     evaluated because churn functions have bootstrap side effects.
 *
 * @param {object} when - a single when condition object
 * @param {object} context - dispatch context
 * @param {string} [taskName] - task name, needed for churn-based conditions
 */
function evaluateWhenClause (when, context, taskName) {
  if (!when) return true

  // ── Phase 1: Cheap gates (AND, short-circuit OK) ──

  if (when.fileExists) {
    const target = path.join(context.rootDir, when.fileExists)
    if (!fs.existsSync(target)) return `Skipped because ${when.fileExists} was not found`
  }

  if (when.envSet) {
    if (!process.env[when.envSet]) return `Skipped because $${when.envSet} was not set`
  }

  if (when.envNotSet) {
    if (process.env[when.envNotSet]) return `Skipped because $${when.envNotSet} was set`
  }

  if (when.variablesPresent) {
    const { makeResolvers } = require('./template')
    const resolvers = makeResolvers(context)
    for (const varName of when.variablesPresent) {
      const resolver = resolvers[varName]
      if (!resolver) return `Skipped because {{${varName}}} is not a known variable`
      const value = resolver()
      if (!value || !value.trim()) return `Skipped because {{${varName}}} was not present`
    }
  }

  if (when.signal) {
    const activeSignal = getSignal(context.sessionId)
    if (!activeSignal || activeSignal.type !== when.signal) {
      return `Skipped because signal "${when.signal}" is not active`
    }
  }

  if (when.phase) {
    const currentPhase = getPhase(context.sessionId)
    if (currentPhase !== when.phase) {
      return `Skipped because phase is "${currentPhase}", not "${when.phase}"`
    }
  }

  // ── Phase 2: Activity conditions (AND, no short-circuit for bootstrap) ──

  const hasActivity = ACTIVITY_KEYS.some(k => when[k] !== undefined)
  if (!hasActivity) return true

  let allPassed = true
  let failReason = null
  const triggerProgress = []

  if (when.linesChanged) {
    const churn = churnSinceRef(context.rootDir, sanitizeRefName(taskName), context.sources)
    triggerProgress.push(`linesChanged: ${churn}/${when.linesChanged}`)
    if (churn >= when.linesChanged) {
      // passed
    } else {
      allPassed = false
      failReason = `Skipped because only ${churn} of ${when.linesChanged} lines changed since last run`
    }
  }

  if (when.linesWritten) {
    const gross = grossChurnSince(context.rootDir, sanitizeRefName(taskName))
    triggerProgress.push(`linesWritten: ${gross}/${when.linesWritten}`)
    if (gross >= when.linesWritten) {
      // passed
    } else {
      allPassed = false
      failReason = `Skipped because only ${gross} of ${when.linesWritten} gross lines changed since last run`
    }
  }

  if (when.sourcesModifiedSinceLastRun) {
    const latestMtime = context.latestSourceMtime
    if (latestMtime === 0) {
      allPassed = false
      failReason = 'Skipped because no source files were found'
    } else {
      const runKey = (taskName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
      const runs = loadRunData(context.localCfgPath)
      const lastRun = runs[runKey]
      if (lastRun && lastRun.at && latestMtime <= lastRun.at && runResult(lastRun) === 'pass') {
        allPassed = false
        failReason = 'Skipped because no sources were modified since the last run'
      }
    }
  }

  if (when.toolsUsed) {
    const toolsList = when.toolsUsed
    if (context.hookEvent === 'SessionStart') {
      allPassed = false
      failReason = 'Skipped because toolsUsed is not applicable to SessionStart'
    } else if (context.hookEvent === 'PreToolUse') {
      if (toolsList.includes(context.toolName)) {
        // passed
      } else {
        allPassed = false
        failReason = `Skipped because none of [${toolsList.join(', ')}] were used this turn`
      }
    } else if (context.hookEvent === 'Stop') {
      const edits = getFileEdits(context.sessionId)
      const usedTools = edits ? edits.tools : []
      if (toolsList.some(t => usedTools.includes(t))) {
        // passed
      } else {
        allPassed = false
        failReason = `Skipped because none of [${toolsList.join(', ')}] were used this turn`
      }
    }
  }

  if (when.sourceFilesEditedThisTurn) {
    const sfeResult = evaluateSourceFilesEditedThisTurn(when, context)
    if (sfeResult === true) {
      // passed
    } else {
      allPassed = false
      failReason = sfeResult
    }
  }

  // Stash trigger progress on context for monitor display
  if (triggerProgress.length > 0) {
    context._triggerProgress = triggerProgress.join(', ')
  }

  if (allPassed) return true
  return failReason || 'Skipped because not all conditions were met'
}

/**
 * Evaluate `when` conditions on a task.
 *
 * Object form: all conditions AND'd (every condition must pass).
 * Array form: OR of AND clauses (any element passing fires the task).
 *
 * Array elements are always fully evaluated (no short-circuit between elements)
 * so churn bootstraps run everywhere and _triggerProgress accumulates.
 *
 * @param {object|object[]} when - condition object or array of condition objects
 * @param {object} context - dispatch context
 * @param {string} [taskName] - task name, needed for churn-based conditions
 */
function evaluateWhen (when, context, taskName) {
  if (!when) return true

  if (Array.isArray(when)) {
    let anyPassed = false
    let lastReason = null
    const allProgress = []

    for (const clause of when) {
      delete context._triggerProgress
      const result = evaluateWhenClause(clause, context, taskName)
      if (context._triggerProgress) allProgress.push(context._triggerProgress)
      if (result === true) {
        anyPassed = true
      } else {
        lastReason = result
      }
    }

    if (allProgress.length > 0) {
      context._triggerProgress = allProgress.join(', ')
    }

    if (anyPassed) return true
    return lastReason || 'Skipped because no conditions were met'
  }

  return evaluateWhenClause(when, context, taskName)
}

module.exports = {
  BUILTIN_EDIT_TOOLS,
  ACTIVITY_KEYS,
  evaluateSourceFilesEditedThisTurn,
  evaluateWhenClause,
  evaluateWhen
}
