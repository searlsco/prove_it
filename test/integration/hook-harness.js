/**
 * Test harness for invoking the v2 dispatchers in integration tests.
 *
 * Provides helpers to:
 * - Invoke dispatchers with simulated input
 * - Create temporary directories with controlled state
 * - Parse and validate hook output
 */
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CLI_PATH = path.join(__dirname, '..', '..', 'cli.js')

// Claude Code's valid permissionDecision values for PreToolUse hooks.
const VALID_PERMISSION_DECISIONS = ['allow', 'deny', 'ask']

/**
 * Sentinel error thrown to intercept process.exit() during in-process dispatch.
 */
class DispatchExit extends Error {
  constructor () { super(''); this.name = 'DispatchExit' }
}

/**
 * Invoke a dispatcher via the CLI.
 *
 * @param {string} hookSpec - Hook spec (e.g., "claude:Stop", "claude:PreToolUse")
 * @param {object} input - The input object to pass via stdin
 * @param {object} options - Options including projectDir, env overrides
 * @returns {object} - { exitCode, stdout, stderr, output (parsed JSON if valid) }
 */
function invokeHook (hookSpec, input, options = {}) {
  const cleanEnv = options.cleanEnv !== undefined ? options.cleanEnv : !!options.env
  const base = cleanEnv ? {} : process.env
  const env = { ...base, ...options.env }
  if (options.projectDir) {
    env.CLAUDE_PROJECT_DIR = options.projectDir
  }

  const result = spawnSync('node', [CLI_PATH, 'hook', hookSpec], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env,
    cwd: options.cwd || process.cwd()
  })

  let output = null
  try {
    if (result.stdout && result.stdout.trim()) {
      output = JSON.parse(result.stdout)
    }
  } catch {
    // Output is not valid JSON (e.g., SessionStart text)
  }

  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output
  }
}

/**
 * Invoke a dispatcher in-process (no subprocess spawn).
 * Intercepts process.exit and stdout to capture output.
 * ~10x faster than invokeHook for Claude dispatcher tests.
 */
async function invokeDispatcher (hookSpec, input, options = {}) {
  const { dispatch } = require('../../lib/dispatcher/claude')
  const event = hookSpec.split(':')[1]

  // Snapshot env for full restore after dispatch.
  // Clear vars that prove_it's hook runner injects into the process chain.
  const envSnapshot = { ...process.env }
  delete process.env.PROVE_IT_DISABLED
  delete process.env.PROVE_IT_SKIP_NOTIFY

  const envOverrides = { ...options.env }
  if (options.projectDir) envOverrides.CLAUDE_PROJECT_DIR = options.projectDir
  for (const [k, v] of Object.entries(envOverrides)) {
    process.env[k] = v
  }

  // Intercept process.exit
  const origExit = process.exit
  process.exit = () => { throw new DispatchExit() }

  // Capture stdout
  const origWrite = process.stdout.write
  let stdout = ''
  process.stdout.write = function (chunk) { stdout += chunk; return true }

  try {
    await dispatch(event, input)
  } catch (e) {
    if (!(e instanceof DispatchExit)) throw e
  } finally {
    process.exit = origExit
    process.stdout.write = origWrite
    // Restore env: remove any keys dispatch added, restore original values
    for (const k of Object.keys(process.env)) {
      if (!(k in envSnapshot)) delete process.env[k]
    }
    Object.assign(process.env, envSnapshot)
  }

  let output = null
  try { if (stdout.trim()) output = JSON.parse(stdout) } catch {}
  return { exitCode: 0, stdout, stderr: '', output }
}

/**
 * Create a temporary directory for testing.
 */
function createTempDir (prefix = 'prove_it_test_') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Clean up a temporary directory.
 */
function cleanupTempDir (dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * Initialize a git repo in the given directory.
 */
function initGitRepo (dir) {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' })
}

/**
 * Cached git repo template for fast test setup.
 * Creates a git repo with .gitkeep once, then copies via fs.cpSync.
 * Eliminates 5 spawnSync calls per test.
 */
let harnessTemplate = null

function freshHarnessRepo () {
  if (!harnessTemplate) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_harness_tmpl_'))
    spawnSync('git', ['init'], { cwd: dir })
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    fs.writeFileSync(path.join(dir, '.gitkeep'), '')
    spawnSync('git', ['add', '.'], { cwd: dir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir })
    harnessTemplate = dir
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_test_'))
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.cpSync(harnessTemplate, tmpDir, { recursive: true })
  return tmpDir
}

/**
 * Clean a shared repo between tests, preserving git state.
 * Removes all files/dirs except .git and .gitkeep.
 */
function cleanRepo (dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.git' || entry === '.gitkeep') continue
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
  }
}

/**
 * Shared reviewer script fixtures (created once, reused across tests).
 */
let _reviewerFixtures = null

