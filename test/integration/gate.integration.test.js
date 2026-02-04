const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createSuiteGate,
} = require("./hook-harness");

describe("prove_it_gate.js integration", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir("prove-it-gate-");
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("PreToolUse event", () => {
    describe("gated commands", () => {
      it("wraps git commit with suite gate", () => {
        createSuiteGate(tmpDir, true);

        const result = invokeHook(
          "prove_it_gate.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: 'git commit -m "test"' },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.ok(result.output, "Should produce JSON output");
        assert.ok(result.output.hookSpecificOutput, "Should have hookSpecificOutput");
        assert.ok(
          result.output.hookSpecificOutput.updatedInput.command.includes("./script/test"),
          "Command should include suite gate"
        );
        assert.ok(
          result.output.hookSpecificOutput.updatedInput.command.includes("git commit"),
          "Command should include original command"
        );
      });

      it("does not gate git push by default", () => {
        // git push is no longer gated by default - commit already runs full gate
        const result = invokeHook(
          "prove_it_gate.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "git push origin main" },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.output, null, "Should not gate git push");
      });

      it("wraps bd done with suite gate", () => {
        createSuiteGate(tmpDir, true);

        const result = invokeHook(
          "prove_it_gate.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "bd done 123" },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.ok(result.output?.hookSpecificOutput?.updatedInput?.command.includes("./script/test"));
      });
    });

    describe("non-gated commands", () => {
      it("ignores git status", () => {
        const result = invokeHook(
          "prove_it_gate.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "git status" },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.output, null, "Should not produce output for non-gated commands");
      });

      it("ignores npm test", () => {
        const result = invokeHook(
          "prove_it_gate.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "npm test" },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.output, null);
      });

      it("ignores non-Bash tools", () => {
        const result = invokeHook(
          "prove_it_gate.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            tool_input: { file_path: "/some/file.js" },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.output, null);
      });
    });

    describe("suite gate missing", () => {
      it("blocks with helpful error when suite gate required but missing", () => {
        // Don't create suite gate

        const result = invokeHook(
          "prove_it_gate.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: 'git commit -m "test"' },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.ok(result.output, "Should produce output");
        assert.ok(result.output.hookSpecificOutput, "Should have hookSpecificOutput");
        // Should replace command with error message
        assert.ok(
          result.output.hookSpecificOutput.updatedInput.command.includes("exit 1"),
          "Should replace with failing command"
        );
      });
    });
  });

  describe("fail-closed behavior", () => {
    it("blocks when input JSON is invalid", () => {
      // This tests the fail-closed behavior - invalid input should block, not silently pass
      const { spawnSync } = require("child_process");
      const path = require("path");

      const hookPath = path.join(__dirname, "..", "..", "global", "hooks", "prove_it_gate.js");

      const result = spawnSync("node", [hookPath], {
        input: "not valid json {{{",
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

  describe("local config write protection", () => {
    it("blocks writes to prove_it.local.json", () => {
      const result = invokeHook(
        "prove_it_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'echo \'{"suiteGate":{"require":false}}\' > .claude/prove_it.local.json' },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output, "Should produce output");
      assert.ok(result.output.hookSpecificOutput, "Should have hookSpecificOutput");
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        "deny",
        "Should deny the command"
      );
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes("prove_it"),
        "Should mention the protected file pattern"
      );
    });

    it("allows reading prove_it.local.json", () => {
      const result = invokeHook(
        "prove_it_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "cat .claude/prove_it.local.json" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, null, "Should not block read operations");
    });
  });

  describe("shell escaping", () => {
    it("safely handles paths with special characters", () => {
      // Create a directory with special characters
      const fs = require("fs");
      const path = require("path");
      const specialDir = path.join(tmpDir, "path with 'quotes' and spaces");
      fs.mkdirSync(specialDir, { recursive: true });
      initGitRepo(specialDir);
      createSuiteGate(specialDir, true);

      const result = invokeHook(
        "prove_it_gate.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'git commit -m "test"' },
          cwd: specialDir,
        },
        { projectDir: specialDir }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output, "Should produce output");
      // The command should be properly escaped
      const cmd = result.output.hookSpecificOutput.updatedInput.command;
      assert.ok(cmd.includes("'"), "Should use single-quote escaping");
    });
  });
});
