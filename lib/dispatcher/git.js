const { loadEffectiveConfig } = require('../config')
const { resolveTestRoot, getLatestMtime, saveRunData } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck } = require('../checks/agent')
const { evaluateWhen } = require('./claude')
const { logReview } = require('../session')
const { advanceChurnRef } = require('../git')

/**
 * Default config for git dispatcher.
 */
function defaultConfig () {
  return {
    enabled: false,
    sources: null,
    hooks: []
  }
}

/**
 * Match git hook entries from config by type and event.
 */
function matchGitEntries (hooks, event) {
  if (!Array.isArray(hooks)) return []
  return hooks.filter(entry => entry.type === 'git' && entry.event === event)
}

/**
 * Run checks for matched git hook entries.
 * Returns { failures: string[] } — empty means all passed.
 */
function runGitTasks (entries, context) {
  for (const entry of entries) {
    const tasks = entry.tasks || []

    for (const task of tasks) {
      if (task.enabled === false) {
        logReview(context.sessionId, context.projectDir, task.name, 'SKIP', 'Disabled', null, context.hookEvent)
        continue
      }

      delete context._triggerProgress
      const whenResult = evaluateWhen(task.when, context, task.name)
      if (whenResult !== true) {
        const extra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
        logReview(context.sessionId, context.projectDir, task.name, 'SKIP', whenResult, null, context.hookEvent, extra)
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

      // Fail fast — first failure blocks the commit/push
      if (!result.pass) {
        advanceChurnRef(task, false, context.hookEvent, context.rootDir, context.sources)
        return { failure: `${task.name}: ${result.reason}` }
      }

      if (!result.skipped) {
        advanceChurnRef(task, true, context.hookEvent, context.rootDir, context.sources)

        // Record mtime-based run only on success — failures should be sticky
        // so the task re-fires until sources change. Skip for script tasks —
        // script.js writes its own { at, result } record (mtime defaults to on).
        if (task.when && task.when.sourcesModifiedSinceLastRun && task.type !== 'script') {
          const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
          saveRunData(context.localCfgPath, runKey, { at: context.latestSourceMtime, result: 'pass' })
        }
      }
    }
  }

  return { failure: null }
}

/**
 * Main dispatcher for git hook events (pre-commit, pre-push, etc.).
 * No stdin JSON — loads config from .claude/prove_it/config.json.
 * Exit 0 = all pass, exit 1 = any fail. Reasons on stderr.
 */
function dispatch (event) {
  // Only run under Claude Code — human commits are instant no-ops
  if (!process.env.CLAUDECODE) {
    process.exit(0)
  }

  const projectDir = process.cwd()

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0)
  }

  let cfg, localCfgPath
  try {
    ({ cfg, localCfgPath } = loadEffectiveConfig(projectDir, defaultConfig))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  if (cfg.enabled === false) {
    process.exit(0)
  }

  const hooks = cfg.hooks || []
  const rootDir = resolveTestRoot(projectDir)
  const maxChars = cfg.format?.maxOutputChars || 12000

  let _latestSourceMtime = null
  const context = {
    rootDir,
    projectDir,
    sessionId: null,
    hookEvent: event,
    toolName: null,
    toolInput: null,
    localCfgPath,
    sources: cfg.sources,
    configEnv: cfg.taskEnv || null,
    configModel: cfg.model || null,
    maxChars,
    testOutput: '',
    get latestSourceMtime () {
      if (_latestSourceMtime === null) _latestSourceMtime = getLatestMtime(rootDir, cfg.sources)
      return _latestSourceMtime
    }
  }

  const matchingEntries = matchGitEntries(hooks, event)

  if (matchingEntries.length === 0) {
    process.exit(0)
  }

  const { failure } = runGitTasks(matchingEntries, context)

  if (failure) {
    console.error(`prove_it: ${failure}\n`)
    process.exit(1)
  }

  console.error('prove_it: all checks passed')
  process.exit(0)
}

module.exports = { dispatch, defaultConfig, matchGitEntries, runGitTasks }
