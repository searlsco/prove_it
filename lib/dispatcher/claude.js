const { readStdin } = require('../io')
const { isGitRepo } = require('../git')
const { loadEffectiveConfig, isIgnoredPath, loadGlobalConfig } = require('../config')
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
    const fs = require('fs')
    const path = require('path')
    const target = path.join(context.rootDir, when.fileExists)
    if (!fs.existsSync(target)) return false
  }

  if (when.envSet) {
    if (!process.env[when.envSet]) return false
  }

  if (when.envNotSet) {
    if (process.env[when.envNotSet]) return false
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
    format: { maxOutputChars: 12000 },
    hooks: []
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

  // Skip hooks entirely for non-git directories
  if (!isGitRepo(projectDir)) {
    process.exit(0)
  }

  // Check for ignored paths in global config
  const globalCfg = loadGlobalConfig()
  if (isIgnoredPath(projectDir, globalCfg.ignoredPaths)) {
    process.exit(0)
  }

  const { cfg, localCfgPath } = loadEffectiveConfig(projectDir, defaultConfig)

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
    const mode = entry.mode || (hookEvent === 'SessionStart' ? 'all' : 'first-fail')
    const checks = entry.checks || []

    for (const check of checks) {
      // Evaluate when conditions
      if (!evaluateWhen(check.when, context)) continue

      let result
      if (check.type === 'script') {
        result = runScriptCheck(check, context)
      } else if (check.type === 'agent') {
        result = runAgentCheck(check, context)
      } else {
        continue
      }

      // Update testOutput for subsequent checks
      if (result.output) {
        context.testOutput = result.output
      }

      if (!result.pass) {
        if (hookEvent === 'SessionStart') {
          // SessionStart doesn't block, just collect output
          outputs.push(result.reason)
        } else {
          protocol.emit(hookEvent, protocol.failDecision(hookEvent),
            `prove_it: ${check.name} failed.\n\n${result.reason}`)
          process.exit(0)
        }
        if (mode === 'first-fail') break
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

module.exports = { dispatch, matchesHookEntry, evaluateWhen, defaultConfig }
