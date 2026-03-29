const fs = require('fs')
const path = require('path')
const { readStdin } = require('../io')
const { backchannelPrefix } = require('../paths')
const { loadEffectiveConfig, isIgnoredPath, loadGlobalConfig } = require('../config')
const { resolveTestRoot, getLatestMtime } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck, cleanBackchannel } = require('../checks/agent')
const { handleScriptAppeal, isTaskSuspended, resetFailures } = require('../checks/arbiter')
const { runEnvTask } = require('../checks/env')
const { SESSION_KEYS, logReview, logCommandResult, pruneOldSessions, recordFileEdit, resetTurnTracking, saveSessionState, loadSessionState, VALID_SIGNALS, setSignal, getSignal, clearSignal, VALID_PHASES, setPhase, writeDispatcherPid, clearDispatcherPid, readCancelSentinel, clearCancelSentinel } = require('../session')
const { isSourceFile } = require('../globs')
const { gitRoot, gitHead, gitStatusHash, incrementGross, computeWriteLines } = require('../git')
const protocol = require('./protocol')
const { SIGNAL_PLAN_MARKER, PHASE_PLAN_MARKER, SIGNAL_TASK_PATTERN, detectLastNumberedHeading, detectPlanPhase, buildSignalBlock, buildPhaseBlock, findPlanFile, appendPlanBlock } = require('../plan')
const { configDefaults } = require('../defaults')
const { BUILTIN_EDIT_TOOLS, evaluateWhen } = require('../when')
const { settleTaskResult, spawnAsyncTask, harvestAsyncResults, cleanAsyncDir, forkParallelTask, awaitParallelBatch, killParallelBatch } = require('../task-runner')

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
  const claudeHooks = hooks.claude || {}
  for (const tasks of Object.values(claudeHooks)) {
    if (tasks && tasks.length > 0) return true
  }
  return false
}

function hasSignalGatedTasks (hooks) {
  const claudeHooks = hooks.claude || {}
  for (const tasks of Object.values(claudeHooks)) {
    for (const task of (tasks || [])) {
      if (!task.when) continue
      const clauses = Array.isArray(task.when) ? task.when : [task.when]
      if (clauses.some(c => c.signal === 'done')) return true
    }
  }
  return false
}

/**
 * Check if a task matches the current event context.
 * Matcher, source, and triggers live on the task (not the hook entry).
 */
