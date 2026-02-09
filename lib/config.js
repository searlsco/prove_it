const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson } = require('./io')

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
 * 3. Ancestor configs: .claude/prove_it.json from root-most to cwd (cwd wins)
 * 4. Local: cwd/.claude/prove_it.local.json
 */
function loadEffectiveConfig (projectDir, defaultFn) {
  const baseDir = getProveItDir()
  const globalCfgPath = path.join(baseDir, 'config.json')
  const localCfgPath = path.join(projectDir, '.claude', 'prove_it.local.json')

  let cfg = defaultFn()

  const globalCfg = loadJson(globalCfgPath)
  if (globalCfg) cfg = mergeDeep(cfg, globalCfg)

  const configPaths = []
  let current = path.resolve(projectDir)
  while (current !== path.dirname(current)) {
    const cfgPath = path.join(current, '.claude', 'prove_it.json')
    if (fs.existsSync(cfgPath)) {
      configPaths.push(cfgPath)
    }
    current = path.dirname(current)
  }

  for (const cfgPath of configPaths.reverse()) {
    const ancestorCfg = loadJson(cfgPath)
    if (ancestorCfg) cfg = mergeDeep(cfg, ancestorCfg)
  }

  const localCfg = loadJson(localCfgPath)
  if (localCfg) cfg = mergeDeep(cfg, localCfg)

  return { cfg, baseDir, localCfgPath }
}

/**
 * Config builder for prove_it init.
 * Composes a v2 config from optional feature flags.
 */

function baseConfig () {
  return {
    configVersion: 2,
    enabled: true,
    sources: ['**/*.*', 'replace/these/with/globs/of/your/source/and/test/files.*'],
    format: { maxOutputChars: 12000 },
    hooks: [
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Edit|Write|NotebookEdit|Bash',
        tasks: [
          { name: 'lock-config', type: 'script', command: 'prove_it run_builtin config:lock' }
        ]
      },
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast' }
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
      { name: 'full-tests', type: 'script', command: './script/test' }
    ]
  })
}

function addDefaultChecks (cfg) {
  // Add beads:require_wip to PreToolUse edit entry
  const editEntry = cfg.hooks.find(h =>
    h.type === 'claude' && h.event === 'PreToolUse' && h.matcher === 'Edit|Write|NotebookEdit|Bash')
  if (editEntry) {
    editEntry.tasks.push({
      name: 'require-wip',
      type: 'script',
      command: 'prove_it run_builtin beads:require_wip',
      when: { fileExists: '.beads' }
    })
  }

  // Add review:commit_quality to git pre-commit entry
  const preCommitEntry = cfg.hooks.find(h =>
    h.type === 'git' && h.event === 'pre-commit')
  if (preCommitEntry) {
    preCommitEntry.tasks.push({
      name: 'commit-review',
      type: 'script',
      command: 'prove_it run_builtin review:commit_quality'
    })
  }

  // Add review:test_coverage to Stop
  const stopEntry = cfg.hooks.find(h => h.type === 'claude' && h.event === 'Stop')
  if (stopEntry) {
    stopEntry.tasks.push({
      name: 'coverage-review',
      type: 'script',
      command: 'prove_it run_builtin review:test_coverage'
    })
  }
}

/**
 * Build a prove_it config from composable feature flags.
 *
 * @param {object} options
 * @param {boolean} options.gitHooks - Include git hook config entries (default: true)
 * @param {boolean} options.defaultChecks - Include beads:require_wip, review:commit_quality, review:test_coverage (default: true)

 * @returns {object} v2 config object
 */
function buildConfig ({ gitHooks = true, defaultChecks = true } = {}) {
  const cfg = baseConfig()
  if (gitHooks) addGitHooks(cfg)
  if (defaultChecks) addDefaultChecks(cfg)
  return cfg
}

module.exports = {
  mergeDeep,
  getProveItDir,
  loadGlobalConfig,
  isIgnoredPath,
  loadEffectiveConfig,
  buildConfig
}
