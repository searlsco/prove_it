const { fork, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { readStdin, ensureDir, sanitizeTaskName } = require('../io')
const { backchannelPrefix } = require('../paths')
const { loadEffectiveConfig, isIgnoredPath, loadGlobalConfig, getProveItDir } = require('../config')
const { resolveTestRoot, getLatestMtime, saveRunData } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck, cleanBackchannel } = require('../checks/agent')
const { handleScriptAppeal, isTaskSuspended, resetFailures } = require('../checks/arbiter')
const { runEnvTask } = require('../checks/env')
const { logReview, logCommandResult, getAsyncDir, pruneOldSessions, recordFileEdit, resetTurnTracking, saveSessionState, loadSessionState, VALID_SIGNALS, setSignal, getSignal, clearSignal, VALID_PHASES, setPhase } = require('../session')
const { isSourceFile } = require('../globs')
const { gitRoot, gitHead, gitStatusHash, advanceTaskRef, incrementGross, computeWriteLines, whenHasKey } = require('../git')
const protocol = require('./protocol')
const { SIGNAL_PLAN_MARKER, PHASE_PLAN_MARKER, SIGNAL_TASK_PATTERN, detectLastNumberedHeading, detectPlanPhase, buildSignalBlock, buildPhaseBlock, findPlanFile, appendPlanBlock } = require('../plan')
const { configDefaults } = require('../defaults')
const { BUILTIN_EDIT_TOOLS, evaluateWhen } = require('../when')

/**
 * Inject signal step into a plan file. Graceful degradation—if plans dir
 * is missing or the file can't be found, we silently skip.
 */
function injectSignalBlock (toolInput, hasSignalGated) {
  try {
    if (!hasSignalGated) return null
    const planText = (toolInput && toolInput.plan) || ''
    if (!planText.trim()) return null

    const filePath = findPlanFile(planText.trim())
    if (!filePath) return null

    let content
    try { content = fs.readFileSync(filePath, 'utf8') } catch { return null }
    const lastHeading = detectLastNumberedHeading(content)
    const level = lastHeading ? lastHeading.level : 2
    const stepNum = lastHeading ? lastHeading.number + 1 : 1
    const signalBlock = buildSignalBlock(level, stepNum)
    appendPlanBlock(filePath, {
      marker: SIGNAL_PLAN_MARKER,
      block: signalBlock,
      position: 'before-verification'
    })
    const phase = detectPlanPhase(content)
    appendPlanBlock(filePath, {
      marker: PHASE_PLAN_MARKER,
      block: buildPhaseBlock(phase),
      position: 'before-steps'
    })
    return filePath
  } catch {
    // Graceful degradation—plan editing is best-effort
    return null
  }
}

