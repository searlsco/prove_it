const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  createTestScript,
  makeExecutable,
} = require("./hook-harness");

/**
 * Integration tests for the four README promises:
 *
 * 1. Stop blocks when fast tests fail
 * 2. Stop blocks when coverage reviewer fails (tests pass)
 * 3. Pre-commit runs tests at hook time and blocks on failure
 * 4. Pre-commit blocks when code reviewer fails (after tests pass)
 * 5. Pre-commit allows commit through unchanged when tests + reviewer pass
 */

/**
 * Create fake session snapshot data so the Stop reviewer can find diffs.
 *
 * Without this, generateDiffsSince returns [] and the reviewer is auto-PASS'd.
 * We override HOME so os.homedir() resolves inside tmpDir.
 */
function setupSessionWithDiffs(tmpDir, sessionId, projectDir) {
  const encoded = projectDir.replace(/\//g, "-").replace(/^-/, "-");
  const sessDir = path.join(tmpDir, ".claude", "projects", encoded);
  fs.mkdirSync(sessDir, { recursive: true });

  const snapshot = {
    type: "file-history-snapshot",
    snapshot: {
      messageId: "msg-001",
      trackedFileBackups: {
        "src/feature.js": {
          backupFileName: "src_feature.js.bak",
          version: 1,
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(sessDir, `${sessionId}.jsonl`),
    JSON.stringify(snapshot) + "\n"
  );

  // Backup file (old content)
  const histDir = path.join(tmpDir, ".claude", "file-history", sessionId);
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(
    path.join(histDir, "src_feature.js.bak"),
    "function feature() {}\n"
  );

  // Current file (new content — produces a diff)
  createFile(projectDir, "src/feature.js",
    "function feature() {}\nfunction untested() { return 42; }\n"
  );
}

describe("README promises: prove_it blocks when it should", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir("prove_it_readme_");
    initGitRepo(tmpDir);

    // Initial commit so git HEAD exists
    createFile(tmpDir, ".gitkeep", "");
    spawnSync("git", ["add", "."], { cwd: tmpDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tmpDir });
  });

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  // Shared env overrides to isolate from real user config
  function isolatedEnv() {
    return {
      HOME: tmpDir,
      PROVE_IT_DIR: path.join(tmpDir, ".prove_it_test"),
    };
  }

  describe("Stop hook", () => {
    it("blocks when test_fast fails", () => {
      createFile(tmpDir, "script/test_fast",
        "#!/bin/bash\necho 'FAIL: 2 tests broken' >&2\nexit 1\n");
      makeExecutable(path.join(tmpDir, "script", "test_fast"));

      const result = invokeHook("prove_it_test.js", {
        hook_event_name: "Stop",
        session_id: "test-stop-fail",
        cwd: tmpDir,
      }, { projectDir: tmpDir, env: isolatedEnv() });

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output, "Hook should produce JSON output");
      assert.strictEqual(result.output.decision, "block",
        "Stop must block when fast tests fail");
      assert.ok(result.output.reason.includes("Tests failed"),
        "Reason should mention test failure");
    });

    it("blocks when coverage reviewer fails (even though tests pass)", () => {
      // Passing fast tests
      createFile(tmpDir, "script/test_fast", "#!/bin/bash\nexit 0\n");
      makeExecutable(path.join(tmpDir, "script", "test_fast"));

      // Reviewer mock that always FAILs
      createFile(tmpDir, ".claude/prove_it.json", JSON.stringify({
        hooks: {
          stop: {
            reviewer: {
              enabled: true,
              command: "echo 'FAIL: insufficient test coverage for new code'",
            },
          },
        },
      }));

      // Session snapshot data so diffs exist (otherwise reviewer is skipped)
      const sessionId = "test-stop-reviewer";
      setupSessionWithDiffs(tmpDir, sessionId, tmpDir);

      const result = invokeHook("prove_it_test.js", {
        hook_event_name: "Stop",
        session_id: sessionId,
        cwd: tmpDir,
      }, { projectDir: tmpDir, env: isolatedEnv() });

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output, "Hook should produce JSON output");
      assert.strictEqual(result.output.decision, "block",
        "Stop must block when coverage reviewer fails");
      assert.ok(
        result.output.reason.includes("Coverage reviewer: FAIL") ||
        result.output.reason.includes("insufficient test coverage"),
        `Reason should mention reviewer failure, got: ${result.output.reason}`
      );
    });
  });

  describe("Pre-commit hook (PreToolUse)", () => {
    it("blocks commit at hook time when tests fail", () => {
      // Failing test script
      createFile(tmpDir, "script/test",
        "#!/bin/bash\necho 'FAIL: 3 tests broken' >&2\nexit 1\n");
      makeExecutable(path.join(tmpDir, "script", "test"));

      const result = invokeHook("prove_it_test.js", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "ship it"' },
        cwd: tmpDir,
      }, { projectDir: tmpDir, env: isolatedEnv() });

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output, "Hook should produce JSON output");

      const cmd = result.output.hookSpecificOutput.updatedInput.command;
      assert.ok(cmd.includes("exit 1"),
        "Command must be replaced with exit 1 when tests fail");
      assert.ok(!cmd.includes("git commit"),
        "Original git commit must NOT appear — tests blocked it");
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes("tests failed"),
        "Reason should mention test failure"
      );
    });

    it("allows commit through unchanged when tests pass", () => {
      createTestScript(tmpDir, true); // passing script/test

      const result = invokeHook("prove_it_test.js", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "ship it"' },
        cwd: tmpDir,
      }, { projectDir: tmpDir, env: isolatedEnv() });

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output, "Hook should produce JSON output");

      // Command should NOT be modified — tests ran at hook time
      const output = result.output.hookSpecificOutput;
      assert.ok(!output.updatedInput,
        "Command must not be modified when tests pass");
      assert.ok(output.permissionDecisionReason.includes("tests passed"),
        "Reason should confirm tests passed");
    });

    it("blocks commit when code reviewer fails (after tests pass)", () => {
      createTestScript(tmpDir, true); // passing script/test

      // Reviewer mock that always FAILs
      createFile(tmpDir, ".claude/prove_it.json", JSON.stringify({
        hooks: {
          done: {
            reviewer: {
              enabled: true,
              command: "echo 'FAIL: dead code detected in new function'",
            },
          },
        },
      }));

      // Stage changes so git diff --cached produces output
      createFile(tmpDir, "src/app.js", "function app() {}\nfunction unused() {}\n");
      spawnSync("git", ["add", "src/app.js"], { cwd: tmpDir });

      const result = invokeHook("prove_it_test.js", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "add app"' },
        cwd: tmpDir,
      }, { projectDir: tmpDir, env: isolatedEnv() });

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output, "Hook should produce JSON output");

      const cmd = result.output.hookSpecificOutput.updatedInput.command;
      assert.ok(cmd.includes("exit 1"),
        "Command must be replaced with exit 1 when reviewer fails");
      assert.ok(!cmd.includes("git commit"),
        "Original git commit must NOT appear — reviewer blocked it");

      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes("FAIL"),
        "Reason should mention reviewer failure"
      );
    });
  });
});
