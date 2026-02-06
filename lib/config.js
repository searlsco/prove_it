const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson } = require('./io')

function mergeDeep (a, b) {
  if (b === undefined || b === null) return a
  if (Array.isArray(a) && Array.isArray(b)) return b
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

function defaultTestConfig () {
  return {
    commands: { test: { full: null, fast: null } },
    sources: null,
    hooks: {
      done: {
        enabled: true,
        triggers: [
          '(^|\\s)git\\s+commit\\b'
        ],
        reviewer: { enabled: true, command: 'claude -p', outputMode: 'text' }
      },
      stop: {
        enabled: true,
        reviewer: { enabled: true, command: 'claude -p', outputMode: 'text' }
      }
    },
    format: { maxOutputChars: 12000 }
  }
}

function defaultBeadsConfig () {
  return { beads: { enabled: true } }
}

function isBeadsRepo (dir) {
  const beadsDir = path.join(dir, '.beads')
  if (!fs.existsSync(beadsDir)) return false
  return (
    fs.existsSync(path.join(beadsDir, 'config.yaml')) ||
    fs.existsSync(path.join(beadsDir, 'beads.db')) ||
    fs.existsSync(path.join(beadsDir, 'metadata.json'))
  )
}

module.exports = {
  mergeDeep,
  getProveItDir,
  loadGlobalConfig,
  isIgnoredPath,
  loadEffectiveConfig,
  defaultTestConfig,
  defaultBeadsConfig,
  isBeadsRepo
}
