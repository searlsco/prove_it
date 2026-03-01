const { fork } = require('child_process')
const fs = require('fs')
const path = require('path')
const { readStdin, ensureDir, sanitizeTaskName } = require('../io')
const { loadEffectiveConfig, isIgnoredPath, loadGlobalConfig, getProveItDir } = require('../config')
const { resolveTestRoot, getLatestMtime, loadRunData, saveRunData, runResult } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck, cleanBackchannel } = require('../checks/agent')
const { handleScriptAppeal, isTaskSuspended, resetFailures } = require('../checks/arbiter')
const { runEnvTask } = require('../checks/env')
const { logReview, getAsyncDir, pruneOldSessions, recordFileEdit, getFileEdits, resetTurnTracking, saveSessionState, loadSessionState, VALID_SIGNALS, setSignal, getSignal, clearSignal } = require('../session')
const { isSourceFile } = require('../globs')
const { gitRoot, gitHead, gitStatusHash, churnSinceRef, sanitizeRefName, advanceTaskRef, grossChurnSince, incrementGross, computeWriteLines, whenHasKey } = require('../git')
const protocol = require('./protocol')

const BUILTIN_EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']

// Strict: plan file idempotency guard — must contain the exact command
const SIGNAL_PLAN_MARKER = 'prove_it signal done'
// Liberal: TaskCompleted auto-signaling — any task with "signal" and "done" tokens
const SIGNAL_TASK_PATTERN = /\bsignal\b.*\bdone\b/i

/**
 * Build the signal step block at the given heading level and step number.
 */
function buildSignalBlock (level, stepNum) {
  const stepString = stepNum < 2 ? '' : ` ${stepNum}.`
  const hashes = '#'.repeat(level)
  return `${hashes}${stepString} Run \`prove_it signal done\`

**IMPORTANT — you MUST complete this step.** When all implementation and
testing above is finished, invoke the signal command so that prove_it
can run its quality gates (test suites, code review agents).
Without this signal, your work will not be shipped!

Run this command in your terminal:

\`\`\`bash
prove_it signal done
\`\`\`
`
}

/**
 * Detect the last numbered heading in plan content.
 * Supports: ### N. / ### N: / ## Step N: / ## Step N. / ## N. / ## N:
 * Returns { level, number } or null.
 */
function detectLastNumberedHeading (content) {
  // Match headings like: ## 1. / ### 3: / ## Step 2: / ## Step 1.
  const pattern = /^(#{2,3})\s+(?:Step\s+)?(\d+)[.:]/gm
  let last = null
  let m
  while ((m = pattern.exec(content)) !== null) {
    last = { level: m[1].length, number: parseInt(m[2], 10) }
  }
  return last
}

/**
 * Find the most recent plan file matching the given plan text and insert
 * a signal task as a numbered step. Graceful degradation—if plans dir is
 * missing or the file can't be found, we silently skip.
 */
function appendSignalTask (toolInput) {
  try {
    const planText = (toolInput && toolInput.plan) || ''
    if (!planText.trim()) return

    const plansDir = path.join(process.env.HOME, '.claude', 'plans')
    let files
    try {
      files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'))
    } catch { return }

    if (files.length === 0) return

    // Sort by mtime descending (newest first)
    files.sort((a, b) => {
      try {
        return fs.statSync(path.join(plansDir, b)).mtimeMs - fs.statSync(path.join(plansDir, a)).mtimeMs
      } catch { return 0 }
    })

    const needle = planText.trim()
    for (const file of files) {
      const filePath = path.join(plansDir, file)
      let content
      try { content = fs.readFileSync(filePath, 'utf8') } catch { continue }

      if (content.includes(needle)) {
        if (content.includes(SIGNAL_PLAN_MARKER)) return // already appended
        const lastHeading = detectLastNumberedHeading(content)
        const level = lastHeading ? lastHeading.level : 2
        const stepNum = lastHeading ? lastHeading.number + 1 : 1
        const signalBlock = buildSignalBlock(level, stepNum)

        // Insert before ## Verification if it exists, otherwise append
        const verificationPattern = /\n## Verification\b[^\n]*/
        const verificationMatch = content.match(verificationPattern)
        let result
        if (verificationMatch) {
          const idx = content.indexOf(verificationMatch[0])
          result = content.slice(0, idx) + '\n' + signalBlock + '\n' + content.slice(idx)
        } else {
          result = content + '\n' + signalBlock
        }

        fs.writeFileSync(filePath, result, 'utf8')
        return
      }
    }
  } catch {
    // Graceful degradation—plan editing is best-effort
  }
}

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
  const { rootDir, sources, localCfgPath } = settlCtx

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
  if (whenHasKey(task.when, 'sourcesModifiedSinceLastRun')) {
    const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
    saveRunData(localCfgPath, runKey, { at: Date.now(), result: 'pass' })
  }
  {
    const text = result.output || result.reason
    if (text) {
      if (!task.quiet) outputs.push(text)
      if (hookEvent === 'SessionStart') contextParts.push(text)
    }
  }
  return { blocked: false }
}

