const { loadEffectiveConfig } = require('../config')
const { resolveTestRoot } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck } = require('../checks/agent')
const { evaluateWhen } = require('./claude')

/**
 * Default config for git dispatcher.
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
function runGitChecks (entries, context) {
  const failures = []

  for (const entry of entries) {
    const mode = entry.mode || 'all'
    const checks = entry.checks || []

    for (const check of checks) {
      if (!evaluateWhen(check.when, context)) continue

      let result
      if (check.type === 'script') {
        result = runScriptCheck(check, context)
      } else if (check.type === 'agent') {
        result = runAgentCheck(check, context)
      } else {
        continue
      }

      if (result.output) {
        context.testOutput = result.output
      }

      if (!result.pass) {
        failures.push(`${check.name}: ${result.reason}`)
        if (mode === 'first-fail') break
      }
    }
  }

  return { failures }
}

/**
 * Main dispatcher for git hook events (pre-commit, pre-push, etc.).
 * No stdin JSON — loads config from .claude/prove_it.json.
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

  const { cfg, localCfgPath } = loadEffectiveConfig(projectDir, defaultConfig)

  if (cfg.enabled === false) {
    process.exit(0)
  }

  const hooks = cfg.hooks || []
  const rootDir = resolveTestRoot(projectDir)
  const maxChars = cfg.format?.maxOutputChars || 12000

  const context = {
    rootDir,
    projectDir,
    sessionId: null,
    hookEvent: event,
    toolName: null,
    toolInput: null,
    localCfgPath,
    sources: cfg.sources,
    maxChars,
    testOutput: ''
  }

  const matchingEntries = matchGitEntries(hooks, event)

  if (matchingEntries.length === 0) {
    process.exit(0)
  }

  const { failures } = runGitChecks(matchingEntries, context)

  if (failures.length > 0) {
    console.error('prove_it: git hook checks failed:\n')
    for (const f of failures) {
      console.error(`  ${f}\n`)
    }
    process.exit(1)
  }

  process.exit(0)
}

module.exports = { dispatch, defaultConfig, matchGitEntries, runGitChecks }
