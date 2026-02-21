const fs = require('fs')
const path = require('path')
const { readStdin, ensureDir } = require('../io')
const { loadEffectiveConfig, isIgnoredPath, loadGlobalConfig, getProveItDir } = require('../config')
const { resolveTestRoot, getLatestMtime, loadRunData, saveRunData, runResult } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck } = require('../checks/agent')
const { runEnvTask } = require('../checks/env')
const { logReview, recordFileEdit, getFileEdits, resetTurnTracking, saveSessionState } = require('../session')
const { isSourceFile } = require('../globs')
const { gitRoot, gitHead, gitStatusHash, churnSinceRef, sanitizeRefName, advanceChurnRef, grossChurnSince, incrementGross, computeWriteLines } = require('../git')
const protocol = require('./protocol')

const BUILTIN_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']

// Prerequisites are AND-ed environmental gates — all must pass before triggers are checked
const PREREQUISITE_KEYS = ['fileExists', 'envSet', 'envNotSet', 'variablesPresent']

// Triggers are OR-ed activity signals — any one firing is enough to run the task.
// All triggers are always evaluated (no short-circuit) because churn functions
// have bootstrap side effects (churnSinceRef and grossChurnSince create git refs).
const TRIGGER_KEYS = [
  'linesChanged', 'linesWritten',
  'sourcesModifiedSinceLastRun', 'toolsUsed', 'sourceFilesEdited'
]

/**
 * Evaluate the sourceFilesEdited trigger.
 * @returns {true} if the trigger passes, or a skip-reason string
 */
