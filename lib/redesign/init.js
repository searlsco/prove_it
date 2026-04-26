const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { buildHookGroups, removeProveItGroups } = require('../commands/_helpers')
const { ensureDir, loadJson, writeJson } = require('../io')
const { BUILT_IN_PROFILE, CONFIG_DIR, LOCAL_CONFIG_FILE, PROFILE_VERSION, SCHEMA_VERSION, validateConfig } = require('./config')

const OWNERSHIP_FILE = 'ownership.json'
const OWNERSHIP_VERSION = 1
const OWNER = 'prove_it'
const SUPPORTED_ADAPTERS = new Set(['pi', 'claude'])

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function relPath (absolutePath, repoRoot) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/')
}

function artifactPath (repoRoot, relativePath) {
  const root = path.resolve(repoRoot)
  const resolved = path.resolve(root, ...relativePath.split('/'))
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`artifact path escapes repository: ${relativePath}`)
  }
  return resolved
}

function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function normalizeAdapters (adapters) {
  const normalized = []
  for (const adapter of adapters || []) {
    if (!SUPPORTED_ADAPTERS.has(adapter)) {
      throw new Error(`unsupported adapter "${adapter}" (expected one of: ${Array.from(SUPPORTED_ADAPTERS).join(', ')})`)
    }
    if (!normalized.includes(adapter)) normalized.push(adapter)
  }
  if (normalized.length === 0) {
    throw new Error('at least one --adapter is required for strict .prove_it init')
  }
  return normalized
}

function buildStrictProjectConfig (adapters) {
  const normalizedAdapters = normalizeAdapters(adapters)
  const cfg = {
    schema_version: SCHEMA_VERSION,
    profile_version: PROFILE_VERSION,
    profile: normalizedAdapters.length === 1 && normalizedAdapters[0] === 'claude' ? 'claude' : 'strict',
    adapters: clone(BUILT_IN_PROFILE.config.adapters)
  }
  for (const adapter of normalizedAdapters) {
    cfg.adapters[adapter] = { ...(cfg.adapters[adapter] || {}), enabled: true }
  }
  return cfg
}

function buildStrictLocalConfig () {
  return {
    schema_version: SCHEMA_VERSION,
    profile_version: PROFILE_VERSION
  }
}

function buildClaudeProjectSettings () {
  const settings = { hooks: {} }
  for (const { event, group } of buildHookGroups()) {
    settings.hooks[event] = [group]
  }
  return settings
}

function findOwnedArtifact (manifest, relativePath) {
  return manifest?.artifacts?.find(artifact => artifact.owner === OWNER && artifact.path === relativePath) || null
}

function isOwnedAndUnmodified (repoRoot, relativePath, existingManifest) {
  const artifact = findOwnedArtifact(existingManifest, relativePath)
  if (!artifact) return false
  const filePath = artifactPath(repoRoot, relativePath)
  return !artifact.sha256 || sha256File(filePath) === artifact.sha256
}

function recordArtifact (repoRoot, relativePath, manifest, metadata = {}) {
  manifest.artifacts.push({
    owner: OWNER,
    path: relativePath,
    sha256: sha256File(artifactPath(repoRoot, relativePath)),
    ...metadata
  })
}

function writeOwnedJsonIfSafe (repoRoot, relativePath, value, manifest, result, existingManifest, metadata = {}) {
  const filePath = artifactPath(repoRoot, relativePath)
  const existed = fs.existsSync(filePath)
  if (existed && !isOwnedAndUnmodified(repoRoot, relativePath, existingManifest)) {
    const reason = findOwnedArtifact(existingManifest, relativePath) ? 'modified' : 'unowned'
    result.skipped.push({ path: relativePath, reason })
    return false
  }
  writeJson(filePath, value)
  recordArtifact(repoRoot, relativePath, manifest, metadata)
  result[existed ? 'updated' : 'created'].push(relativePath)
  return true
}

function writeOwnedTextIfSafe (repoRoot, relativePath, content, manifest, result, existingManifest, metadata = {}) {
  const filePath = artifactPath(repoRoot, relativePath)
  const existed = fs.existsSync(filePath)
  if (existed && !isOwnedAndUnmodified(repoRoot, relativePath, existingManifest)) {
    const reason = findOwnedArtifact(existingManifest, relativePath) ? 'modified' : 'unowned'
    result.skipped.push({ path: relativePath, reason })
    return false
  }
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content)
  recordArtifact(repoRoot, relativePath, manifest, metadata)
  result[existed ? 'updated' : 'created'].push(relativePath)
  return true
}

