const { fork } = require('child_process')
const fs = require('fs')
const path = require('path')
const { readStdin, ensureDir, sanitizeTaskName } = require('../io')
const { loadEffectiveConfig, isIgnoredPath, loadGlobalConfig, getProveItDir } = require('../config')
const { resolveTestRoot, getLatestMtime, loadRunData, saveRunData, runResult } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck } = require('../checks/agent')
const { runEnvTask } = require('../checks/env')
const { logReview, getAsyncDir, pruneOldSessions, recordFileEdit, getFileEdits, resetTurnTracking, saveSessionState, VALID_SIGNALS, setSignal, getSignal, clearSignal } = require('../session')
const { isSourceFile } = require('../globs')
const { gitRoot, gitHead, gitStatusHash, churnSinceRef, sanitizeRefName, advanceTaskRef, grossChurnSince, incrementGross, computeWriteLines, whenHasKey } = require('../git')
const protocol = require('./protocol')

const BUILTIN_EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']

const PLAN_SIGNAL_CONTEXT = `All plans MUST end with a "Verify & Signal" step — a plan without one is
incomplete. Example:

  1. Refactor the parser to handle edge case X
  2. Update tests for new behavior
  3. Run ./script/test_fast to confirm nothing is broken
  4. **Verify & Signal** — run \`prove_it signal done -m "<what changed>"\`

Signaling is how work gets approved to ship — it triggers automated checks
(test suite, linting) and manual review (code analysis). Forgetting to signal
WILL DELAY OR PREVENT your work from shipping.`

/**
 * Check whether any hook in the config has a task gated on `when: { signal: 'done' }`.
 * Handles both object and array `when` forms.
 */
function hasSignalGatedTasks (hooks) {
  for (const entry of hooks) {
    for (const task of (entry.tasks || [])) {
      if (!task.when) continue
      const clauses = Array.isArray(task.when) ? task.when : [task.when]
      if (clauses.some(c => c.signal === 'done')) return true
    }
  }
  return false
}

