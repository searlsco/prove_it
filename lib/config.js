const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson } = require('./io')

function configHash (cfg) {
  const copy = { ...cfg }
  delete copy.initSeed
  return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex').slice(0, 12)
}

function mergeDeep (a, b) {
  if (b === undefined || b === null) return a
  if (Array.isArray(b)) return b
  if (Array.isArray(a)) return b
  if (typeof a === 'object' && a && typeof b === 'object' && b) {
    const out = { ...a }
    for (const k of Object.keys(b)) out[k] = mergeDeep(a[k], b[k])
    return out
  }
  return b
}

function getProveItDir () {
  return process.env.PROVE_IT_DIR || path.join(os.homedir(), '.claude', 'prove_it')
}

function loadGlobalConfig () {
  return loadJson(path.join(getProveItDir(), 'config.json')) || {}
}

function isIgnoredPath (projectDir, ignoredPaths) {
  if (!ignoredPaths || !Array.isArray(ignoredPaths) || ignoredPaths.length === 0) {
    return false
  }

  const home = os.homedir()
  const normalizedProject = path.resolve(projectDir)

  for (const ignored of ignoredPaths) {
    const normalizedIgnored = ignored.startsWith('~/')
      ? path.resolve(path.join(home, ignored.slice(2)))
      : path.resolve(ignored)

    if (normalizedProject === normalizedIgnored || normalizedProject.startsWith(normalizedIgnored + path.sep)) {
      return true
    }
  }
  return false
}

/**
 * Load effective config by walking from cwd upward (mirroring Claude Code's CLAUDE.md discovery).
 *
 * Resolution order (later wins):
 * 1. Defaults
 * 2. Global: ~/.claude/prove_it/config.json
 * 3. Ancestor configs: .claude/prove_it/config.json from root-most to cwd (cwd wins)
 * 4. Local: cwd/.claude/prove_it/config.local.json
 *
 * Validates the merged config when a project config file was found.
 * Throws on validation errors; logs warnings to stderr.
 */
function loadEffectiveConfig (projectDir, defaultFn) {
  const baseDir = getProveItDir()
  const globalCfgPath = path.join(baseDir, 'config.json')
  const localCfgPath = path.join(projectDir, '.claude', 'prove_it', 'config.local.json')

  let cfg = defaultFn()

  const globalCfg = loadJson(globalCfgPath)
  if (globalCfg) cfg = mergeDeep(cfg, globalCfg)

  let hasProjectConfig = false
  const configPaths = []
  let current = path.resolve(projectDir)
  while (current !== path.dirname(current)) {
    const cfgPath = path.join(current, '.claude', 'prove_it', 'config.json')
    if (fs.existsSync(cfgPath)) {
      configPaths.push(cfgPath)
      hasProjectConfig = true
    }
    current = path.dirname(current)
  }

  for (const cfgPath of configPaths.reverse()) {
    const ancestorCfg = loadJson(cfgPath)
    if (ancestorCfg) cfg = mergeDeep(cfg, ancestorCfg)
  }

  const localCfg = loadJson(localCfgPath)
  if (localCfg) {
    cfg = mergeDeep(cfg, localCfg)
    hasProjectConfig = true
  }

  // Validate only when a project config was found
  if (hasProjectConfig) {
    const { validateConfig, formatErrors } = require('./validate')
    const result = validateConfig(cfg)
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.error(`prove_it: warning: ${w}`)
      }
    }
    if (result.errors.length > 0) {
      throw new Error(formatErrors(result))
    }
  }

  return { cfg, baseDir, localCfgPath }
}

/**
 * Config builder for prove_it init.
 * Composes a config from optional feature flags.
 */

function baseConfig () {
  return {
    enabled: true,
    sources: ['**/*.*', 'replace/these/with/globs/of/your/source/and/test/files.*'],
    tests: [
      '**/*.{test,spec}.*',
      '**/*_{test,spec}.*',
      '**/{test,tests,spec,specs,__tests__}/**/*.*'
    ],
    hooks: [
      {
        type: 'claude',
        event: 'SessionStart',
        tasks: [
          { name: 'session-briefing', type: 'script', command: '$(prove_it prefix)/libexec/briefing', quiet: true }
        ]
      },
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
        tasks: [
          { name: 'lock-config', type: 'script', command: '$(prove_it prefix)/libexec/guard-config', quiet: true, params: { paths: ['.claude/prove_it/config.json', '.claude/prove_it/config.local.json'] } },
          { name: 'test-first', type: 'script', command: '$(prove_it prefix)/libexec/test-first', quiet: true, params: { untestedEditLimit: 3 } }
        ]
      },
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'ExitPlanMode',
        tasks: [
          { name: 'inject-tdd-plan', type: 'script', command: '$(prove_it prefix)/libexec/inject-plan', quiet: true, briefing: 'During implementation: follow red-green TDD--write a failing test, confirm the failure, write the minimum code to pass, confirm it passes. During refactoring: run the test suite after every few edits to confirm behavior is preserved. To switch modes, run: prove_it phase implement  or  prove_it phase refactor', params: { position: 'after-title', marker: 'red-green TDD', block: '## Development approach\n\nFollow red-green TDD for each change:\n\n- Write a test that expresses the behavior you\'re about to implement\n- Run it and verify it fails for the reason you expect\n- Write the minimum source code to make the test pass\n- Re-run the test in isolation and confirm it passes (or the failure message changes as expected) before moving on\n' } }
        ]
      },
      {
        type: 'claude',
        event: 'PostToolUse',
        matcher: 'Bash',
        tasks: [
          { name: 'test-first', type: 'script', command: '$(prove_it prefix)/libexec/test-first', quiet: true }
        ]
      },
      {
        type: 'claude',
        event: 'PostToolUseFailure',
        matcher: 'Bash',
        tasks: [
          { name: 'test-first', type: 'script', command: '$(prove_it prefix)/libexec/test-first', quiet: true }
        ]
      },
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast', when: { sourcesModifiedSinceLastRun: true, sourceFilesEditedThisTurn: true } },
          { name: 'full-tests', type: 'script', command: './script/test', parallel: true, when: { signal: 'done', sourceFilesEditedThisTurn: true } }
        ]
      }
    ]
  }
}

