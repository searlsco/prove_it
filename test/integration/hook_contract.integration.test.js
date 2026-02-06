const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  initBeads,
  createTestScript,
  createFile,
  assertValidPermissionDecision,
  VALID_PERMISSION_DECISIONS,
  HOOKS_DIR,
} = require("./hook-harness");

/**
 * Contract tests: verify that all hook outputs conform to Claude Code's
 * expected schema. This prevents bugs like using "block" instead of "deny"
 * for permissionDecision — values Claude Code silently ignores.
 */
describe("Claude Code hook output contract", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir("prove_it_contract_");
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("prove_it_edit.js PreToolUse decisions", () => {
    beforeEach(() => {
      initBeads(tmpDir);
    });

    const gatedTools = [
      { tool: "Edit", input: { file_path: "/f.js", old_string: "a", new_string: "b" } },
      { tool: "Write", input: { file_path: "/f.js", content: "hello" } },
      { tool: "NotebookEdit", input: { notebook_path: "/n.ipynb", new_source: "x" } },
      { tool: "Bash", input: { command: "cat > file.txt" } },
    ];

    for (const { tool, input } of gatedTools) {
      it(`uses valid permissionDecision when denying ${tool}`, () => {
        const result = invokeHook(
          "prove_it_edit.js",
          {
            hook_event_name: "PreToolUse",
            tool_name: tool,
            tool_input: input,
            cwd: tmpDir,
          },
          { projectDir: tmpDir }
        );

        assertValidPermissionDecision(result, `edit/${tool}`);

        if (result.output?.hookSpecificOutput) {
          assert.strictEqual(
            result.output.hookSpecificOutput.permissionDecision,
            "deny",
            `Should deny ${tool} without in_progress bead`
          );
        }
      });
    }

    it("uses valid permissionDecision when denying config file Edit", () => {
      const result = invokeHook(
        "prove_it_edit.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: ".claude/prove_it.json", old_string: "a", new_string: "b" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assertValidPermissionDecision(result, "edit/config-edit");

      if (result.output?.hookSpecificOutput?.permissionDecision) {
        assert.strictEqual(
          result.output.hookSpecificOutput.permissionDecision,
          "deny"
        );
      }
    });

    it("uses valid permissionDecision when denying config file Write", () => {
      const result = invokeHook(
        "prove_it_edit.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: ".claude/prove_it.local.json", content: "{}" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assertValidPermissionDecision(result, "edit/config-write");

      if (result.output?.hookSpecificOutput?.permissionDecision) {
        assert.strictEqual(
          result.output.hookSpecificOutput.permissionDecision,
          "deny"
        );
      }
    });
  });

  describe("prove_it_done.js PreToolUse decisions", () => {
    it("uses valid permissionDecision when wrapping git commit", () => {
      createTestScript(tmpDir, true);

      const result = invokeHook(
        "prove_it_done.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'git commit -m "test"' },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assertValidPermissionDecision(result, "done/git-commit");
    });

    it("uses valid permissionDecision when test script is missing", () => {
      // No test script created

      const result = invokeHook(
        "prove_it_done.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'git commit -m "test"' },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assertValidPermissionDecision(result, "done/missing-script");
    });
  });

  describe("prove_it_edit.js config protection via Bash", () => {
    it("uses valid permissionDecision when denying config write via Bash", () => {
      const result = invokeHook(
        "prove_it_edit.js",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo '{}' > .claude/prove_it.local.json" },
          cwd: tmpDir,
        },
        { projectDir: tmpDir }
      );

      assertValidPermissionDecision(result, "edit/config-bash-write");

      if (result.output?.hookSpecificOutput?.permissionDecision) {
        assert.strictEqual(
          result.output.hookSpecificOutput.permissionDecision,
          "deny"
        );
      }
    });
  });

  describe("session_id passed as parameter via subprocess", () => {
    // session_id comes from hook JSON input and is passed directly to
    // session functions as a parameter. No env vars involved.

    it("session functions write to correct files when given session_id", () => {
      const probeScript = path.join(tmpDir, "session_probe.js");
      const proveItDir = path.join(tmpDir, "prove_it_state");
      const sharedPath = path.join(HOOKS_DIR, "..", "shared.js");

      createFile(tmpDir, "session_probe.js", [
        `const { saveSessionState, logReview } = require(${JSON.stringify(sharedPath)});`,
        `const input = JSON.parse(require("fs").readFileSync(0, "utf8"));`,
        `const sessionId = input.session_id || null;`,
        `saveSessionState(sessionId, "probe_key", "probe_value");`,
        `logReview(sessionId, "/test", "probe", "pass", "propagation test");`,
      ].join("\n"));

      const result = spawnSync("node", [probeScript], {
        input: JSON.stringify({ session_id: "test-session-xyz789" }),
        encoding: "utf8",
        env: { ...process.env, PROVE_IT_DIR: proveItDir },
      });

      assert.strictEqual(result.status, 0, `Probe script should exit 0: ${result.stderr}`);

      // Verify saveSessionState wrote the JSON file
      const stateFile = path.join(proveItDir, "sessions", "test-session-xyz789.json");
      assert.ok(fs.existsSync(stateFile), `State file should exist at ${stateFile}`);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.strictEqual(state.probe_key, "probe_value");

      // Verify logReview wrote the JSONL file
      const logFile = path.join(proveItDir, "sessions", "test-session-xyz789.jsonl");
      assert.ok(fs.existsSync(logFile), `Log file should exist at ${logFile}`);
      const entry = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
      assert.strictEqual(entry.reviewer, "probe");
      assert.strictEqual(entry.status, "pass");
      assert.strictEqual(entry.sessionId, "test-session-xyz789");
    });

    it("without session_id, state functions gracefully degrade", () => {
      const probeScript = path.join(tmpDir, "session_probe_no_id.js");
      const proveItDir = path.join(tmpDir, "prove_it_no_id");
      const sharedPath = path.join(HOOKS_DIR, "..", "shared.js");

      createFile(tmpDir, "session_probe_no_id.js", [
        `const { saveSessionState, loadSessionState, logReview } = require(${JSON.stringify(sharedPath)});`,
        `const input = JSON.parse(require("fs").readFileSync(0, "utf8"));`,
        `const sessionId = input.session_id || null;`,
        `saveSessionState(sessionId, "key", "value");`,
        `const result = loadSessionState(sessionId, "key");`,
        `logReview(sessionId, "/test", "probe", "pass", "no session");`,
        `process.stdout.write(JSON.stringify({ loadResult: result }));`,
      ].join("\n"));

      const result = spawnSync("node", [probeScript], {
        input: JSON.stringify({}), // no session_id
        encoding: "utf8",
        env: { ...process.env, PROVE_IT_DIR: proveItDir },
      });

      assert.strictEqual(result.status, 0, `Probe script should exit 0: ${result.stderr}`);

      // loadSessionState should have returned null
      const output = JSON.parse(result.stdout);
      assert.strictEqual(output.loadResult, null);

      // logReview falls back to unknown.jsonl
      const unknownLog = path.join(proveItDir, "sessions", "unknown.jsonl");
      assert.ok(fs.existsSync(unknownLog), "Should fall back to unknown.jsonl");
    });
  });

  describe("exhaustive: no hook emits invalid permissionDecision values", () => {
    it("rejects a hypothetical 'block' value", () => {
      assert.ok(
        !VALID_PERMISSION_DECISIONS.includes("block"),
        "'block' must not be in the valid set — Claude Code ignores it"
      );
    });

    it("rejects a hypothetical 'approve' value", () => {
      assert.ok(
        !VALID_PERMISSION_DECISIONS.includes("approve"),
        "'approve' must not be in the valid set — use 'allow' instead"
      );
    });
  });
});
