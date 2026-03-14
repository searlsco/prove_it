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

/**
 * Validate types of a single config layer before merge.
 * Throws on type mismatch with a clear message including the file path.
 */
function validateLayerTypes (layer, filePath) {
  const { CONFIG_SCHEMA } = require('./defaults')
  for (const key of Object.keys(layer)) {
    const expectedType = CONFIG_SCHEMA[key]
    if (!expectedType) continue // unknown keys validated elsewhere
    const value = layer[key]
    let valid
    if (expectedType === 'array') {
      valid = Array.isArray(value)
    } else if (expectedType === 'object') {
      valid = typeof value === 'object' && value !== null && !Array.isArray(value)
    } else {
      valid = typeof value === expectedType // eslint-disable-line valid-typeof
    }
    if (!valid) {
      const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      const article = expectedType === 'array' ? 'an' : 'a'
      throw new Error(
        `prove_it: type error in ${filePath}\n` +
        `  "${key}" must be ${article} ${expectedType}, got ${got}\n\n` +
        'To fix: update the value in the file shown above, or run:\n' +
        '  prove_it reinstall && prove_it reinit'
      )
    }
  }
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
  const userKeys = new Set()

  const globalCfg = loadJson(globalCfgPath)
  if (globalCfg) {
    validateLayerTypes(globalCfg, globalCfgPath)
    for (const key of Object.keys(globalCfg)) userKeys.add(key)
    cfg = mergeDeep(cfg, globalCfg)
  }

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
    if (ancestorCfg) {
      validateLayerTypes(ancestorCfg, cfgPath)
      for (const key of Object.keys(ancestorCfg)) userKeys.add(key)
      cfg = mergeDeep(cfg, ancestorCfg)
    }
  }

  const localCfg = loadJson(localCfgPath)
  if (localCfg) {
    validateLayerTypes(localCfg, localCfgPath)
    for (const key of Object.keys(localCfg)) userKeys.add(key)
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

  return { cfg, baseDir, localCfgPath, userKeys }
}

/**
 * Config builder for prove_it init.
 * Composes a config from optional feature flags.
 */

function baseConfig () {
  return {
    enabled: true,
    sources: [
      '**/*.*',
      '!**/*.{md,txt}',
      'replace/these/with/globs/of/your/source/and/test/files.*'
    ],
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
          { name: 'inject-tdd-plan', type: 'script', command: '$(prove_it prefix)/libexec/inject-plan', quiet: true, briefing: 'During implementation: follow BDD dual-loop TDD--start from a failing integration test, drive inward through unit-level red-green-refactor cycles, then confirm the integration test passes. During refactoring: run the test suite after every few edits to confirm behavior is preserved. To switch modes, run: prove_it phase implement  or  prove_it phase refactor', params: { position: 'before-steps', marker: 'dual-loop TDD', block: '## Development approach\n\nFollow BDD dual-loop TDD. Every feature increment starts from a failing integration\ntest and is driven inward through unit-level red-green-refactor cycles.\n\n### Outer loop (integration)\n\n1. **Red (integration)** — Write one integration/acceptance test that describes the\n   next observable behavior from the outside in. Run it. Confirm it fails for the\n   reason you expect. Do not proceed until the failure message matches your intent.\n\n2. **Inner loop (unit) — repeat until the integration test can pass:**\n   - **Red** — Write the smallest unit test that expresses the next missing piece of\n     implementation the integration test needs.\n   - **Green** — Write the minimum production code to make that unit test pass.\n     Run it in isolation and confirm. No speculative code.\n   - **Refactor** — Clean up the code you just wrote (duplication, naming, structure)\n     while all unit tests stay green. Only touch code covered by passing tests.\n\n3. **Green (integration)** — When enough unit-level pieces exist, re-run the\n   integration test. If it still fails, diagnose which piece is missing and drop back\n   into the inner loop. Do not add code without a failing test driving it.\n\n4. **Refactor (integration)** — With the integration test green, refactor across\n   module boundaries if needed. All tests — unit and integration — must stay green.\n\n5. **Repeat from step 1** with the next slice of behavior until the task is complete.\n\n### Discipline rules\n\n- Never skip the red step. If you cannot articulate why a test fails, you do not yet\n  understand the requirement.\n- One logical change per cycle. If you are changing more than one behavior at a time,\n  split it.\n- Run only the relevant test after each green step, then the full suite before each\n  commit-worthy checkpoint.\n- If a refactor breaks a test, revert the refactor — do not fix forward.\n- Treat a surprise failure (wrong message, wrong location) as information: re-read it,\n  adjust your understanding, then proceed.\n' } }
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
  validateLayerTypes,
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