/** Check whether any hook entry has at least one task. */
function hasTasks (hooks) {
  for (const entry of hooks) {
    if (entry.tasks && entry.tasks.length > 0) return true
  }
  return false
}

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

  // Matcher for PreToolUse/PostToolUse/PostToolUseFailure (tool name matching, regex like Claude Code)
  const toolMatchEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']
  if (toolMatchEvents.includes(event) && entry.matcher) {
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
function settleTaskResult (task, result, hookEvent, settlCtx, outputs, contextParts, systemMessages, additionalContextParts) {
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
      if (task.quiet && additionalContextParts) {
        // Quiet tasks with output inject into additionalContext (visible to Claude on allow)
        additionalContextParts.push(text)
      } else if (!task.quiet) {
        outputs.push(text)
      }
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
      configMaxAgentTurns: context.configMaxAgentTurns,
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
 * Read a parallel worker's result from its JSON file.
 */
function readParallelResult (resultPath, task) {
  try {
    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    return { task: data.task, result: data.result, resultPath }
  } catch {
    return {
      task,
      result: { pass: true, reason: 'parallel worker exited without result', output: '', skipped: true },
      resultPath
    }
  }
}

/**
 * Await all parallel children and read their result JSON.
 * Fail-fast: if any child exits with a failing result, kill remaining
 * siblings immediately and return all results collected so far.
 *
 * @param {{ child, resultPath, task }[]} batch
 * @returns {Promise<{ task, result }[]>}
 */
function awaitParallelBatch (batch) {
  return new Promise((resolve) => {
    const results = []
    let settled = false
    let remaining = batch.length

    if (remaining === 0) { resolve(results); return }

    for (const entry of batch) {
      const { child, resultPath, task } = entry

      const onDone = () => {
        if (settled) return
        const r = readParallelResult(resultPath, task)
        results.push(r)
        remaining--

        if (!r.result.pass && !r.result.skipped) {
          // Fail-fast: kill siblings and return immediately
          settled = true
          for (const other of batch) {
            if (other !== entry) {
              killChild(other.child)
              // Collect results for killed siblings (may or may not have written files)
              const otherR = readParallelResult(other.resultPath, other.task)
              if (!results.some(x => x.resultPath === other.resultPath)) {
                results.push(otherR)
              }
            }
          }
          resolve(results)
          return
        }

        if (remaining === 0) {
          settled = true
          resolve(results)
        }
      }

      child.on('exit', onDone)
      child.on('error', () => {
        if (settled) return
        results.push({
          task,
          result: { pass: true, reason: 'parallel worker failed to start', output: '', skipped: true },
          resultPath
        })
        remaining--
        if (remaining === 0) {
          settled = true
          resolve(results)
        }
      })
    }
  })
}

/**
 * Kill a forked child and its subprocess tree.
 * fork()'d workers run spawnSync which blocks signal handling,
 * so we SIGKILL the worker and also kill its children via pkill.
 */
function killChild (child) {
  if (!child || !child.pid) return
  // Kill child's subprocess tree first (e.g. bash running sleep)
  try { spawnSync('pkill', ['-KILL', '-P', String(child.pid)], { timeout: 2000 }) } catch {}
  try { child.kill('SIGKILL') } catch {}
}

/**
 * Kill all children in a parallel batch.
 */
function killParallelBatch (batch) {
  for (const { child } of batch) {
    killChild(child)
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
async function dispatch (event, _input) {
  let input
  try {
    input = _input || JSON.parse(readStdin())
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

  let cfg, localCfgPath, userKeys
  try {
    ({ cfg, localCfgPath, userKeys } = loadEffectiveConfig(projectDir, configDefaults))
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

  const hooks = cfg.hooks
  if (!Array.isArray(hooks) || !hasTasks(hooks)) {
    process.exit(0)
  }

  const rootDir = resolveTestRoot(projectDir)
  const maxChars = cfg.format.maxOutputChars
  const toolName = input.tool_name || null
  const toolInput = input.tool_input || null
  const toolResponse = input.tool_response || null
  const error = input.error || null
  const fileEditingTools = [...BUILTIN_EDIT_TOOLS, ...cfg.fileEditingTools]

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

  // Infrastructure-level signal interception + test-run detection on PreToolUse + Bash
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

    const phaseMatch = cmd.match(/^(?:\S+\/)?prove_it\s+phase\s+(\S+)/)
    if (phaseMatch) {
      const phaseType = phaseMatch[1]
      if (VALID_PHASES.includes(phaseType)) {
        setPhase(sessionId, phaseType)
        logReview(sessionId, projectDir, 'phase', 'SET', phaseType, null, hookEvent)
        protocol.emit(hookEvent, protocol.passDecision(hookEvent),
          `prove_it: phase "${phaseType}" recorded`)
        process.exit(0)
      }
      // Unknown type: fall through, CLI will error with exit 1
    }
  }

  // Infrastructure-level plan mode enforcement
  if (hookEvent === 'PreToolUse' && toolName === 'EnterPlanMode') {
    setPhase(sessionId, 'plan')
    process.exit(0)
  }

  let _resolvedPlanPath = null
  if (hookEvent === 'PreToolUse' && toolName === 'ExitPlanMode') {
    _resolvedPlanPath = injectSignalBlock(input.tool_input, hasSignalGatedTasks(hooks))
    // Fall through to normal task matching so ExitPlanMode-matched tasks
    // (e.g. inject-plan) can run
  }

  // Infrastructure-level backchannel bypass: allow writes to appeal backchannels.
  // Uses rootDir (realpath-resolved) because arbiter.js constructs backchannel paths
  // from context.rootDir, so Claude's tool_input.file_path will use the resolved form.
  if (hookEvent === 'PreToolUse' && sessionId && fileEditingTools.includes(toolName)) {
    const bcFilePath = toolInput?.file_path || toolInput?.notebook_path || ''
    if (bcFilePath && path.isAbsolute(bcFilePath)) {
      const bcPrefix = backchannelPrefix(rootDir, sessionId)
      if (path.resolve(bcFilePath).startsWith(bcPrefix + path.sep)) {
        protocol.emitPreToolUse('allow', '')
        process.exit(0)
      }
    }
  }

  // Infrastructure-level command result logging
  if ((hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') && toolName === 'Bash') {
    const cmd = (toolInput?.command || '').trim()
    if (cmd) {
      logCommandResult(sessionId, projectDir, toolName, cmd,
        hookEvent === 'PostToolUse', hookEvent)
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
    toolResponse,
    error,
    localCfgPath,
    resolvedPlanPath: _resolvedPlanPath,
    sources: cfg.sources,
    tests: cfg.tests,
    testCommands: cfg.testCommands,
    fileEditingTools,
    configEnv: cfg.taskEnv,
    configModel: userKeys.has('model') ? cfg.model : null,
    configMaxAgentTurns: cfg.maxAgentTurns,
    taskAllowedTools: cfg.taskAllowedTools,
    taskBypassPermissions: cfg.taskBypassPermissions,
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
  const additionalContextParts = []
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

      const settlement = settleTaskResult(ar.data.task, ar.data.result, hookEvent, settlCtx, outputs, contextParts, systemMessages, additionalContextParts)
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
        if (!task.quiet) {
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
      const settlement = settleTaskResult(task, result, hookEvent, settlCtx, outputs, contextParts, systemMessages, additionalContextParts)
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

      const settlement = settleTaskResult(pr.task, pr.result, hookEvent, settlCtx, outputs, contextParts, systemMessages, additionalContextParts)
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

    // Collect briefings from ALL tasks across all hooks (not just SessionStart entries)
    for (const entry of hooks) {
      for (const task of (entry.tasks || [])) {
        if (task.enabled === false) continue
        if (task.briefing && typeof task.briefing === 'string') {
          contextParts.push(task.briefing)
        }
      }
    }

    const additionalContext = contextParts.join('\n') || null
    const systemMessage = systemMessages.join('\n') || null
    protocol.emitSessionStart({ additionalContext, systemMessage })
    process.exit(0)
  }

  // For PreToolUse/PostToolUse/PostToolUseFailure/Stop: emit pass
  const summaryParts = outputs.filter(Boolean)
  const summary = summaryParts.length > 0 ? summaryParts.join('\n') : 'all checks passed'
  const additionalContext = additionalContextParts.length > 0
    ? additionalContextParts.join('\n')
    : undefined
  if (hookEvent === 'PreToolUse') {
    protocol.emitPreToolUse(protocol.passDecision(hookEvent),
      `prove_it: ${summary}`, { additionalContext })
  } else if (hookEvent === 'PostToolUse') {
    protocol.emitPostToolUse({ additionalContext: additionalContext || (summaryParts.length > 0 ? summary : undefined) })
  } else if (hookEvent === 'PostToolUseFailure') {
    protocol.emitPostToolUseFailure({ additionalContext: additionalContext || (summaryParts.length > 0 ? summary : undefined) })
  } else {
    protocol.emit(hookEvent, protocol.passDecision(hookEvent),
      `prove_it: ${summary}`)
  }

  // After successful Stop: checkpoint git HEAD, clear signal, reset turn tracking
  if (hookEvent === 'Stop') {
    const head = gitHead(rootDir)
    if (head) saveSessionState(sessionId, 'last_stop_head', head)
    const signal = getSignal(sessionId)
    if (signal) {
      clearSignal(sessionId)
      if (signal.type === 'done') setPhase(sessionId, 'unknown')
    }
    resetTurnTracking(sessionId)
  }

  process.exit(0)
}

module.exports = { dispatch, matchesHookEntry, evaluateWhen, recordSessionBaseline, writeEnvFile, settleTaskResult, spawnAsyncTask, harvestAsyncResults, cleanAsyncDir, hasSignalGatedTasks, injectSignalBlock, forkParallelTask, awaitParallelBatch, killParallelBatch, BUILTIN_EDIT_TOOLS, SIGNAL_PLAN_MARKER, SIGNAL_TASK_PATTERN }
