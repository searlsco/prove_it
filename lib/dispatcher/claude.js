const fs = require('fs')
const path = require('path')
const { readStdin, ensureDir } = require('../io')
const { loadEffectiveConfig, isIgnoredPath, loadGlobalConfig, getProveItDir } = require('../config')
const { resolveTestRoot } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck } = require('../checks/agent')
const protocol = require('./protocol')

/**
 * Evaluate `when` conditions on a check.
 * All keys in a `when` object are AND-ed.
 */
function evaluateWhen (when, context) {
  if (!when) return true

  if (when.fileExists) {
    const target = path.join(context.rootDir, when.fileExists)
    if (!fs.existsSync(target)) return false
  }

  if (when.envSet) {
    if (!process.env[when.envSet]) return false
  }

  if (when.envNotSet) {
    if (process.env[when.envNotSet]) return false
  }

  if (when.variablesPresent) {
    const { makeResolvers } = require('../template')
    const resolvers = makeResolvers(context)
    for (const varName of when.variablesPresent) {
      const resolver = resolvers[varName]
      if (!resolver) return false
      const value = resolver()
      if (!value || !value.trim()) return false
    }
  }

  return true
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
    enabled: true,
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
    const { gitRoot, gitHead, gitStatusHash } = require('../git')
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
 * Main dispatcher for Claude Code hook events.
 * Reads stdin, finds matching hook entries, runs checks.
 */
function dispatch (event) {
  let input
  try {
    input = JSON.parse(readStdin())
  } catch (e) {
    protocol.emit(event, protocol.failDecision(event),
      `prove_it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`)
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
      e.message)
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

  // Build context shared across all checks
  const context = {
    rootDir,
    projectDir,
    sessionId,
    hookEvent,
    toolName,
    toolInput,
    localCfgPath,
    sources: cfg.sources,
    maxChars,
    testOutput: ''
  }

  // Find matching hook entries
  const matchingEntries = hooks.filter(entry => matchesHookEntry(entry, hookEvent, input))

  if (matchingEntries.length === 0) {
    process.exit(0)
  }

  // Collect all results (for SessionStart text concatenation)
  const outputs = []

  for (const entry of matchingEntries) {
    const tasks = entry.tasks || []

    for (const task of tasks) {
      if (!evaluateWhen(task.when, context)) continue

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
          outputs.push(result.reason)
        } else {
          // PreToolUse/Stop: fail fast — block and exit immediately
          protocol.emit(hookEvent, protocol.failDecision(hookEvent),
            `prove_it: ${task.name} failed.\n\n${result.reason}`)
          process.exit(0)
        }
      } else {
        if (result.output || result.reason) {
          outputs.push(result.reason || result.output)
        }
      }
    }
  }

  // All checks passed (or SessionStart always continues)
  if (hookEvent === 'SessionStart') {
    // SessionStart: emit all collected text
    protocol.emitSessionStart(outputs.join('\n'))
    process.exit(0)
  }

  // For PreToolUse/Stop: emit pass
  const summaryParts = outputs.filter(o => o && !o.startsWith('cached'))
  const summary = summaryParts.length > 0 ? summaryParts.join('\n') : 'all checks passed'
  protocol.emit(hookEvent, protocol.passDecision(hookEvent),
    `prove_it: ${summary}`)
  process.exit(0)
}

module.exports = { dispatch, matchesHookEntry, evaluateWhen, defaultConfig, recordSessionBaseline }