function reviewerFixtures () {
  if (_reviewerFixtures) return _reviewerFixtures
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_fixtures_'))
  _reviewerFixtures = {}
  for (const [name, body] of [
    ['pass', 'echo "PASS"'],
    ['fail', 'echo "FAIL: untested code"'],
    ['skip', 'echo "SKIP: changes are unrelated"'],
    ['crash', 'exit 1']
  ]) {
    const p = path.join(dir, `${name}.sh`)
    fs.writeFileSync(p, `#!/usr/bin/env bash\ncat > /dev/null\n${body}\n`)
    fs.chmodSync(p, 0o755)
    _reviewerFixtures[name] = p
  }
  return _reviewerFixtures
}

/**
 * Create a file in the given directory.
 */
function createFile (dir, relativePath, content) {
  const fullPath = path.join(dir, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
}

/**
 * Make a file executable.
 */
function makeExecutable (filePath) {
  fs.chmodSync(filePath, 0o755)
}

/**
 * Create a basic test script (script/test).
 */
function createTestScript (dir, shouldPass = true) {
  const scriptPath = path.join(dir, 'script', 'test')
  const content = shouldPass ? '#!/usr/bin/env bash\nexit 0\n' : "#!/usr/bin/env bash\necho 'Tests failed' >&2\nexit 1\n"
  createFile(dir, 'script/test', content)
  makeExecutable(scriptPath)
}

/**
 * Create a fast test script (script/test_fast).
 */
function createFastTestScript (dir, shouldPass = true) {
  const scriptPath = path.join(dir, 'script', 'test_fast')
  const content = shouldPass ? '#!/usr/bin/env bash\nexit 0\n' : "#!/usr/bin/env bash\necho 'Tests failed' >&2\nexit 1\n"
  createFile(dir, 'script/test_fast', content)
  makeExecutable(scriptPath)
}

/**
 * Write a prove_it config to a project directory.
 */
function writeConfig (dir, config) {
  const cfgPath = path.join(dir, '.claude', 'prove_it/config.json')
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8')
}

/**
 * Create a minimal config with specified hooks.
 */
function makeConfig (hooks, overrides = {}) {
  return {
    enabled: true,
    hooks,
    ...overrides
  }
}

/**
 * Assert that a hook result's permissionDecision uses a valid Claude Code value.
 */
function assertValidPermissionDecision (result, label) {
  if (!result.output?.hookSpecificOutput?.permissionDecision) return

  const decision = result.output.hookSpecificOutput.permissionDecision
  assert.ok(
    VALID_PERMISSION_DECISIONS.includes(decision),
    `${label}: permissionDecision "${decision}" is not valid for Claude Code. ` +
    `Must be one of: ${VALID_PERMISSION_DECISIONS.join(', ')}`
  )
}

/**
 * Create fake session snapshot data so a reviewer hook can find diffs.
 */
function setupSessionWithDiffs (tmpDir, sessionId, projectDir) {
  const encoded = projectDir.replace(/[^a-zA-Z0-9-]/g, '-')
  const sessDir = path.join(tmpDir, '.claude', 'projects', encoded)
  fs.mkdirSync(sessDir, { recursive: true })

  const snapshot = {
    type: 'file-history-snapshot',
    snapshot: {
      messageId: 'msg-001',
      trackedFileBackups: {
        'src/feature.js': {
          backupFileName: 'src_feature.js.bak',
          version: 1
        }
      }
    }
  }
  fs.writeFileSync(
    path.join(sessDir, `${sessionId}.jsonl`),
    JSON.stringify(snapshot) + '\n'
  )

  const histDir = path.join(tmpDir, '.claude', 'file-history', sessionId)
  fs.mkdirSync(histDir, { recursive: true })
  fs.writeFileSync(
    path.join(histDir, 'src_feature.js.bak'),
    'function feature() {}\n'
  )

  createFile(projectDir, 'src/feature.js',
    'function feature() {}\nfunction untested() { return 42; }\n'
  )
}

/**
 * Standard env overrides to isolate tests from real user config.
 */
function isolatedEnv (tmpDir) {
  const testBin = path.join(__dirname, '..', 'bin')
  return {
    PATH: `${testBin}${path.delimiter}${process.env.PATH}`,
    HOME: tmpDir,
    PROVE_IT_DIR: path.join(tmpDir, '.prove_it_test')
  }
}

module.exports = {
  invokeHook,
  invokeDispatcher,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  freshHarnessRepo,
  cleanRepo,
  reviewerFixtures,
  createFile,
  makeExecutable,
  createTestScript,
  createFastTestScript,
  writeConfig,
  makeConfig,
  assertValidPermissionDecision,
  setupSessionWithDiffs,
  isolatedEnv,
  VALID_PERMISSION_DECISIONS,
  CLI_PATH
}
