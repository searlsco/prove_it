const { saveRunData } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck } = require('../checks/agent')
const { evaluateWhen } = require('./claude')
const { logReview } = require('../session')
const { advanceTaskRef, churnSinceRef, grossChurnSince, sanitizeRefName, whenHasKey } = require('../git')

/**
 * Get git hook tasks from config by event name.
 */
function getGitTasks (hooks, event) {
  if (!hooks || typeof hooks !== 'object') return []
  return (hooks.git && hooks.git[event]) || []
}

/**
 * Run checks for matched git hook tasks.
 * Returns { failure: string|null }—null means all passed.
 */
function runGitTasks (tasks, context) {
  for (const task of tasks) {
    if (task.enabled === false) {
      if (!task.quiet) logReview(context.sessionId, context.projectDir, task.name, 'SKIP', 'Disabled', null, context.hookEvent)
      continue
    }

    delete context._triggerProgress
    const whenResult = evaluateWhen(task.when, context, task.name)
    if (whenResult !== true) {
      if (!task.quiet) {
        const extra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
        logReview(context.sessionId, context.projectDir, task.name, 'SKIP', whenResult, null, context.hookEvent, extra)
      }
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
      logReview(context.sessionId, context.projectDir, task.name, 'BOOM', reason, null, context.hookEvent)
      result = { pass: true, reason: `⚠ ${reason}`, output: '', skipped: true }
    }

    if (result.output) {
      context.testOutput = result.output
    }

    // Fail fast—first failure blocks the commit/push
    if (!result.pass) {
      advanceTaskRef(task, false, context.hookEvent, context.rootDir, context.sources)
      return { failure: `${task.name}: ${result.reason}` }
    }

    if (!result.skipped) {
      advanceTaskRef(task, true, context.hookEvent, context.rootDir, context.sources)

      // Record run data on success—failures should be sticky
      // so the task re-fires until sources change.
      if (whenHasKey(task.when, 'sourcesModifiedSinceLastRun')) {
        const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
        saveRunData(context.localCfgPath, runKey, { at: Date.now(), result: 'pass' })
      }
    }
  }

  return { failure: null }
}

function buildGitObservationFacts (effectiveConfig, pipeline, rootDir) {
  const facts = {
    sourcesModifiedSinceLastRun: {},
    sourceModifiedSinceLastRun: {},
    linesChanged: {},
    netLinesChanged: {},
    linesWritten: {},
    grossLinesWritten: {},
    churn: { net: {}, gross: {} }
  }
  const tasks = effectiveConfig?.tasks || {}
  const sources = effectiveConfig?.globs?.source || []
  for (const taskName of pipeline) {
    const task = tasks[taskName]
    if (!task?.when) continue
    const refName = sanitizeRefName(taskName)
    if (whenHasKey(task.when, 'sourcesModifiedSinceLastRun') || whenHasKey(task.when, 'linesChanged')) {
      const lines = churnSinceRef(rootDir, refName, sources)
      facts.sourcesModifiedSinceLastRun[taskName] = { modified: lines > 0, evidence: { linesChanged: lines } }
      facts.sourceModifiedSinceLastRun[taskName] = facts.sourcesModifiedSinceLastRun[taskName]
      facts.linesChanged[taskName] = lines
      facts.netLinesChanged[taskName] = lines
      facts.churn.net[taskName] = lines
    }
    if (whenHasKey(task.when, 'linesWritten')) {
      const lines = grossChurnSince(rootDir, refName)
      facts.linesWritten[taskName] = lines
      facts.grossLinesWritten[taskName] = lines
      facts.churn.gross[taskName] = lines
    }
  }
  return facts
}

function createGitScriptTaskPort (event, effectiveConfig, rootDir) {
  const { createScriptTaskPort } = require('../redesign/script_task_port')
  const sources = effectiveConfig?.globs?.source || []
  return createScriptTaskPort({
    runScript (check, context) {
      const result = runScriptCheck(check, context)
      if (result.pass) advanceTaskRef(check, true, event, rootDir, sources)
      return result
    }
  })
}

/**
 * Main dispatcher for git hook events (pre-commit, pre-push, etc.).
 * No stdin JSON—loads config from .claude/prove_it/config.json.
 * Exit 0 = all pass, exit 1 = any fail. Reasons on stderr.
 */
function dispatch (event) {
  // Only run under Claude Code—human commits are instant no-ops
  if (!process.env.CLAUDECODE) {
    process.exit(0)
  }

  const projectDir = process.cwd()

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0)
  }

  const {
    loadEffectiveConfig: loadStrictEffectiveConfig,
    projectConfigPath
  } = require('../redesign/config')
  const { normalizeLifecycleEvent } = require('../redesign/events')
  const { runWorkflowEngine } = require('../redesign/engine')

  if (!require('fs').existsSync(projectConfigPath(projectDir))) {
    process.exit(0)
  }

  let explained
  try {
    explained = loadStrictEffectiveConfig(projectDir, { requireConfigFile: true })
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  const effectiveConfig = explained && explained.effective
  const normalizedEvent = normalizeLifecycleEvent({
    adapterId: 'git',
    rawEventName: event,
    rawEvent: {},
    cwd: projectDir,
    projectDir,
    rootDir: projectDir
  })
  const pipeline = effectiveConfig?.git_workflows?.[normalizedEvent.stage] || []
  if (pipeline.length === 0) process.exit(0)

  const effect = runWorkflowEngine({
    event: normalizedEvent,
    effectiveConfig,
    taskPort: createGitScriptTaskPort(event, effectiveConfig, projectDir),
    observationPort: {
      facts: buildGitObservationFacts(effectiveConfig, pipeline, projectDir)
    }
  })

  if (effect.effect === 'block' || effect.effect === 'fail') {
    console.error(`${effect.reason || effect.message || 'prove_it: git workflow failed'}\n`)
    process.exit(1)
  }

  console.error('prove_it: all checks passed')
  process.exit(0)
}

module.exports = { buildGitObservationFacts, createGitScriptTaskPort, dispatch, getGitTasks, runGitTasks }
