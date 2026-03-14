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
    const hasConfig = fs.existsSync(path.join(current, '.claude', 'prove_it', 'config.json'))

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

/**
 * Read the result of a run record, handling both new ({ result: 'pass'|'fail'|'skip' })
 * and old ({ pass: boolean }) formats.
 */
function runResult (run) {
  if (run.result) return run.result
  if (run.pass === true) return 'pass'
  if (run.pass === false) return 'fail'
  return 'pass' // no field = legacy agent save
}

const KNOWN_TEST_COMMANDS = [
  'npm test', 'npm run test', 'npx jest', 'npx vitest', 'npx mocha', 'npx ava', 'npx tap',
  'yarn test', 'yarn jest', 'pnpm test', 'bun test', 'deno test',
  'pytest', 'python -m pytest', 'python -m unittest',
  'go test', 'cargo test', 'swift test', 'mix test', 'elixir -S mix test',
  'bundle exec rspec', 'bundle exec rake test', 'rake test', 'rails test',
  'phpunit', 'vendor/bin/phpunit', './vendor/bin/phpunit',
  'dotnet test', 'gradle test', './gradlew test', 'mvn test', './mvnw test',
  'make test', 'cmake --build . --target test',
  'flutter test', 'dart test',
  'xcodebuild test',
  './script/test', './scripts/test', 'script/test',
  'tldr', 'bundle exec tldr'
]

/**
 * Check if a Bash command is a test-run command.
 * Strips leading env var assignments, then checks if the command
 * starts with any known test command prefix.
 *
 * @param {string} command - The Bash command to check
 * @param {string[]} [extraCommands] - Additional user-configured command prefixes
 * @returns {boolean}
 */
function isTestCommand (command, extraCommands) {
  if (!command) return false
  // Strip leading env var assignments (e.g., CI=1 VERBOSE=1)
  let cmd = command.trim()
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
    cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
  }

  const allCommands = extraCommands && extraCommands.length > 0
    ? [...KNOWN_TEST_COMMANDS, ...extraCommands]
    : KNOWN_TEST_COMMANDS

  return allCommands.some(prefix => {
    if (cmd === prefix) return true
    if (cmd.startsWith(prefix + ' ')) return true
    return false
  })
}

module.exports = {
  getLatestMtime,
  loadRunData,
  saveRunData,
  runResult,
  resolveTestRoot,
  KNOWN_TEST_COMMANDS,
  isTestCommand
}
