const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson, writeJson, tryRun } = require('./io')
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

function resolveFastTests (rootDir, cfg) {
  if (cfg.commands?.test?.fast) return cfg.commands.test.fast
  if (fs.existsSync(path.join(rootDir, 'script', 'test_fast'))) return './script/test_fast'
  return resolveFullTests(rootDir, cfg)
}

function resolveFullTests (rootDir, cfg) {
  if (cfg.commands?.test?.full) return cfg.commands.test.full
  if (fs.existsSync(path.join(rootDir, 'script', 'test'))) return './script/test'
  if (fs.existsSync(path.join(rootDir, 'script', 'test_slow'))) return './script/test_slow'
  return './script/test'
}

function testScriptExists (rootDir, testCmd) {
  if (!testCmd) return false
  if (testCmd.startsWith('./script/') || testCmd.startsWith('./scripts/')) {
    return fs.existsSync(path.join(rootDir, testCmd.slice(2)))
  }
  return true
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

function runTests (rootDir, testCmd) {
  const start = Date.now()
  const r = tryRun(testCmd, { cwd: rootDir })
  const durationMs = Date.now() - start
  const combined = `${r.stdout}\n${r.stderr}`.trim()
  return { ...r, combined, durationMs }
}

function shouldSkipTests (rootDir, cfg, localCfgPath, runKey) {
  const runs = loadRunData(localCfgPath)
  const lastRun = runs[runKey]

  if (!lastRun || !lastRun.at) {
    return { skip: false }
  }

  const latestMtime = getLatestMtime(rootDir, cfg.sources)

  if (latestMtime === 0) {
    return { skip: false }
  }

  if (lastRun.at > latestMtime) {
    if (lastRun.pass) {
      return { skip: true, reason: 'passed', lastRun }
    } else {
      return { skip: true, reason: 'failed', lastRun }
    }
  }

  return { skip: false }
}

function fullTestsSatisfyFast (rootDir, cfg, localCfgPath) {
  const runs = loadRunData(localCfgPath)
  const fullRun = runs.test_full

  if (!fullRun || !fullRun.at || !fullRun.pass) {
    return false
  }

  const latestMtime = getLatestMtime(rootDir, cfg.sources)
  return latestMtime > 0 && fullRun.at > latestMtime
}

function testScriptMissingMessage (testCmd, projectDir) {
  const home = os.homedir()
  const displayPath = projectDir.startsWith(home) ? '~' + projectDir.slice(home.length) : projectDir

  return `prove_it: Test script not found.

The test command '${testCmd}' does not exist.

Options:

1. SET UP TESTING:
   - Run: prove_it init
   - Update script/test to run your full test suite (linter, formatter, etc.)
   - Create script/test_fast for just unit tests (faster feedback)

2. IGNORE THIS DIRECTORY (add to ~/.claude/prove_it/config.json):
   "ignoredPaths": ["${displayPath}"]

3. DISABLE VERIFICATION for this project:
   echo '{"enabled":false}' > .claude/prove_it.json

4. DISABLE GLOBALLY via environment:
   export PROVE_IT_DISABLED=1`
}

module.exports = {
  getLatestMtime,
  loadRunData,
  saveRunData,
  resolveFastTests,
  resolveFullTests,
  testScriptExists,
  resolveTestRoot,
  runTests,
  shouldSkipTests,
  fullTestsSatisfyFast,
  testScriptMissingMessage
}
