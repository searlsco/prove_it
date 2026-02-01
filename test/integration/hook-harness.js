/**
 * Test harness for invoking hooks in integration tests.
 *
 * Provides helpers to:
 * - Invoke hooks with simulated input
 * - Create temporary directories with controlled state
 * - Parse and validate hook output
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOOKS_DIR = path.join(__dirname, "..", "..", "global", "hooks");

/**
 * Invoke a hook with the given input.
 *
 * @param {string} hookName - Name of the hook file (e.g., "prove-it-gate.js")
 * @param {object} input - The input object to pass via stdin
 * @param {object} options - Options including projectDir, env overrides
 * @returns {object} - { exitCode, stdout, stderr, output (parsed JSON if valid) }
 */
function invokeHook(hookName, input, options = {}) {
  // Use built hooks from global/hooks/ (they have inlined shared functions)
  const hookPath = path.join(HOOKS_DIR, hookName);

  const env = { ...process.env, ...options.env };
  if (options.projectDir) {
    env.CLAUDE_PROJECT_DIR = options.projectDir;
  }

  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env,
    cwd: options.cwd || process.cwd(),
  });

  let output = null;
  try {
    if (result.stdout && result.stdout.trim()) {
      output = JSON.parse(result.stdout);
    }
  } catch {
    // Output is not valid JSON
  }

  return {
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output,
  };
}

/**
 * Create a temporary directory for testing.
 *
 * @param {string} prefix - Prefix for the temp directory name
 * @returns {string} - Path to the created directory
 */
function createTempDir(prefix = "prove-it-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Clean up a temporary directory.
 *
 * @param {string} dir - Path to the directory to remove
 */
function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Initialize a git repo in the given directory.
 *
 * @param {string} dir - Path to the directory
 */
function initGitRepo(dir) {
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf8" });
}

/**
 * Create a file in the given directory.
 *
 * @param {string} dir - Base directory
 * @param {string} relativePath - Path relative to dir
 * @param {string} content - File content
 */
function createFile(dir, relativePath, content) {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

/**
 * Make a file executable.
 *
 * @param {string} filePath - Path to the file
 */
function makeExecutable(filePath) {
  fs.chmodSync(filePath, 0o755);
}

/**
 * Create a basic suite gate script.
 *
 * @param {string} dir - Base directory
 * @param {boolean} shouldPass - Whether the script should exit 0
 */
function createSuiteGate(dir, shouldPass = true) {
  const scriptPath = path.join(dir, "script", "test");
  const content = shouldPass ? "#!/bin/bash\nexit 0\n" : "#!/bin/bash\necho 'Tests failed' >&2\nexit 1\n";
  createFile(dir, "script/test", content);
  makeExecutable(scriptPath);
}

/**
 * Initialize beads in the given directory.
 *
 * @param {string} dir - Path to the directory
 */
function initBeads(dir) {
  fs.mkdirSync(path.join(dir, ".beads"), { recursive: true });
}

module.exports = {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  makeExecutable,
  createSuiteGate,
  initBeads,
  HOOKS_DIR,
};