// Activity conditions are always fully evaluated (no short-circuit) because
// churn functions have bootstrap side effects (churnSinceRef and grossChurnSince
// create git refs on first call).
const ACTIVITY_KEYS = [
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
 * Evaluate a single `when` clause (object form).
 *
 * All conditions are AND'd—every condition must pass.
 *
 * Two-phase implementation for efficiency:
 *   Phase 1—Cheap gates (short-circuit OK): fileExists, envSet, envNotSet,
 *     variablesPresent, signal. These are pure lookups with no side effects.
 *   Phase 2—Activity conditions (no short-circuit): linesChanged, linesWritten,
 *     sourcesModifiedSinceLastRun, toolsUsed, sourceFilesEdited. Always fully
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
    const { makeResolvers } = require('../template')
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

  if (when.sourceFilesEdited) {
    const sfeResult = evaluateSourceFilesEdited(when, context)
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

  // Matcher for PreToolUse (tool name matching, regex like Claude Code)
  if (event === 'PreToolUse' && entry.matcher) {
    const toolName = input.tool_name || ''
    try {
      if (!new RegExp('^(?:' + entry.matcher + ')$').test(toolName)) return false
    } catch {
      // Invalid regex—fall back to exact split matching
      const matchers = entry.matcher.split('|')
      if (!matchers.some(m => m === toolName)) return false
    }
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
 * Runs once per session—skips if session file already exists.
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
 * Settle a task result—post-check bookkeeping shared by sync and async paths.
 *
 * @returns {{ blocked: boolean, message?: string }}
 */
function settleTaskResult (task, result, hookEvent, settlCtx, outputs, contextParts, systemMessages) {
  const { rootDir, sources, localCfgPath, latestSourceMtime } = settlCtx

  if (!result.pass && !result.skipped) {
    if (hookEvent === 'SessionStart') {
      systemMessages.push(result.reason)
      contextParts.push(result.reason)
      return { blocked: false }
    }
    advanceTaskRef(task, false, hookEvent, rootDir, sources)
    return { blocked: true, message: `prove_it: ${task.name} failed.\n\n${result.reason}` }
  }

  if (result.skipped) {
    if (!task.quiet) {
      const text = result.reason || ''
      if (text) {
        outputs.push(text)
        if (hookEvent === 'SessionStart') contextParts.push(text)
      }
    }
    return { blocked: false }
  }

  // PASS
  advanceTaskRef(task, true, hookEvent, rootDir, sources)
  if (whenHasKey(task.when, 'sourcesModifiedSinceLastRun') && task.type !== 'script') {
    const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
    saveRunData(localCfgPath, runKey, { at: latestSourceMtime, result: 'pass' })
  }
  if (!task.quiet) {
    const text = result.reason || result.output
    if (text) {
      outputs.push(text)
      if (hookEvent === 'SessionStart') contextParts.push(text)
    }
  }
  return { blocked: false }
}

/**
 * Spawn an async task as a detached child process.
 */
function spawnAsyncTask (task, context) {
  const asyncDir = getAsyncDir(context.sessionId)
  if (!asyncDir) return
  const taskFile = sanitizeTaskName(task.name)
  const contextFilePath = path.join(asyncDir, `${taskFile}.context.json`)
  const resultPath = path.join(asyncDir, `${taskFile}.json`)

  const snapshot = {
    task,
    context: {
      rootDir: context.rootDir,
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      hookEvent: context.hookEvent,
      localCfgPath: context.localCfgPath,
      sources: context.sources,
      fileEditingTools: context.fileEditingTools,
      configEnv: context.configEnv,
      configModel: context.configModel,
      maxChars: context.maxChars,
      testOutput: context.testOutput
    },
    resultPath
  }

  ensureDir(asyncDir)
  fs.writeFileSync(contextFilePath, JSON.stringify(snapshot, null, 2), 'utf8')

  const workerPath = path.join(__dirname, '..', 'async_worker.js')
  const child = fork(workerPath, [contextFilePath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  })
  child.unref()

  logReview(context.sessionId, context.projectDir, task.name, 'SPAWNED', null, null, context.hookEvent)
}

/**
 * Harvest completed async results from session storage.
 * Reads result files but does NOT delete them—callers delete after processing
 * so that unprocessed results survive a mid-loop exit (e.g., first-failure block).
 *
 * Returns array of { data, filePath } objects.
 */
function harvestAsyncResults (sessionId) {
  const asyncDir = getAsyncDir(sessionId)
  if (!asyncDir) return []

  let files
  try {
    files = fs.readdirSync(asyncDir)
  } catch {
    return []
  }

  const results = []
  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.context.json')) continue
    const filePath = path.join(asyncDir, file)
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      results.push({ data, filePath })
    } catch {
      // Corrupted or partially written—clean up
      try { fs.unlinkSync(filePath) } catch {}
    }
  }
  return results
}

/**
 * Clean the async directory for a session (fresh start).
 */
function cleanAsyncDir (sessionId) {
  const asyncDir = getAsyncDir(sessionId)
  if (!asyncDir) return
  try {
    fs.rmSync(asyncDir, { recursive: true, force: true })
  } catch {}
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

  // Infrastructure-level signal interception on PreToolUse + Bash
  if (hookEvent === 'PreToolUse' && toolName === 'Bash') {
    const cmd = (toolInput?.command || '').trim()
    const signalMatch = cmd.match(/^(?:\S+\/)?prove_it\s+signal\s+(\S+)/)
    if (signalMatch) {
      const signalType = signalMatch[1]
      if (signalType === 'clear') {
        clearSignal(sessionId)
        logReview(sessionId, projectDir, 'signal', 'CLEAR', null, null, hookEvent)
        protocol.emit(hookEvent, protocol.passDecision(hookEvent),
          'prove_it: signal cleared')
        process.exit(0)
      } else if (VALID_SIGNALS.includes(signalType)) {
        const msgMatch = cmd.match(/(?:--message|-m)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/)
        const message = msgMatch ? (msgMatch[1] ?? msgMatch[2] ?? msgMatch[3]) : null
        setSignal(sessionId, signalType, message)
        logReview(sessionId, projectDir, 'signal', 'SET', signalType, null, hookEvent)
        protocol.emit(hookEvent, protocol.passDecision(hookEvent),
          `prove_it: signal "${signalType}" recorded`)
        process.exit(0)
      }
      // Unknown type: fall through, CLI will error with exit 1
    }
  }

  // Infrastructure-level plan mode enforcement
  if (hookEvent === 'PreToolUse' && toolName === 'EnterPlanMode') {
    if (hasSignalGatedTasks(hooks)) {
      protocol.emitPreToolUse('allow', '', { additionalContext: PLAN_SIGNAL_CONTEXT })
    }
    process.exit(0)
  }

  if (hookEvent === 'PreToolUse' && toolName === 'ExitPlanMode') {
    if (hasSignalGatedTasks(hooks)) {
      const planText = (input.tool_input && input.tool_input.plan) || ''
      if (!planText.includes('prove_it signal done')) {
        const reason = 'Your plan must include a "Verify & Signal" step that runs `prove_it signal done -m "<what changed>"`. Add it as the final step and exit plan mode again.'
        protocol.emitPreToolUse('deny', reason)
        process.exit(0)
      }
    }
    protocol.emitPreToolUse('allow', '')
    process.exit(0)
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

  // Clean async dir on fresh session start
  if (hookEvent === 'SessionStart' && input.source === 'startup') {
    cleanAsyncDir(sessionId)
    pruneOldSessions()
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

  // Harvest async results on Stop—before sync tasks so failures block immediately
  if (hookEvent === 'Stop') {
    const asyncResults = harvestAsyncResults(sessionId)
    const settlCtx = { rootDir, sources: cfg.sources, localCfgPath, latestSourceMtime: context.latestSourceMtime }
    for (const ar of asyncResults) {
      const settlement = settleTaskResult(ar.data.task, ar.data.result, hookEvent, settlCtx, outputs, contextParts, systemMessages)
      // Delete result file AFTER settlement—unprocessed files survive for next harvest
      try { fs.unlinkSync(ar.filePath) } catch {}
      if (settlement.blocked) {
        const failMsg = settlement.message.replace(' failed.', ' failed (async).')
        protocol.emit(hookEvent, protocol.failDecision(hookEvent), failMsg, failMsg)
        process.exit(0)
      }
      const enforceStatus = ar.data.result.skipped ? 'ENFORCED:SKIP' : 'ENFORCED:PASS'
      logReview(sessionId, projectDir, ar.data.taskName, enforceStatus, ar.data.result.reason, null, hookEvent)
    }
  }

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

      // Async tasks: spawn in background instead of running synchronously
      if (task.async === true && hookEvent !== 'SessionStart') {
        spawnAsyncTask(task, context)
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

      const settlCtx = { rootDir, sources: context.sources, localCfgPath, latestSourceMtime: context.latestSourceMtime }
      const settlement = settleTaskResult(task, result, hookEvent, settlCtx, outputs, contextParts, systemMessages)
      if (settlement.blocked) {
        protocol.emit(hookEvent, protocol.failDecision(hookEvent), settlement.message, settlement.message)
        process.exit(0)
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

  // After successful Stop: checkpoint git HEAD, clear signal, reset turn tracking
  if (hookEvent === 'Stop') {
    const head = gitHead(rootDir)
    if (head) saveSessionState(sessionId, 'last_stop_head', head)
    if (getSignal(sessionId)) clearSignal(sessionId)
    resetTurnTracking(sessionId)
  }

  process.exit(0)
}

module.exports = { dispatch, matchesHookEntry, evaluateWhen, defaultConfig, recordSessionBaseline, writeEnvFile, settleTaskResult, spawnAsyncTask, harvestAsyncResults, cleanAsyncDir, hasSignalGatedTasks, BUILTIN_EDIT_TOOLS, PLAN_SIGNAL_CONTEXT }