function evaluateSourceFilesEdited (when, context) {
  if (context.hookEvent === 'SessionStart') {
    return 'Skipped because sourceFilesEdited is not applicable to SessionStart'
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
 * Evaluate `when` conditions on a check.
 *
 * Two-phase evaluation:
 *   Phase 1 — Prerequisites (AND): fileExists, envSet, envNotSet, variablesPresent.
 *     All must pass. These are environmental gates — if any fails, the task is skipped.
 *   Phase 2 — Triggers (OR): linesChanged, linesWritten,
 *     sourcesModifiedSinceLastRun, toolsUsed, sourceFilesEdited.
 *     Any one passing is enough to fire. If no trigger keys are present, prerequisites
 *     alone decide. All triggers are always evaluated (no short-circuit) because churn
 *     functions have bootstrap side effects.
 *
 * @param {object} when - the when condition object
 * @param {object} context - dispatch context
 * @param {string} [taskName] - task name, needed for churn-based triggers
 */
function evaluateWhen (when, context, taskName) {
  if (!when) return true

  // ── Phase 1: Prerequisites (AND — all must pass) ──

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
    const { makeResolvers } = require('../template')
    const resolvers = makeResolvers(context)
    for (const varName of when.variablesPresent) {
      const resolver = resolvers[varName]
      if (!resolver) return `Skipped because {{${varName}}} is not a known variable`
      const value = resolver()
      if (!value || !value.trim()) return `Skipped because {{${varName}}} was not present`
    }
  }

  // ── Phase 2: Triggers (OR — any one passing fires the task) ──

  const hasTriggers = TRIGGER_KEYS.some(k => when[k] !== undefined)
  if (!hasTriggers) return true

  let anyTriggerPassed = false
  let lastTriggerReason = null
  const triggerProgress = []

  if (when.linesChanged) {
    const churn = churnSinceRef(context.rootDir, sanitizeRefName(taskName), context.sources)
    triggerProgress.push(`linesChanged: ${churn}/${when.linesChanged}`)
    if (churn >= when.linesChanged) {
      anyTriggerPassed = true
    } else {
      lastTriggerReason = `Skipped because only ${churn} of ${when.linesChanged} lines changed since last run`
    }
  }

  if (when.linesWritten) {
    const gross = grossChurnSince(context.rootDir, sanitizeRefName(taskName))
    triggerProgress.push(`linesWritten: ${gross}/${when.linesWritten}`)
    if (gross >= when.linesWritten) {
      anyTriggerPassed = true
    } else {
      lastTriggerReason = `Skipped because only ${gross} of ${when.linesWritten} gross lines changed since last run`
    }
  }

  if (when.sourcesModifiedSinceLastRun) {
    const latestMtime = context.latestSourceMtime
    if (latestMtime === 0) {
      lastTriggerReason = 'Skipped because no source files were found'
    } else {
      const runKey = (taskName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
      const runs = loadRunData(context.localCfgPath)
      const lastRun = runs[runKey]
      if (lastRun && lastRun.at && latestMtime <= lastRun.at && runResult(lastRun) === 'pass') {
        lastTriggerReason = 'Skipped because no sources were modified since the last run'
      } else {
        anyTriggerPassed = true
      }
    }
  }

  if (when.toolsUsed) {
    const toolsList = when.toolsUsed
    if (context.hookEvent === 'SessionStart') {
      lastTriggerReason = 'Skipped because toolsUsed is not applicable to SessionStart'
    } else if (context.hookEvent === 'PreToolUse') {
      if (toolsList.includes(context.toolName)) {
        anyTriggerPassed = true
      } else {
        lastTriggerReason = `Skipped because none of [${toolsList.join(', ')}] were used this turn`
      }
    } else if (context.hookEvent === 'Stop') {
      const edits = getFileEdits(context.sessionId)
      const usedTools = edits ? edits.tools : []
      if (toolsList.some(t => usedTools.includes(t))) {
        anyTriggerPassed = true
      } else {
        lastTriggerReason = `Skipped because none of [${toolsList.join(', ')}] were used this turn`
      }
    }
  }

  if (when.sourceFilesEdited) {
    const sfeResult = evaluateSourceFilesEdited(when, context)
    if (sfeResult === true) {
      anyTriggerPassed = true
    } else {
      lastTriggerReason = sfeResult
    }
  }

  // Stash trigger progress on context for monitor display
  if (triggerProgress.length > 0) {
    context._triggerProgress = triggerProgress.join(', ')
  }

  if (anyTriggerPassed) return true
  return lastTriggerReason || 'Skipped because no trigger conditions were met'
}

/**
 * Check if a hook entry matches the current event context.
 */
function matchesHookEntry (entry, event, input) {
  if (entry.type !== 'claude') return false
  if (entry.event !== event) return false

  // Source matching for SessionStart
  if (event === 'SessionStart' && entry.source) {
    const sources = entry.source.split('|')
    const inputSource = input.source || ''
    if (!sources.some(s => s === inputSource)) return false
  }

  // Matcher for PreToolUse (tool name matching)
  if (event === 'PreToolUse' && entry.matcher) {
    const matchers = entry.matcher.split('|')
    const toolName = input.tool_name || ''
    if (!matchers.some(m => m === toolName)) return false
  }

  // Trigger matching for PreToolUse + Bash
  if (event === 'PreToolUse' && entry.triggers && entry.triggers.length > 0) {
    const toolCmd = input.tool_input?.command || ''
    const matches = entry.triggers.some(re => {
      try { return new RegExp(re, 'i').test(toolCmd) } catch { return false }
    })
    if (!matches) return false
  }

  return true
}

/**
 * Default config function for loadEffectiveConfig.
 * Returns minimal defaults for v2 schema.
 */
function defaultConfig () {
  return {
    enabled: false,
    sources: null,
    hooks: []
  }
}

/**
 * Lazily record session baseline (git HEAD + status hash).
 * Runs once per session — skips if session file already exists.
 */
function recordSessionBaseline (sessionId, projectDir) {
  if (!sessionId) return
  const sessionsDir = path.join(getProveItDir(), 'sessions')
  const sessionFile = path.join(sessionsDir, `${sessionId}.json`)
  if (fs.existsSync(sessionFile)) return

  try {
    ensureDir(sessionsDir)
    const root = gitRoot(projectDir) || projectDir
    const head = gitHead(root)
    const statusHash = gitStatusHash(root)
    const payload = {
      session_id: sessionId,
      project_dir: projectDir,
      root_dir: root,
      started_at: new Date().toISOString(),
      git: { is_repo: true, root, head, status_hash: statusHash }
    }
    fs.writeFileSync(sessionFile, JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) {
    console.error(`prove_it: failed to write session baseline: ${e.message}`)
  }
}

/**
 * Write env vars to CLAUDE_ENV_FILE.
 * Creates or appends to the file specified by the CLAUDE_ENV_FILE env var.
 */
function writeEnvFile (vars) {
  const envFile = process.env.CLAUDE_ENV_FILE
  if (!envFile) {
    console.error('prove_it: CLAUDE_ENV_FILE not set, cannot write env vars')
    return
  }
  const lines = Object.entries(vars).map(([k, v]) => {
    // Quote values that contain newlines, quotes, or backslashes
    if (/[\n\r"\\]/.test(v)) {
      const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
      return `${k}="${escaped}"`
    }
    return `${k}=${v}`
  })
  fs.appendFileSync(envFile, lines.join('\n') + '\n', 'utf8')
}

/**
 * Main dispatcher for Claude Code hook events.
 * Reads stdin, finds matching hook entries, runs checks.
 */
function dispatch (event) {
  let input
  try {
    input = JSON.parse(readStdin())
  } catch (e) {
    const failMsg = `prove_it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`
    protocol.emit(event, protocol.failDecision(event), failMsg, failMsg)
    process.exit(0)
  }

  const sessionId = input.session_id || null
  const hookEvent = input.hook_event_name || event
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0)
  }

  // Check for ignored paths in global config
  const globalCfg = loadGlobalConfig()
  if (isIgnoredPath(projectDir, globalCfg.ignoredPaths)) {
    process.exit(0)
  }

  // Lazy session baseline recording (once per session)
  recordSessionBaseline(sessionId, projectDir)

  let cfg, localCfgPath
  try {
    ({ cfg, localCfgPath } = loadEffectiveConfig(projectDir, defaultConfig))
  } catch (e) {
    protocol.emit(hookEvent, protocol.failDecision(hookEvent),
      e.message, e.message)
    process.exit(0)
  }

  // Check for top-level enabled: false
  if (cfg.enabled === false) {
    process.exit(0)
  }

  const hooks = cfg.hooks || []
  if (!Array.isArray(hooks)) {
    process.exit(0)
  }

  const rootDir = resolveTestRoot(projectDir)
  const maxChars = cfg.format?.maxOutputChars || 12000
  const toolName = input.tool_name || null
  const toolInput = input.tool_input || null
  const fileEditingTools = [...BUILTIN_EDIT_TOOLS, ...(cfg.fileEditingTools || [])]

  // Infrastructure-level file edit tracking + gross churn accumulation on every PreToolUse
  if (hookEvent === 'PreToolUse' && toolName && fileEditingTools.includes(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.notebook_path || ''
    if (filePath) {
      let resolvedRoot = rootDir
      try { resolvedRoot = fs.realpathSync(rootDir) } catch {}
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
      if (!relativePath.startsWith('..') && isSourceFile(relativePath, rootDir, cfg.sources)) {
        recordFileEdit(sessionId, toolName, relativePath)
        // Accumulate gross churn for linesWritten tracking
        const lines = computeWriteLines(toolName, toolInput)
        if (lines > 0) incrementGross(rootDir, lines)
      }
    }
  }

  // Build context shared across all checks
  let _latestSourceMtime = null
  const context = {
    rootDir,
    projectDir,
    sessionId,
    hookEvent,
    toolName,
    toolInput,
    localCfgPath,
    sources: cfg.sources,
    fileEditingTools,
    configEnv: cfg.taskEnv || null,
    configModel: cfg.model || null,
    maxChars,
    testOutput: '',
    get latestSourceMtime () {
      if (_latestSourceMtime === null) _latestSourceMtime = getLatestMtime(rootDir, cfg.sources)
      return _latestSourceMtime
    }
  }

  // Find matching hook entries
  const matchingEntries = hooks.filter(entry => matchesHookEntry(entry, hookEvent, input))

  if (matchingEntries.length === 0) {
    process.exit(0)
  }

  // Collect results
  const outputs = []
  const contextParts = []
  const systemMessages = []
  const envVars = {}

  for (const entry of matchingEntries) {
    const tasks = entry.tasks || []

    for (const task of tasks) {
      if (task.enabled === false) {
        if (!task.quiet) logReview(sessionId, projectDir, task.name, 'SKIP', 'Disabled', null, hookEvent)
        continue
      }

      delete context._triggerProgress
      const whenResult = evaluateWhen(task.when, context, task.name)
      if (whenResult !== true) {
        if (!task.quiet) {
          const extra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
          logReview(sessionId, projectDir, task.name, 'SKIP', whenResult, null, hookEvent, extra)
        }
        continue
      }

      // Handle env tasks (SessionStart only, startup/resume only)
      if (task.type === 'env') {
        const source = input.source || ''
        if (source !== 'startup' && source !== 'resume') continue
        const envResult = runEnvTask(task, context)
        if (envResult.error) {
          systemMessages.push(envResult.error)
          contextParts.push(envResult.error)
        } else {
          Object.assign(envVars, envResult.vars)
        }
        continue
      }

      let result
      if (task.type === 'script') {
        result = runScriptCheck(task, context)
      } else if (task.type === 'agent') {
        result = runAgentCheck(task, context)
      } else {
        continue
      }

      if (result.output) {
        context.testOutput = result.output
      }

      if (!result.pass) {
        if (hookEvent === 'SessionStart') {
          systemMessages.push(result.reason)
          contextParts.push(result.reason)
        } else {
          advanceChurnRef(task, false, hookEvent, rootDir, context.sources)
          // Do NOT record mtime-based run on failure — failures should be
          // sticky so the task re-fires until sources change.
          // PreToolUse/Stop: fail fast — block and exit immediately
          const failMsg = `prove_it: ${task.name} failed.\n\n${result.reason}`
          protocol.emit(hookEvent, protocol.failDecision(hookEvent), failMsg, failMsg)
          process.exit(0)
        }
      } else if (result.skipped) {
        // SKIP — allow but don't advance metrics or save mtime
        const text = result.reason || ''
        if (text) {
          outputs.push(text)
          if (hookEvent === 'SessionStart') contextParts.push(text)
        }
      } else {
        advanceChurnRef(task, true, hookEvent, rootDir, context.sources)
        if (task.when && task.when.sourcesModifiedSinceLastRun && task.type !== 'script') {
          const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
          saveRunData(localCfgPath, runKey, { at: context.latestSourceMtime, result: 'pass' })
        }
        if (!task.quiet) {
          const text = result.reason || result.output
          if (text) {
            outputs.push(text)
            if (hookEvent === 'SessionStart') {
              contextParts.push(text)
            }
          }
        }
      }
    }
  }

  // All checks passed (or SessionStart always continues)
  if (hookEvent === 'SessionStart') {
    // Write env vars to CLAUDE_ENV_FILE if any were collected
    if (Object.keys(envVars).length > 0) {
      writeEnvFile(envVars)
      const varNames = Object.keys(envVars).join(', ')
      contextParts.push(`prove_it: set env vars: ${varNames}`)
    }

    const additionalContext = contextParts.join('\n') || null
    const systemMessage = systemMessages.join('\n') || null
    protocol.emitSessionStart({ additionalContext, systemMessage })
    process.exit(0)
  }

  // For PreToolUse/Stop: emit pass
  const summaryParts = outputs.filter(o => o && !o.startsWith('cached'))
  const summary = summaryParts.length > 0 ? summaryParts.join('\n') : 'all checks passed'
  protocol.emit(hookEvent, protocol.passDecision(hookEvent),
    `prove_it: ${summary}`)

  // After successful Stop: checkpoint git HEAD and reset turn tracking
  if (hookEvent === 'Stop') {
    const head = gitHead(rootDir)
    if (head) saveSessionState(sessionId, 'last_stop_head', head)
    resetTurnTracking(sessionId)
  }

  process.exit(0)
}

module.exports = { dispatch, matchesHookEntry, evaluateWhen, defaultConfig, recordSessionBaseline, writeEnvFile, BUILTIN_EDIT_TOOLS, PREREQUISITE_KEYS, TRIGGER_KEYS }