/**
 * Build the context snapshot shared by async and parallel task forks.
 */
function buildTaskSnapshot (task, context) {
  const asyncDir = getAsyncDir(context.sessionId)
  if (!asyncDir) return null
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
      taskAllowedTools: context.taskAllowedTools,
      taskBypassPermissions: context.taskBypassPermissions,
      maxChars: context.maxChars,
      testOutput: context.testOutput
    },
    resultPath
  }

  ensureDir(asyncDir)
  fs.writeFileSync(contextFilePath, JSON.stringify(snapshot, null, 2), 'utf8')

  return { contextFilePath, resultPath, taskFile }
}

/**
 * Fork a parallel task as a non-detached child process.
 * Unlike spawnAsyncTask, the child is NOT detached/unref'd—we await it
 * in the same invocation.
 *
 * @returns {{ child, resultPath, task }} or null if sessionId is missing
 */
function forkParallelTask (task, context) {
  const snap = buildTaskSnapshot(task, context)
  if (!snap) return null

  const workerPath = path.join(__dirname, '..', 'async_worker.js')
  const child = fork(workerPath, [snap.contextFilePath], {
    stdio: 'ignore',
    env: { ...process.env, PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  })

  return { child, resultPath: snap.resultPath, task }
}

/**
 * Await all parallel children and read their result JSON.
 *
 * @param {{ child, resultPath, task }[]} batch
 * @returns {Promise<{ task, result }[]>}
 */
function awaitParallelBatch (batch) {
  const promises = batch.map(({ child, resultPath, task }) => {
    return new Promise((resolve) => {
      child.on('exit', () => {
        try {
          const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
          resolve({ task: data.task, result: data.result, resultPath })
        } catch {
          resolve({
            task,
            result: { pass: true, reason: 'parallel worker exited without result', output: '', skipped: true },
            resultPath
          })
        }
      })
      child.on('error', () => {
        resolve({
          task,
          result: { pass: true, reason: 'parallel worker failed to start', output: '', skipped: true },
          resultPath
        })
      })
    })
  })
  return Promise.all(promises)
}

/**
 * Kill all children in a parallel batch.
 */
function killParallelBatch (batch) {
  for (const { child } of batch) {
    try { child.kill() } catch {}
  }
}

/**
 * Spawn an async task as a detached child process.
 */
function spawnAsyncTask (task, context) {
  const snap = buildTaskSnapshot(task, context)
  if (!snap) return

  const workerPath = path.join(__dirname, '..', 'async_worker.js')
  const child = fork(workerPath, [snap.contextFilePath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  })
  child.unref()
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
async function dispatch (event) {
  let input
  try {
    input = JSON.parse(readStdin())
  } catch (e) {
    // Circuit breaker: non-blocking pass so malformed stdin doesn't create a death spiral
    protocol.emit(event, protocol.passDecision(event),
      `prove_it: Failed to parse hook input: ${e.message}`)
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
    const alreadyReported = sessionId && loadSessionState(sessionId, 'configError')
    if (!alreadyReported) {
      if (sessionId) saveSessionState(sessionId, 'configError', e.message)
      logReview(sessionId, projectDir, 'config', 'BOOM', e.message, null, hookEvent)
    }

    // SessionStart: always emit the error prominently
    if (hookEvent === 'SessionStart') {
      const bold = `\u26a0\ufe0f prove_it config is invalid \u2014 hooks are disabled until this is fixed.\n\n${e.message}`
      protocol.emitSessionStart({ additionalContext: bold, systemMessage: bold })
    } else if (!alreadyReported) {
      // PreToolUse/Stop: non-blocking pass with warning (first time only)
      protocol.emit(hookEvent, protocol.passDecision(hookEvent),
        e.message, e.message)
    }
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
      if (VALID_SIGNALS.includes(signalType)) {
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
    process.exit(0)
  }

  if (hookEvent === 'PreToolUse' && toolName === 'ExitPlanMode') {
    if (hasSignalGatedTasks(hooks)) {
      appendSignalTask(input.tool_input)
    }
    protocol.emitPreToolUse('allow', '')
    process.exit(0)
  }

  // Infrastructure-level backchannel bypass: allow writes to appeal backchannels.
  // Uses rootDir (realpath-resolved) because arbiter.js constructs backchannel paths
  // from context.rootDir, so Claude's tool_input.file_path will use the resolved form.
  if (hookEvent === 'PreToolUse' && sessionId && fileEditingTools.includes(toolName)) {
    const bcFilePath = toolInput?.file_path || toolInput?.notebook_path || ''
    if (bcFilePath && path.isAbsolute(bcFilePath)) {
      const bcPrefix = path.join(rootDir, '.claude', 'prove_it', 'sessions', sessionId, 'backchannel')
      if (path.resolve(bcFilePath).startsWith(bcPrefix + path.sep)) {
        protocol.emitPreToolUse('allow', '')
        process.exit(0)
      }
    }
  }

  // Infrastructure-level TaskCompleted auto-signaling
  if (hookEvent === 'TaskCompleted') {
    if (hasSignalGatedTasks(hooks)) {
      const subject = input.task_subject || ''
      if (SIGNAL_TASK_PATTERN.test(subject)) {
        const existing = getSignal(sessionId)
        if (!existing || existing.type !== 'done') {
          setSignal(sessionId, 'done', null)
          logReview(sessionId, projectDir, 'signal', 'SET', 'done (auto)', null, hookEvent)
        }
      }
    }
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
    taskAllowedTools: cfg.taskAllowedTools || null,
    taskBypassPermissions: cfg.taskBypassPermissions ?? null,
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
    const settlCtx = { rootDir, sources: cfg.sources, localCfgPath }
    for (const ar of asyncResults) {
      // Script appeal flow for async tasks
      if (ar.data.task.type === 'script' && !ar.data.result.pass && !ar.data.result.skipped) {
        ar.data.result = handleScriptAppeal(ar.data.task, ar.data.result, context)
      }
      if (ar.data.task.type === 'script' && ar.data.result.pass && !ar.data.result.skipped) {
        resetFailures(sessionId, ar.data.task.name)
        cleanBackchannel(rootDir, sessionId, ar.data.task.name)
      }

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

  const parallelBatch = []

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
        // Signal-gated tasks are quiet when the signal simply isn't active—
        // that's the normal quiescent state, not worth logging every turn.
        const signalQuiet = whenHasKey(task.when, 'signal') && !getSignal(context.sessionId)
        if (!task.quiet && !signalQuiet) {
          const extra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
          logReview(sessionId, projectDir, task.name, 'SKIP', whenResult, null, hookEvent, extra)
        }
        continue
      }

      // Suspension check for script tasks (arbiter appeal system)
      if (task.type === 'script' && isTaskSuspended(sessionId, task.name)) {
        logReview(sessionId, projectDir, task.name, 'SKIP', 'suspended by arbiter', null, hookEvent)
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

      // Parallel tasks: fork now, await after loop
      if (task.parallel === true && hookEvent !== 'SessionStart') {
        const handle = forkParallelTask(task, context)
        if (handle) parallelBatch.push(handle)
        continue
      }

      let result
      try {
        if (task.type === 'script') {
          result = runScriptCheck(task, context)
        } else if (task.type === 'agent') {
          result = runAgentCheck(task, context)
        } else {
          continue
        }
      } catch (e) {
        const reason = `${task.name} crashed: ${e.message}`
        logReview(sessionId, projectDir, task.name, 'BOOM', reason, null, hookEvent)
        result = { pass: true, reason: `⚠ ${reason}`, output: '', skipped: true }
      }

      // Script appeal flow: handle consecutive failures
      if (task.type === 'script' && !result.pass && !result.skipped) {
        result = handleScriptAppeal(task, result, context)
      }
      if (task.type === 'script' && result.pass && !result.skipped) {
        resetFailures(sessionId, task.name)
        cleanBackchannel(rootDir, sessionId, task.name)
      }

      if (result.output) {
        context.testOutput = result.output
      }

      const settlCtx = { rootDir, sources: context.sources, localCfgPath }
      const settlement = settleTaskResult(task, result, hookEvent, settlCtx, outputs, contextParts, systemMessages)
      if (settlement.blocked) {
        killParallelBatch(parallelBatch)
        for (const { resultPath } of parallelBatch) {
          try { fs.unlinkSync(resultPath) } catch {}
        }
        protocol.emit(hookEvent, protocol.failDecision(hookEvent), settlement.message, settlement.message)
        process.exit(0)
      }
    }
  }

  // Await parallel batch results
  if (parallelBatch.length > 0) {
    const parallelResults = await awaitParallelBatch(parallelBatch)
    const settlCtx = { rootDir, sources: cfg.sources, localCfgPath }
    // Clean up ALL result files first—prevents orphans from being harvested as async results
    for (const pr of parallelResults) {
      try { fs.unlinkSync(pr.resultPath) } catch {}
    }
    for (const pr of parallelResults) {
      // Script appeal flow for parallel tasks
      if (pr.task.type === 'script' && !pr.result.pass && !pr.result.skipped) {
        pr.result = handleScriptAppeal(pr.task, pr.result, context)
      }
      if (pr.task.type === 'script' && pr.result.pass && !pr.result.skipped) {
        resetFailures(sessionId, pr.task.name)
        cleanBackchannel(rootDir, sessionId, pr.task.name)
      }

      const settlement = settleTaskResult(pr.task, pr.result, hookEvent, settlCtx, outputs, contextParts, systemMessages)
      if (settlement.blocked) {
        const failMsg = settlement.message.replace(' failed.', ' failed (parallel).')
        protocol.emit(hookEvent, protocol.failDecision(hookEvent), failMsg, failMsg)
        process.exit(0)
      }
      const enforceStatus = pr.result.skipped ? 'ENFORCED:SKIP' : 'ENFORCED:PASS'
      logReview(sessionId, projectDir, pr.task.name, enforceStatus, pr.result.reason, null, hookEvent)
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
  const summaryParts = outputs.filter(Boolean)
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

module.exports = { dispatch, matchesHookEntry, evaluateWhen, defaultConfig, recordSessionBaseline, writeEnvFile, settleTaskResult, spawnAsyncTask, harvestAsyncResults, cleanAsyncDir, hasSignalGatedTasks, appendSignalTask, forkParallelTask, awaitParallelBatch, killParallelBatch, BUILTIN_EDIT_TOOLS, SIGNAL_PLAN_MARKER, SIGNAL_TASK_PATTERN }
