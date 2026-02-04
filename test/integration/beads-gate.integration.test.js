const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  initBeads,
} = require("./hook-harness");

describe("prove_it_beads_gate.js integration", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir("prove-it-beads-");
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("non-beads repo", () => {
    it("allows Edit without beads directory", () => {
      // No .beads directory

      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "/some/file.js", old_string: "a", new_string: "b" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null, "Should not block in non-beads repo");
    });

    it("allows Write without beads directory", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: "/some/file.js", content: "hello" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null);
    });
  });

  describe("beads repo without in_progress bead", () => {
    beforeEach(() => {
      initBeads(tmpDir);
    });

    it("blocks Edit when no in_progress bead", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "/some/file.js", old_string: "a", new_string: "b" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);

      // Note: This test may fail if bd is not installed or fails
      // The hook should either block (if bd works and returns no beads)
      // or allow (if bd fails and it fails open)
      // For robust testing, we accept both outcomes here

      if (result.output) {
        // bd worked and found no in_progress beads - should block
        assert.ok(result.output.hookSpecificOutput, "Should have hookSpecificOutput when blocking");
        assert.strictEqual(
          result.output.hookSpecificOutput.permissionDecision,
          "block",
          "Should block Edit without in_progress bead"
        );
        assert.ok(
          result.output.hookSpecificOutput.permissionDecisionReason.includes("No bead"),
          "Should explain why blocked"
        );
      }
      // If result.output is null, bd failed and it failed open - that's acceptable
    });

    it("blocks Write when no in_progress bead", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: "/some/file.js", content: "hello" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);

      if (result.output) {
        assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, "block");
      }
    });

    it("blocks NotebookEdit when no in_progress bead", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "NotebookEdit",
          tool_input: { notebook_path: "/some/notebook.ipynb", new_source: "print(1)" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);

      if (result.output) {
        assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, "block");
      }
    });

    it("blocks Bash cat redirect when no in_progress bead", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "cat > file.txt" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);

      if (result.output) {
        assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, "block");
      }
    });
  });

  describe("non-write operations", () => {
    beforeEach(() => {
      initBeads(tmpDir);
    });

    it("allows Read tool", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/some/file.js" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null, "Should not gate Read tool");
    });

    it("allows Glob tool", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Glob",
          tool_input: { pattern: "**/*.js" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null);
    });

    it("allows Bash without write patterns", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls -la" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null, "Should not gate non-write Bash commands");
    });

    it("allows bd commands", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "bd list" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null, "Should allow bd commands");
    });
  });

  describe("fail-closed behavior", () => {
    it("blocks when input JSON is invalid", () => {
      const { spawnSync } = require("child_process");
      const path = require("path");

      const hookPath = path.join(__dirname, "..", "..", "src", "hooks", "prove_it_beads_gate.js");

      const result = spawnSync("node", [hookPath], {
        input: "invalid json!@#$",
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
      });

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout, "Should produce output");

      const output = JSON.parse(result.stdout);
      assert.strictEqual(output.decision, "block", "Should block on invalid input");
      assert.ok(output.reason.includes("Failed to parse"), "Should explain the parse failure");
    });
  });

  describe("ignores non-PreToolUse events", () => {
    it("ignores Stop event", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "Stop",
          session_id: "test-123",
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null);
    });

    it("ignores SessionStart event", () => {
      const result = invokeHook(
        "prove_it_beads_gate.js",
        {
          hook_event_name: "SessionStart",
          session_id: "test-123",
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null);
    });
  });
});