function addGitHooks (cfg) {
  cfg.hooks.push({
    type: 'git',
    event: 'pre-commit',
    tasks: [
      { name: 'full-tests', type: 'script', command: './script/test', when: { sourcesModifiedSinceLastRun: true } }
    ]
  })
}

function addDefaultChecks (cfg) {
  const stopEntry = cfg.hooks.find(h => h.type === 'claude' && h.event === 'Stop')
  if (stopEntry) {
    // Add coverage review to Stop (net-churn-gated)
    stopEntry.tasks.push({
      name: 'coverage-review',
      type: 'agent',
      async: true,
      promptType: 'skill',
      prompt: 'prove-coverage',
      model: 'haiku',
      ruleFile: '.claude/rules/testing.md',
      when: { linesChanged: 541 }
    })

    // Add signal-gated pre-ship review (fires when agent signals "done")
    stopEntry.tasks.push({
      name: 'done-review',
      type: 'agent',
      parallel: true,
      promptType: 'skill',
      prompt: 'prove-done',
      model: 'opus',
      ruleFile: '.claude/rules/done.md',
      when: { signal: 'done' }
    })

    // Add signal-gated approach viability review (fires when agent signals "stuck")
    stopEntry.tasks.push({
      name: 'approach-review',
      type: 'agent',
      parallel: true,
      promptType: 'skill',
      prompt: 'prove-approach',
      model: 'sonnet',
      when: { signal: 'stuck' }
    })
  }
}

/**
 * Build a prove_it config from composable feature flags.
 *
 * @param {object} options
 * @param {boolean} options.gitHooks - Include git hook config entries (default: true)
 * @param {boolean} options.defaultChecks - Include prove-coverage, prove-done (default: true)

 * @returns {object} config object
 */
function buildConfig ({ gitHooks = true, defaultChecks = true } = {}) {
  const cfg = baseConfig()
  if (gitHooks) addGitHooks(cfg)
  if (defaultChecks) addDefaultChecks(cfg)
  return cfg
}

/**
 * Check whether a config key holds a user-customized value (not the default).
 * Works for any array-valued top-level key (sources, tests, etc.).
 */
const NOT_CUSTOMIZED = {
  sources: (value) => value.some(s => typeof s === 'string' && s.includes('replace/these/with/globs'))
}

function hasCustomValue (key, config) {
  const value = config?.[key]
  if (!Array.isArray(value) || value.length === 0) return false
  // Key-specific "still a placeholder" check
  if (NOT_CUSTOMIZED[key] && NOT_CUSTOMIZED[key](value)) return false
  // Exact match against defaults
  const defaults = baseConfig()[key]
  if (!Array.isArray(defaults)) return true
  if (value.length === defaults.length && value.every((v, i) => v === defaults[i])) return false
  return true
}

// Convenience wrappers for backwards compatibility
function hasCustomSources (config) { return hasCustomValue('sources', config) }
function hasCustomTests (config) { return hasCustomValue('tests', config) }

function buildGlobalConfig () {
  const { CONFIG_DEFAULTS } = require('./defaults')
  return {
    enabled: true,
    maxAgentTurns: CONFIG_DEFAULTS.maxAgentTurns,
    taskEnv: { ...CONFIG_DEFAULTS.taskEnv }
  }
}

/**
 * Walk up from `startDir` looking for `.claude/prove_it/config.json`.
 * Returns the directory containing it, or null.
 */
function findProveItProject (startDir) {
  let current = path.resolve(startDir)
  while (true) {
    const cfgPath = path.join(current, '.claude', 'prove_it', 'config.json')
    if (fs.existsSync(cfgPath)) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

module.exports = {
  configHash,
  mergeDeep,
  getProveItDir,
  loadGlobalConfig,
  isIgnoredPath,
  loadEffectiveConfig,
  buildConfig,
  buildGlobalConfig,
  hasCustomValue,
  hasCustomSources,
  hasCustomTests,
  findProveItProject
}
