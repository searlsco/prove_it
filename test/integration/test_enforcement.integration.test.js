const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createSuiteGate,
} = require("./hook-harness");

describe("prove_it_test.js integration", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir("prove_it_test_");
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("PreToolUse event", () => {
    describe("commands that require tests", () => {
      it("wraps git commit with test script", () => {
        createSuiteGate(tmpDir, true);

        const result = invokeHook(
          "prove_it_test.js",
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
          "Command should include test script"
        );
        assert.ok(
          result.output.hookSpecificOutput.updatedInput.command.includes("git commit"),
          "Command should include original command"
        );
      });

      it("does not require tests for git push by default", () => {
        // git push is no longer blocked by default - commit already runs full tests
        const result = invokeHook(
          "prove_it_test.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "git push origin main" },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.output, null, "Should not require tests for git push");
      });

      it("wraps bd done with test script", () => {
        createSuiteGate(tmpDir, true);

        const result = invokeHook(
          "prove_it_test.js",
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

    describe("commands that don't require tests", () => {
      it("ignores git status", () => {
        const result = invokeHook(
          "prove_it_test.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "git status" },
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.output, null, "Should not produce output for commands that don't require tests");
      });

      it("ignores npm test", () => {
        const result = invokeHook(
          "prove_it_test.js",
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
          "prove_it_test.js",
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

    describe("test script missing", () => {
      it("blocks with helpful error when test script required but missing", () => {
        // Don't create test script

        const result = invokeHook(
          "prove_it_test.js",
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

      const hookPath = path.join(__dirname, "..", "..", "lib", "hooks", "prove_it_test.js");

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
        "prove_it_test.js",
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
        "prove_it_test.js",
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
        "prove_it_test.js",
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

  describe("test root resolution", () => {
    const fs = require("fs");
    const path = require("path");

    it("finds script/test in cwd first", () => {
      createSuiteGate(tmpDir, true);
      const subDir = path.join(tmpDir, "subdir");
      fs.mkdirSync(subDir, { recursive: true });
      createSuiteGate(subDir, true); // subdir has its own script/test

      const result = invokeHook(
        "prove_it_test.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'git commit -m "test"' },
          cwd: subDir,
        },
        { projectDir: subDir }
      );

      assert.strictEqual(result.exitCode, 0);
      const cmd = result.output.hookSpecificOutput.updatedInput.command;
      // Should run from subdir, not parent
      assert.ok(cmd.includes(subDir), "Should run tests from cwd with script/test");
    });

    it("walks up to find script/test in parent", () => {
      createSuiteGate(tmpDir, true); // only root has script/test
      const subDir = path.join(tmpDir, "subdir");
      fs.mkdirSync(subDir, { recursive: true });
      // subdir has no script/test

      const result = invokeHook(
        "prove_it_test.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'git commit -m "test"' },
          cwd: subDir,
        },
        { projectDir: subDir }
      );

      assert.strictEqual(result.exitCode, 0);
      const cmd = result.output.hookSpecificOutput.updatedInput.command;
      // Should run from root where script/test exists
      assert.ok(cmd.includes(tmpDir), "Should find script/test in parent");
    });

    it("stops at .claude/prove_it.json marker even without script/test", () => {
      createSuiteGate(tmpDir, true); // root has script/test
      const subDir = path.join(tmpDir, "subproject");
      fs.mkdirSync(path.join(subDir, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(subDir, ".claude", "prove_it.json"),
        JSON.stringify({ enabled: true })
      );
      // subDir has prove_it.json but no script/test

      const result = invokeHook(
        "prove_it_test.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'git commit -m "test"' },
          cwd: subDir,
        },
        { projectDir: subDir }
      );

      assert.strictEqual(result.exitCode, 0);
      // Should stop at subDir (has prove_it.json) and report missing script/test
      assert.ok(
        result.output.hookSpecificOutput.updatedInput.command.includes("exit 1"),
        "Should report test script missing in subproject"
      );
    });

    it("does not walk above git root", () => {
      // Create a nested git repo
      const innerRepo = path.join(tmpDir, "inner");
      fs.mkdirSync(innerRepo, { recursive: true });
      initGitRepo(innerRepo);
      createSuiteGate(tmpDir, true); // outer has script/test
      // inner repo has no script/test

      const result = invokeHook(
        "prove_it_test.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'git commit -m "test"' },
          cwd: innerRepo,
        },
        { projectDir: innerRepo }
      );

      assert.strictEqual(result.exitCode, 0);
      // Should not find outer script/test - stops at inner git root
      assert.ok(
        result.output.hookSpecificOutput.updatedInput.command.includes("exit 1"),
        "Should not inherit script/test from outside git root"
      );
    });
  });
});