function mergeClaudeSettingsIfSafe (repoRoot, manifest, result, existingManifest) {
  const relativePath = '.claude/settings.json'
  const filePath = artifactPath(repoRoot, relativePath)
  const generated = buildClaudeProjectSettings()
  const existed = fs.existsSync(filePath)

  if (existed) {
    if (!isOwnedAndUnmodified(repoRoot, relativePath, existingManifest)) {
      const reason = findOwnedArtifact(existingManifest, relativePath) ? 'modified' : 'unowned'
      result.skipped.push({ path: relativePath, reason })
      return false
    }
    const existing = loadJson(filePath)
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      result.skipped.push({ path: relativePath, reason: 'invalid' })
      return false
    }
    existing.hooks = existing.hooks || {}
    for (const event of Object.keys(existing.hooks)) {
      existing.hooks[event] = removeProveItGroups(existing.hooks[event])
      if (Array.isArray(existing.hooks[event]) && existing.hooks[event].length === 0) delete existing.hooks[event]
    }
    for (const { event, group } of buildHookGroups()) {
      existing.hooks[event] = [group, ...(existing.hooks[event] || [])]
    }
    existing.__prove_it_owned_by = OWNER
    existing.__prove_it_adapter = 'claude'
    writeJson(filePath, existing)
  } else {
    generated.__prove_it_owned_by = OWNER
    generated.__prove_it_adapter = 'claude'
    writeJson(filePath, generated)
  }

  recordArtifact(repoRoot, relativePath, manifest, {
    adapter: 'claude',
    kind: 'adapter_settings'
  })
  result[existed ? 'updated' : 'created'].push(relativePath)
  return true
}

function initStrictProject (repoRoot, options = {}) {
  const adapters = normalizeAdapters(options.adapters)
  const result = {
    config: { path: '.prove_it/config.json', created: false, existed: false },
    manifest: { path: '.prove_it/ownership.json', created: false, existed: false },
    created: [],
    updated: [],
    skipped: [],
    adapters
  }
  const manifestPath = path.join(repoRoot, CONFIG_DIR, OWNERSHIP_FILE)
  if (fs.existsSync(manifestPath)) result.manifest.existed = true

  const existingManifest = loadJson(manifestPath)
  const manifest = {
    schema_version: OWNERSHIP_VERSION,
    owner: OWNER,
    profile_version: PROFILE_VERSION,
    adapters,
    artifacts: []
  }

  const configPath = path.join(repoRoot, CONFIG_DIR, 'config.json')
  if (fs.existsSync(configPath)) result.config.existed = true
  const configWritten = writeOwnedJsonIfSafe(repoRoot, '.prove_it/config.json', buildStrictProjectConfig(adapters), manifest, result, existingManifest, {
    kind: 'shared_config'
  })
  if (configWritten && !result.config.existed) result.config.created = true

  writeOwnedJsonIfSafe(repoRoot, `.prove_it/${LOCAL_CONFIG_FILE}`, buildStrictLocalConfig(), manifest, result, existingManifest, {
    kind: 'shared_local_config'
  })
  writeOwnedTextIfSafe(repoRoot, '.prove_it/.gitignore', `${LOCAL_CONFIG_FILE}\n`, manifest, result, existingManifest, {
    kind: 'shared_gitignore'
  })

  if (adapters.includes('claude')) {
    mergeClaudeSettingsIfSafe(repoRoot, manifest, result, existingManifest)
  }

  if (manifest.artifacts.length > 0) {
    writeJson(manifestPath, manifest)
    result.manifest.created = !result.manifest.existed
    validateConfig(loadJson(configPath), '.prove_it/config.json')
  }

  return result
}

function removeEmptyDirs (repoRoot, dirs, removed) {
  for (const relativePath of dirs) {
    const dir = artifactPath(repoRoot, relativePath)
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir)
        removed.push(relativePath.endsWith('/') ? relativePath : `${relativePath}/`)
      }
    } catch {}
  }
}

function deinitStrictProject (repoRoot) {
  const result = { removed: [], skipped: [] }
  const proveItDir = path.join(repoRoot, CONFIG_DIR)
  const manifestPath = path.join(proveItDir, OWNERSHIP_FILE)

  if (!fs.existsSync(proveItDir)) return result
  if (!fs.existsSync(manifestPath)) {
    result.skipped.push({ path: '.prove_it/', reason: 'missing ownership manifest' })
    return result
  }

  const manifest = loadJson(manifestPath)
  if (!manifest || manifest.owner !== OWNER || !Array.isArray(manifest.artifacts)) {
    result.skipped.push({ path: '.prove_it/', reason: 'invalid ownership manifest' })
    return result
  }

  for (const artifact of manifest.artifacts) {
    if (!artifact || artifact.owner !== OWNER || typeof artifact.path !== 'string') continue
    let filePath
    try {
      filePath = artifactPath(repoRoot, artifact.path)
    } catch {
      result.skipped.push({ path: artifact.path, reason: 'unsafe path' })
      continue
    }
    if (!fs.existsSync(filePath)) continue
    if (artifact.sha256 && sha256File(filePath) !== artifact.sha256) {
      result.skipped.push({ path: artifact.path, reason: 'modified' })
      continue
    }
    fs.rmSync(filePath, { force: true })
    result.removed.push(artifact.path)
  }

  const remainingSkipped = result.skipped.length > 0
  if (!remainingSkipped) {
    fs.rmSync(manifestPath, { force: true })
    result.removed.push('.prove_it/ownership.json')
  }

  removeEmptyDirs(repoRoot, ['.prove_it', '.claude'], result.removed)
  return result
}

module.exports = {
  OWNERSHIP_FILE,
  buildClaudeProjectSettings,
  buildStrictProjectConfig,
  deinitStrictProject,
  initStrictProject,
  normalizeAdapters,
  relPath
}