function taskMatchesInput (task, event, input) {
  // Source matching for SessionStart
  if (event === 'SessionStart' && task.source) {
    const sources = task.source.split('|')
    const inputSource = input.source || ''
    if (!sources.some(s => s === inputSource)) return false
  }

  // Matcher for PreToolUse/PostToolUse/PostToolUseFailure (tool name matching, regex like Claude Code)
  const toolMatchEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']
  if (toolMatchEvents.includes(event) && task.matcher) {
    const toolName = input.tool_name || ''
    try {
      if (!new RegExp('^(?:' + task.matcher + ')$').test(toolName)) return false
    } catch {
      // Invalid regex—fall back to exact split matching
      const matchers = task.matcher.split('|')
      if (!matchers.some(m => m === toolName)) return false
    }
  }

  // Trigger matching for PreToolUse + Bash
  if (event === 'PreToolUse' && task.triggers && task.triggers.length > 0) {
    const toolCmd = input.tool_input?.command || ''
    const matches = task.triggers.some(re => {
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
  // Only record once per session
  if (loadSessionState(sessionId, SESSION_KEYS.GIT)) return

  try {
    const root = gitRoot(projectDir) || projectDir
    const head = gitHead(root)
    const statusHash = gitStatusHash(root)
    saveSessionState(sessionId, 'session_id', sessionId)
    saveSessionState(sessionId, 'project_dir', projectDir)
    saveSessionState(sessionId, 'root_dir', root)
    saveSessionState(sessionId, 'started_at', new Date().toISOString())
    saveSessionState(sessionId, SESSION_KEYS.GIT, { is_repo: true, root, head, status_hash: statusHash })
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
async function dispatch (event, _input) {
  let input
  try {
    input = _input || JSON.parse(readStdin())
  } catch (e) {
    // Circuit breaker: non-blocking pass so malformed stdin doesn't create a death spiral
    const circuitMsg = `prove_it: Failed to parse hook input: ${e.message}`
    if (event === 'PreToolUse') {
      protocol.emitPreToolUseContext(circuitMsg)
    } else {
      protocol.emit(event, protocol.passDecision(event), circuitMsg)
    }
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
    const alreadyReported = sessionId && loadSessionState(sessionId, SESSION_KEYS.CONFIG_ERROR)
    if (!alreadyReported) {
      if (sessionId) saveSessionState(sessionId, SESSION_KEYS.CONFIG_ERROR, e.message)
      logReview(sessionId, projectDir, 'config', 'BOOM', e.message, null, hookEvent)
    }

    // SessionStart: always emit the error prominently
    if (hookEvent === 'SessionStart') {
      const bold = `\u26a0\ufe0f prove_it config is invalid \u2014 hooks are disabled until this is fixed.\n\n${e.message}`
      protocol.emitSessionStart({ additionalContext: bold, systemMessage: bold })
    } else if (!alreadyReported) {
      // PreToolUse/Stop: non-blocking pass with warning (first time only)
      if (hookEvent === 'PreToolUse') {
        protocol.emitPreToolUseContext(e.message, { systemMessage: e.message })
      } else {
        protocol.emit(hookEvent, protocol.passDecision(hookEvent),
          e.message, e.message)
      }
    }
    process.exit(0)
  }

  // Check for top-level enabled: false
  if (cfg.enabled === false) {
    process.exit(0)
  }

  const hooks = cfg.hooks
  if (!hooks || !hasTasks(hooks)) {
    // Even with no tasks, inject PROVE_IT_SESSION_ID on SessionStart
    if (hookEvent === 'SessionStart') {
      const source = input.source || ''
      if (sessionId && (source === 'startup' || source === 'resume')) {
        writeEnvFile({ PROVE_IT_SESSION_ID: sessionId })
      }
    }
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
        protocol.emitPreToolUseContext(
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
        const phaseSystemMsg = `Phase set to "${phaseType}". This is an administrative mode switch — continue with your current task.`
        protocol.emitPreToolUseContext(
          `prove_it: phase "${phaseType}" recorded\n\n${phaseSystemMsg}`,
          { systemMessage: phaseSystemMsg })
        process.exit(0)
      }
      // Unknown type: fall through, CLI will error with exit 1
    }
  }

  // Infrastructure-level plan mode enforcement
  if (hookEvent === 'PreToolUse' && toolName === 'EnterPlanMode') {
    setPhase(sessionId, 'plan')
    // Fall through to normal task matching so EnterPlanMode-matched tasks can run
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

  // Get tasks for this event, filtered by matcher/source/triggers
  const allEventTasks = (hooks.claude && hooks.claude[hookEvent]) || []
  const matchingTasks = allEventTasks.filter(task => taskMatchesInput(task, hookEvent, input))

  if (matchingTasks.length === 0) {
    process.exit(0)
  }

  // Collect results
  const outputs = []
  const contextParts = []
  const systemMessages = []
  const additionalContextParts = []
  const envVars = {}

  // Harvest async results—before sync tasks so failures block immediately
  // On Stop: settle all results (failures block). On other events: only settle
  // context-only results (pass/skip); hold failures for the next Stop.
  {
    const asyncResults = harvestAsyncResults(sessionId)
    const settlCtx = { rootDir, sources: cfg.sources, localCfgPath }
    for (const ar of asyncResults) {
      const isBlocking = !ar.data.result.pass && !ar.data.result.skipped

      // On non-Stop events, hold blocking results for later
      if (isBlocking && hookEvent !== 'Stop') {
        continue // leave the result file in place for Stop harvest
      }

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

  // Write dispatcher PID so `prove_it cancel` can find and kill us
  writeDispatcherPid(sessionId, { pid: process.pid, event: hookEvent, startedAt: Date.now() })

  const parallelBatch = []

  for (const task of matchingTasks) {
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

    // Check for cancel sentinel — user ran `prove_it cancel`
    // Must check after task completes (spawnSync returns) but before acting on failure
    if (readCancelSentinel(sessionId)) {
      clearCancelSentinel(sessionId)
      clearDispatcherPid(sessionId)
      killParallelBatch(parallelBatch)
      for (const { resultPath } of parallelBatch) {
        try { fs.unlinkSync(resultPath) } catch {}
      }
      protocol.emit(hookEvent, protocol.passDecision(hookEvent),
        'prove_it: Cancelled by user')
      process.exit(0)
    }

    if (settlement.blocked) {
      clearDispatcherPid(sessionId)
      killParallelBatch(parallelBatch)
      for (const { resultPath } of parallelBatch) {
        try { fs.unlinkSync(resultPath) } catch {}
      }
      protocol.emit(hookEvent, protocol.failDecision(hookEvent), settlement.message, settlement.message)
      process.exit(0)
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
    // Always inject PROVE_IT_SESSION_ID on startup/resume
    const source = input.source || ''
    if (sessionId && (source === 'startup' || source === 'resume')) {
      envVars.PROVE_IT_SESSION_ID = sessionId
    }

    // Write env vars to CLAUDE_ENV_FILE if any were collected
    if (Object.keys(envVars).length > 0) {
      writeEnvFile(envVars)
      const varNames = Object.keys(envVars).join(', ')
      contextParts.push(`prove_it: set env vars: ${varNames}`)
    }

    // Collect briefings from ALL tasks across all hooks (not just SessionStart entries)
    for (const hookType of Object.values(hooks)) {
      for (const tasks of Object.values(hookType || {})) {
        for (const task of (tasks || [])) {
          if (task.enabled === false) continue
          if (task.briefing && typeof task.briefing === 'string') {
            contextParts.push(task.briefing)
          }
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
    const contextText = [summary, additionalContext].filter(Boolean).join('\n')
    protocol.emitPreToolUseContext(
      `prove_it: ${contextText}`)
  } else if (hookEvent === 'PostToolUse') {
    protocol.emitPostToolUse({ additionalContext: additionalContext || (summaryParts.length > 0 ? summary : undefined) })
  } else if (hookEvent === 'PostToolUseFailure') {
    protocol.emitPostToolUseFailure({ additionalContext: additionalContext || (summaryParts.length > 0 ? summary : undefined) })
  } else {
    protocol.emit(hookEvent, protocol.passDecision(hookEvent),
      `prove_it: ${summary}`)
  }

  // Clean up dispatcher PID file
  clearDispatcherPid(sessionId)

  // After successful Stop: checkpoint git HEAD, clear signal, reset turn tracking
  if (hookEvent === 'Stop') {
    const head = gitHead(rootDir)
    if (head) saveSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD, head)
    const signal = getSignal(sessionId)
    if (signal) {
      clearSignal(sessionId)
      if (signal.type === 'done') setPhase(sessionId, 'unknown')
    }
    resetTurnTracking(sessionId)
  }

  process.exit(0)
}

module.exports = { dispatch, taskMatchesInput, evaluateWhen, recordSessionBaseline, writeEnvFile, settleTaskResult, spawnAsyncTask, harvestAsyncResults, cleanAsyncDir, hasSignalGatedTasks, injectSignalBlock, forkParallelTask, awaitParallelBatch, killParallelBatch, BUILTIN_EDIT_TOOLS, SIGNAL_PLAN_MARKER, SIGNAL_TASK_PATTERN }
