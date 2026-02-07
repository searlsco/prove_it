const fs = require('fs')
const path = require('path')
const { loadJson, writeJson } = require('./io')
const { gitRoot, gitTrackedFiles } = require('./git')
const { expandGlobs } = require('./globs')

function getLatestMtime (rootDir, globs) {
  const files = globs && globs.length > 0
    ? expandGlobs(rootDir, globs)
    : gitTrackedFiles(rootDir)

  let maxMtime = 0
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(rootDir, file))
      if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs
    } catch (e) {
      console.error(`prove_it: stat failed for ${file}: ${e.message}`)
    }
  }
  return maxMtime
}

function loadRunData (localCfgPath) {
  const data = loadJson(localCfgPath)
  return data?.runs || {}
}

function saveRunData (localCfgPath, runKey, runData) {
  const data = loadJson(localCfgPath) || {}
  if (!data.runs) data.runs = {}
  data.runs[runKey] = runData
  writeJson(localCfgPath, data)
}

function resolveTestRoot (projectDir) {
  let current
  try {
    current = fs.realpathSync(projectDir)
  } catch {
    current = path.resolve(projectDir)
  }

  const rawRoot = gitRoot(current)
  let root = null
  if (rawRoot) {
    try {
      root = fs.realpathSync(rawRoot)
    } catch {
      root = rawRoot
    }
  }

  if (!root) {
    return current
  }

  while (true) {
    const hasTestScript = fs.existsSync(path.join(current, 'script', 'test'))
    const hasConfig = fs.existsSync(path.join(current, '.claude', 'prove_it.json'))

    if (hasTestScript || hasConfig) {
      return current
    }

    if (current === root) {
      break
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }

    current = parent
  }

  return current
}

module.exports = {
  getLatestMtime,
  loadRunData,
  saveRunData,
  resolveTestRoot
}
