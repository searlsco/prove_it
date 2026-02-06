/**
 * Test harness for invoking hooks in integration tests.
 *
 * Provides helpers to:
 * - Invoke hooks with simulated input
 * - Create temporary directories with controlled state
 * - Parse and validate hook output
 */
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Test source hooks directly (they export main() and work standalone)
const HOOKS_DIR = path.join(__dirname, "..", "..", "lib", "hooks");

// Claude Code's valid permissionDecision values for PreToolUse hooks.
// Source: https://docs.anthropic.com/en/docs/claude-code/hooks
// Using any other value (e.g. "block", "approve") is silently ignored.
const VALID_PERMISSION_DECISIONS = ["allow", "deny", "ask"];

/**
 * Invoke a hook with the given input.
 *
 * @param {string} hookName - Name of the hook file (e.g., "prove_it_done.js")
 * @param {object} input - The input object to pass via stdin
 * @param {object} options - Options including projectDir, env overrides
 * @returns {object} - { exitCode, stdout, stderr, output (parsed JSON if valid) }
 */
function invokeHook(hookName, input, options = {}) {
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
function createTempDir(prefix = "prove_it_test_") {
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
 * Create a basic test script (script/test).
 *
 * @param {string} dir - Base directory
 * @param {boolean} shouldPass - Whether the script should exit 0
 */
function createTestScript(dir, shouldPass = true) {
  const scriptPath = path.join(dir, "script", "test");
  const content = shouldPass ? "#!/bin/bash\nexit 0\n" : "#!/bin/bash\necho 'Tests failed' >&2\nexit 1\n";
  createFile(dir, "script/test", content);
  makeExecutable(scriptPath);
}

// Alias for backwards compatibility
const createSuiteGate = createTestScript;

/**
 * Initialize beads in the given directory.
 * Creates the minimal structure that proves it's a beads project.
 *
 * @param {string} dir - Path to the directory
 */
function initBeads(dir) {
  const beadsDir = path.join(dir, ".beads");
  fs.mkdirSync(beadsDir, { recursive: true });
  // Create config.yaml to indicate this is a beads project (not just global config)
  fs.writeFileSync(path.join(beadsDir, "config.yaml"), "# beads config\n", "utf8");
}

/**
 * Assert that a hook result's permissionDecision uses a valid Claude Code value.
 * This catches bugs like using "block" instead of "deny".
 *
 * @param {object} result - The result from invokeHook
 * @param {string} label - Test context for error messages
 */
function assertValidPermissionDecision(result, label) {
  if (!result.output?.hookSpecificOutput?.permissionDecision) return;

  const decision = result.output.hookSpecificOutput.permissionDecision;
  assert.ok(
    VALID_PERMISSION_DECISIONS.includes(decision),
    `${label}: permissionDecision "${decision}" is not valid for Claude Code. ` +
    `Must be one of: ${VALID_PERMISSION_DECISIONS.join(", ")}`
  );
}

module.exports = {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  makeExecutable,
  createTestScript,
  createSuiteGate, // Alias for backwards compatibility
  initBeads,
  assertValidPermissionDecision,
  VALID_PERMISSION_DECISIONS,
  HOOKS_DIR,
};
