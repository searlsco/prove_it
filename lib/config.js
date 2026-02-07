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
 * Tier preset generators for prove_it init.
 * Each returns a v2 config object with hooks array.
 */

function tier1Config () {
  return {
    configVersion: 2,
    enabled: true,
    sources: ['src/**/*.js', 'lib/**/*.js', 'test/**/*.js'],
    format: { maxOutputChars: 12000 },
    hooks: [
      {
        type: 'claude',
        event: 'SessionStart',
        checks: [
          { name: 'session-baseline', type: 'script', command: 'prove_it builtin:session-baseline' },
          { name: 'beads-reminder', type: 'script', command: 'prove_it builtin:beads-reminder' }
        ]
      },
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Edit|Write|NotebookEdit|Bash',
        checks: [
          { name: 'config-protection', type: 'script', command: 'prove_it builtin:config-protection' }
        ]
      },
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Bash',
        triggers: ['(^|\\s)git\\s+commit\\b'],
        checks: [
          { name: 'full-tests', type: 'script', command: './script/test' }
        ]
      },
      {
        type: 'claude',
        event: 'Stop',
        checks: [
          { name: 'fast-tests', type: 'script', command: './script/test_fast' },
          { name: 'soft-stop', type: 'script', command: 'prove_it builtin:soft-stop-reminder' }
        ]
      }
    ]
  }
}

function tier2Config () {
  const cfg = tier1Config()
  cfg.hooks.push(
    {
      type: 'git',
      event: 'pre-commit',
      checks: [
        { name: 'full-tests', type: 'script', command: './script/test' }
      ]
    },
    {
      type: 'git',
      event: 'pre-push',
      checks: [
        { name: 'full-tests', type: 'script', command: './script/test' }
      ]
    }
  )
  return cfg
}

function tier3Config () {
  const cfg = tier2Config()

  // Add beads-gate to PreToolUse edit entry
  const editEntry = cfg.hooks.find(h =>
    h.type === 'claude' && h.event === 'PreToolUse' && h.matcher === 'Edit|Write|NotebookEdit|Bash')
  if (editEntry) {
    editEntry.checks.push({
      name: 'beads-gate',
      type: 'script',
      command: 'prove_it builtin:beads-gate',
      when: { fileExists: '.beads' }
    })
  }

  // Add code reviewer to pre-commit check
  const commitEntry = cfg.hooks.find(h =>
    h.type === 'claude' && h.event === 'PreToolUse' && h.triggers)
  if (commitEntry) {
    commitEntry.checks.push({
      name: 'code-review',
      type: 'agent',
      prompt: 'Review staged changes for:\n1. Test coverage gaps\n2. Logic errors or edge cases\n3. Dead code\n\nFAIL if any issue found. PASS only if all clean.\n\n{{staged_diff}}'
    })
  }

  // Add coverage reviewer to Stop
  const stopEntry = cfg.hooks.find(h => h.type === 'claude' && h.event === 'Stop')
  if (stopEntry) {
    // Insert before soft-stop reminder
    const softStopIdx = stopEntry.checks.findIndex(c => c.name === 'soft-stop')
    const coverageCheck = {
      name: 'coverage-review',
      type: 'agent',
      prompt: 'Check that code changes have corresponding test coverage.\n\n{{session_diffs}}'
    }
    if (softStopIdx >= 0) {
      stopEntry.checks.splice(softStopIdx, 0, coverageCheck)
    } else {
      stopEntry.checks.push(coverageCheck)
    }
  }

  return cfg
}

module.exports = {
  mergeDeep,
  getProveItDir,
  loadGlobalConfig,
  isIgnoredPath,
  loadEffectiveConfig,
  tier1Config,
  tier2Config,
  tier3Config
}
