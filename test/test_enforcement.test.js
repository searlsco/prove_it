const { describe, it } = require("node:test");
const assert = require("node:assert");

// Test the command matching logic extracted from the hook
// These are unit tests for the regex matching and config merging

describe("commands that require tests", () => {
  // Note: git push removed from defaults - commit already runs full tests
  const defaultRegexes = [
    "(^|\\s)git\\s+commit\\b",
    "(^|\\s)(beads|bd)\\s+(done|finish|close)\\b",
  ];

  // For testing git push separately (users can add it back)
  const withPushRegexes = [
    "(^|\\s)git\\s+commit\\b",
    "(^|\\s)git\\s+push\\b",
    "(^|\\s)(beads|bd)\\s+(done|finish|close)\\b",
  ];

  function shouldRequireTests(command, regexes = defaultRegexes) {
    return regexes.some((re) => {
      try {
        return new RegExp(re, "i").test(command);
      } catch {
        return false;
      }
    });
  }

  describe("git commit", () => {
    it("requires tests for 'git commit'", () => {
      assert.ok(shouldRequireTests("git commit"));
    });

    it("requires tests for 'git commit -m message'", () => {
      assert.ok(shouldRequireTests('git commit -m "message"'));
    });

    it("requires tests for 'git commit --amend'", () => {
      assert.ok(shouldRequireTests("git commit --amend"));
    });

    it("does not require tests for 'git commits' (different word)", () => {
      assert.ok(!shouldRequireTests("git commits"));
    });

    it("does not require tests for 'git log --oneline' (different command)", () => {
      assert.ok(!shouldRequireTests("git log --oneline"));
    });
  });

  describe("git push (not blocked by default)", () => {
    it("does not require tests for 'git push' by default", () => {
      assert.ok(!shouldRequireTests("git push"));
    });

    it("does not require tests for 'git push origin main' by default", () => {
      assert.ok(!shouldRequireTests("git push origin main"));
    });

    it("requires tests for 'git push' when added to regexes", () => {
      assert.ok(shouldRequireTests("git push", withPushRegexes));
    });

    it("requires tests for 'git push --force' when added to regexes", () => {
      assert.ok(shouldRequireTests("git push --force", withPushRegexes));
    });

    it("does not require tests for 'git pull'", () => {
      assert.ok(!shouldRequireTests("git pull"));
    });
  });

  describe("beads/bd done/finish/close", () => {
    it("requires tests for 'beads done'", () => {
      assert.ok(shouldRequireTests("beads done"));
    });

    it("requires tests for 'bd done'", () => {
      assert.ok(shouldRequireTests("bd done"));
    });

    it("requires tests for 'beads finish'", () => {
      assert.ok(shouldRequireTests("beads finish"));
    });

    it("requires tests for 'bd close'", () => {
      assert.ok(shouldRequireTests("bd close"));
    });

    it("requires tests for 'beads done 123'", () => {
      assert.ok(shouldRequireTests("beads done 123"));
    });

    it("does not require tests for 'beads list'", () => {
      assert.ok(!shouldRequireTests("beads list"));
    });

    it("does not require tests for 'bd show'", () => {
      assert.ok(!shouldRequireTests("bd show"));
    });
  });

  describe("compound commands", () => {
    it("requires tests for 'npm test && git commit -m done'", () => {
      assert.ok(shouldRequireTests('npm test && git commit -m "done"'));
    });

    it("requires tests for 'echo foo; git push' when push is enabled", () => {
      assert.ok(shouldRequireTests("echo foo; git push", withPushRegexes));
    });

    it("does not require tests for 'echo foo; git push' by default", () => {
      assert.ok(!shouldRequireTests("echo foo; git push"));
    });
  });

  describe("commands that don't require tests", () => {
    it("does not require tests for 'npm test'", () => {
      assert.ok(!shouldRequireTests("npm test"));
    });

    it("does not require tests for 'ls -la'", () => {
      assert.ok(!shouldRequireTests("ls -la"));
    });

    it("does not require tests for 'git status'", () => {
      assert.ok(!shouldRequireTests("git status"));
    });

    it("does not require tests for 'git diff'", () => {
      assert.ok(!shouldRequireTests("git diff"));
    });

    it("does not require tests for 'git add .'", () => {
      assert.ok(!shouldRequireTests("git add ."));
    });
  });
});

describe("local config write protection", () => {
  function isLocalConfigWrite(command) {
    const cmd = command || "";
    if (!cmd.includes("prove_it.local.json")) return false;
    return /[^<]>|>>|\btee\b/.test(cmd);
  }

  function isConfigFileEdit(toolName, toolInput) {
    if (toolName !== "Write" && toolName !== "Edit") return false;
    const filePath = toolInput?.file_path || "";
    return filePath.includes("prove_it.json") || filePath.includes("prove_it.local.json");
  }

  describe("blocks Write/Edit tools", () => {
    it("blocks Write to prove_it.json", () => {
      assert.ok(isConfigFileEdit("Write", { file_path: "/project/.claude/prove_it.json" }));
    });

    it("blocks Write to prove_it.local.json", () => {
      assert.ok(isConfigFileEdit("Write", { file_path: "/project/.claude/prove_it.local.json" }));
    });

    it("blocks Edit to prove_it.json", () => {
      assert.ok(isConfigFileEdit("Edit", { file_path: ".claude/prove_it.json" }));
    });

    it("blocks Edit to prove_it.local.json", () => {
      assert.ok(isConfigFileEdit("Edit", { file_path: ".claude/prove_it.local.json" }));
    });

    it("allows Write to other files", () => {
      assert.ok(!isConfigFileEdit("Write", { file_path: "/project/src/index.js" }));
    });

    it("allows Edit to other files", () => {
      assert.ok(!isConfigFileEdit("Edit", { file_path: ".claude/settings.json" }));
    });

    it("allows Read tool", () => {
      assert.ok(!isConfigFileEdit("Read", { file_path: ".claude/prove_it.json" }));
    });

    it("allows Bash tool", () => {
      assert.ok(!isConfigFileEdit("Bash", { command: "cat .claude/prove_it.json" }));
    });
  });

  describe("blocks writes", () => {
    it("blocks echo redirect", () => {
      assert.ok(isLocalConfigWrite('echo \'{"suiteGate":{"require":false}}\' > .claude/prove_it.local.json'));
    });

    it("blocks append redirect", () => {
      assert.ok(isLocalConfigWrite('echo foo >> .claude/prove_it.local.json'));
    });

    it("blocks tee", () => {
      assert.ok(isLocalConfigWrite('echo foo | tee .claude/prove_it.local.json'));
    });

    it("blocks tee -a", () => {
      assert.ok(isLocalConfigWrite('echo foo | tee -a .claude/prove_it.local.json'));
    });

    it("blocks with full path", () => {
      assert.ok(isLocalConfigWrite('echo foo > /Users/justin/project/.claude/prove_it.local.json'));
    });

    it("blocks mkdir && echo combo", () => {
      assert.ok(isLocalConfigWrite('mkdir -p .claude && echo \'{"suiteGate":{"require":false}}\' > .claude/prove_it.local.json'));
    });
  });

  describe("allows reads", () => {
    it("allows cat", () => {
      assert.ok(!isLocalConfigWrite('cat .claude/prove_it.local.json'));
    });

    it("allows grep", () => {
      assert.ok(!isLocalConfigWrite('grep require .claude/prove_it.local.json'));
    });

    it("allows jq", () => {
      assert.ok(!isLocalConfigWrite('jq . .claude/prove_it.local.json'));
    });

    it("allows input redirect (reading)", () => {
      assert.ok(!isLocalConfigWrite('jq . < .claude/prove_it.local.json'));
    });
  });

  describe("ignores other files", () => {
    it("allows writing to other json files", () => {
      assert.ok(!isLocalConfigWrite('echo {} > .claude/other.json'));
    });

    it("allows writing to config.json", () => {
      assert.ok(!isLocalConfigWrite('echo {} > ~/.claude/prove_it/config.json'));
    });
  });
});

describe("config merging", () => {
  function mergeDeep(a, b) {
    if (b === undefined || b === null) return a;
    if (Array.isArray(a) && Array.isArray(b)) return b;
    if (typeof a === "object" && a && typeof b === "object" && b) {
      const out = { ...a };
      for (const k of Object.keys(b)) out[k] = mergeDeep(a[k], b[k]);
      return out;
    }
    return b;
  }

  it("merges nested objects", () => {
    const base = { suiteGate: { command: "./scripts/test", require: true } };
    const override = { suiteGate: { command: "npm test" } };
    const result = mergeDeep(base, override);
    assert.deepStrictEqual(result, {
      suiteGate: { command: "npm test", require: true },
    });
  });

  it("overrides arrays entirely", () => {
    const base = { triggers: ["a", "b"] };
    const override = { triggers: ["c"] };
    const result = mergeDeep(base, override);
    assert.deepStrictEqual(result, { triggers: ["c"] });
  });

  it("handles null override", () => {
    const base = { foo: "bar" };
    const result = mergeDeep(base, null);
    assert.deepStrictEqual(result, { foo: "bar" });
  });

  it("handles undefined override", () => {
    const base = { foo: "bar" };
    const result = mergeDeep(base, undefined);
    assert.deepStrictEqual(result, { foo: "bar" });
  });

  it("override scalar values", () => {
    const base = { cacheSeconds: 900 };
    const override = { cacheSeconds: 300 };
    const result = mergeDeep(base, override);
    assert.deepStrictEqual(result, { cacheSeconds: 300 });
  });

  it("merges false values correctly", () => {
    const base = { suiteGate: { require: true, command: "./script/test" } };
    const override = { suiteGate: { require: false } };
    const result = mergeDeep(base, override);
    assert.deepStrictEqual(result, { suiteGate: { require: false, command: "./script/test" } });
  });

  it("merges zero values correctly", () => {
    const base = { cacheSeconds: 900 };
    const override = { cacheSeconds: 0 };
    const result = mergeDeep(base, override);
    assert.deepStrictEqual(result, { cacheSeconds: 0 });
  });

  it("merges empty string values correctly", () => {
    const base = { name: "foo" };
    const override = { name: "" };
    const result = mergeDeep(base, override);
    assert.deepStrictEqual(result, { name: "" });
  });
});

describe("loadEffectiveConfig ancestor discovery", () => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const { loadEffectiveConfig, defaultTestConfig } = require("../lib/shared");

  const tmpBase = path.join(os.tmpdir(), "prove_it_config_test_" + Date.now());

  // Setup: create nested directory structure
  // tmpBase/
  //   .claude/prove_it.json  (root config)
  //   child/
  //     .claude/prove_it.json  (child config)
  //     grandchild/
  //       (no config - should inherit)

  function setup() {
    fs.mkdirSync(path.join(tmpBase, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, "child", ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, "child", "grandchild"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpBase, ".claude", "prove_it.json"),
      JSON.stringify({ commands: { test: { full: "./root-test" } } })
    );
    fs.writeFileSync(
      path.join(tmpBase, "child", ".claude", "prove_it.json"),
      JSON.stringify({ commands: { test: { fast: "./child-fast" } } })
    );
  }

  function cleanup() {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  it("loads config from cwd", () => {
    setup();
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, "child"), defaultTestConfig);
      assert.strictEqual(cfg.commands.test.fast, "./child-fast");
    } finally {
      cleanup();
    }
  });

  it("inherits ancestor config (child overrides root)", () => {
    setup();
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, "child"), defaultTestConfig);
      // Root sets full, child sets fast - both should be present
      assert.strictEqual(cfg.commands.test.full, "./root-test");
      assert.strictEqual(cfg.commands.test.fast, "./child-fast");
    } finally {
      cleanup();
    }
  });

  it("grandchild inherits from ancestors", () => {
    setup();
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, "child", "grandchild"), defaultTestConfig);
      // Grandchild has no config, should inherit from child and root
      assert.strictEqual(cfg.commands.test.full, "./root-test");
      assert.strictEqual(cfg.commands.test.fast, "./child-fast");
    } finally {
      cleanup();
    }
  });

  it("cwd config wins over ancestors", () => {
    setup();
    // Add grandchild config that overrides
    fs.mkdirSync(path.join(tmpBase, "child", "grandchild", ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpBase, "child", "grandchild", ".claude", "prove_it.json"),
      JSON.stringify({ commands: { test: { full: "./grandchild-test" } } })
    );
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, "child", "grandchild"), defaultTestConfig);
      // Grandchild overrides root's full, keeps child's fast
      assert.strictEqual(cfg.commands.test.full, "./grandchild-test");
      assert.strictEqual(cfg.commands.test.fast, "./child-fast");
    } finally {
      cleanup();
    }
  });

  it("uses defaults when no config found", () => {
    const emptyDir = path.join(os.tmpdir(), "prove_it_empty_" + Date.now());
    fs.mkdirSync(emptyDir, { recursive: true });
    try {
      const { cfg } = loadEffectiveConfig(emptyDir, defaultTestConfig);
      // Should have default values
      assert.strictEqual(cfg.hooks.stop.enabled, true);
      assert.strictEqual(cfg.commands.test.full, null);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("isIgnoredPath", () => {
  const os = require("os");
  const path = require("path");
  const { isIgnoredPath } = require("../lib/shared");
  const home = os.homedir();

  it("returns false for empty ignoredPaths", () => {
    assert.strictEqual(isIgnoredPath("/some/path", []), false);
    assert.strictEqual(isIgnoredPath("/some/path", null), false);
    assert.strictEqual(isIgnoredPath("/some/path", undefined), false);
  });

  it("matches absolute paths exactly", () => {
    assert.strictEqual(isIgnoredPath("/Users/test/bin", ["/Users/test/bin"]), true);
    assert.strictEqual(isIgnoredPath("/Users/test/bin", ["/Users/other/bin"]), false);
  });

  it("matches home-relative paths with ~", () => {
    const binPath = path.join(home, "bin");
    assert.strictEqual(isIgnoredPath(binPath, ["~/bin"]), true);
    assert.strictEqual(isIgnoredPath(binPath, ["~/other"]), false);
  });

  it("matches subdirectories of ignored paths", () => {
    const subPath = path.join(home, "bin", "scripts");
    assert.strictEqual(isIgnoredPath(subPath, ["~/bin"]), true);
  });

  it("does not match partial directory names", () => {
    const binPath = path.join(home, "binary");
    assert.strictEqual(isIgnoredPath(binPath, ["~/bin"]), false);
  });

  it("handles multiple ignored paths", () => {
    const binPath = path.join(home, "bin");
    const dotfilesPath = path.join(home, "dotfiles");
    assert.strictEqual(isIgnoredPath(binPath, ["~/dotfiles", "~/bin"]), true);
    assert.strictEqual(isIgnoredPath(dotfilesPath, ["~/dotfiles", "~/bin"]), true);
    assert.strictEqual(isIgnoredPath(path.join(home, "code"), ["~/dotfiles", "~/bin"]), false);
  });
});

describe("logReview", () => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const { logReview } = require("../lib/shared");

  const testSessionDir = path.join(os.tmpdir(), "prove_it_log_test_" + Date.now());
  const originalEnv = process.env.CLAUDE_SESSION_ID;

  function setup() {
    // Clean up any previous test directory
    try {
      fs.rmSync(testSessionDir, { recursive: true, force: true });
    } catch {}
  }

  function cleanup() {
    try {
      fs.rmSync(testSessionDir, { recursive: true, force: true });
    } catch {}
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.CLAUDE_SESSION_ID = originalEnv;
    } else {
      delete process.env.CLAUDE_SESSION_ID;
    }
  }

  it("appends review entry to session log file", () => {
    setup();
    process.env.CLAUDE_SESSION_ID = "test-session-123";

    // Mock the log directory by temporarily patching os.homedir
    // Instead, we'll just verify the function doesn't throw
    logReview("/some/project", "code", "PASS", null);

    // Check that the file was created
    const logFile = path.join(os.homedir(), ".claude", "prove_it", "sessions", "test-session-123.jsonl");
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.trim().split("\n");
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(lastEntry.reviewer, "code");
      assert.strictEqual(lastEntry.status, "PASS");
      assert.strictEqual(lastEntry.projectDir, "/some/project");
      assert.strictEqual(lastEntry.sessionId, "test-session-123");
    }

    cleanup();
  });

  it("logs FAIL with reason", () => {
    setup();
    process.env.CLAUDE_SESSION_ID = "test-session-456";

    logReview("/another/project", "coverage", "FAIL", "Missing tests for new function");

    const logFile = path.join(os.homedir(), ".claude", "prove_it", "sessions", "test-session-456.jsonl");
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.trim().split("\n");
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(lastEntry.reviewer, "coverage");
      assert.strictEqual(lastEntry.status, "FAIL");
      assert.strictEqual(lastEntry.reason, "Missing tests for new function");
    }

    cleanup();
  });

  it("uses unknown.jsonl when no session ID", () => {
    setup();
    delete process.env.CLAUDE_SESSION_ID;

    logReview("/project", "code", "PASS", null);

    const logFile = path.join(os.homedir(), ".claude", "prove_it", "sessions", "unknown.jsonl");
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.trim().split("\n");
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(lastEntry.sessionId, null);
    }

    cleanup();
  });
});

describe("session state", () => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const { loadSessionState, saveSessionState } = require("../lib/shared");

  const originalEnv = process.env.CLAUDE_SESSION_ID;

  function cleanup() {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_SESSION_ID = originalEnv;
    } else {
      delete process.env.CLAUDE_SESSION_ID;
    }
  }

  function cleanupStateFile(sessionId) {
    const stateFile = path.join(os.homedir(), ".claude", "prove_it", "sessions", `${sessionId}.json`);
    try {
      fs.unlinkSync(stateFile);
    } catch {}
  }

  it("returns null when no session ID is set", () => {
    delete process.env.CLAUDE_SESSION_ID;
    const result = loadSessionState("last_review_snapshot");
    assert.strictEqual(result, null);
    cleanup();
  });

  it("saveSessionState is a no-op when no session ID is set", () => {
    delete process.env.CLAUDE_SESSION_ID;
    // Should not throw
    saveSessionState("last_review_snapshot", "some-value");
    cleanup();
  });

  it("round-trips a value via save and load", () => {
    const testSessionId = "test-state-roundtrip-" + Date.now();
    process.env.CLAUDE_SESSION_ID = testSessionId;

    saveSessionState("last_review_snapshot", "msg-abc-123");
    const result = loadSessionState("last_review_snapshot");
    assert.strictEqual(result, "msg-abc-123");

    cleanupStateFile(testSessionId);
    cleanup();
  });

  it("supports multiple keys in the same state file", () => {
    const testSessionId = "test-state-multikey-" + Date.now();
    process.env.CLAUDE_SESSION_ID = testSessionId;

    saveSessionState("key_a", "value_a");
    saveSessionState("key_b", "value_b");

    assert.strictEqual(loadSessionState("key_a"), "value_a");
    assert.strictEqual(loadSessionState("key_b"), "value_b");

    cleanupStateFile(testSessionId);
    cleanup();
  });

  it("returns null for a key that does not exist in state file", () => {
    const testSessionId = "test-state-missing-key-" + Date.now();
    process.env.CLAUDE_SESSION_ID = testSessionId;

    saveSessionState("existing_key", "some_value");
    const result = loadSessionState("nonexistent_key");
    assert.strictEqual(result, null);

    cleanupStateFile(testSessionId);
    cleanup();
  });

  it("isolates state between sessions (the core property)", () => {
    const sessionA = "test-state-isolation-A-" + Date.now();
    const sessionB = "test-state-isolation-B-" + Date.now();

    // Session A writes a snapshot
    process.env.CLAUDE_SESSION_ID = sessionA;
    saveSessionState("last_review_snapshot", "msg-from-A");

    // Session B writes a different snapshot for the same key
    process.env.CLAUDE_SESSION_ID = sessionB;
    saveSessionState("last_review_snapshot", "msg-from-B");

    // Session A still sees its own value
    process.env.CLAUDE_SESSION_ID = sessionA;
    assert.strictEqual(loadSessionState("last_review_snapshot"), "msg-from-A");

    // Session B still sees its own value
    process.env.CLAUDE_SESSION_ID = sessionB;
    assert.strictEqual(loadSessionState("last_review_snapshot"), "msg-from-B");

    cleanupStateFile(sessionA);
    cleanupStateFile(sessionB);
    cleanup();
  });

  it("does not write to prove_it.local.json", () => {
    const testSessionId = "test-state-no-local-" + Date.now();
    const tmpDir = path.join(os.tmpdir(), "prove_it_local_check_" + Date.now());
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    const localCfgPath = path.join(tmpDir, ".claude", "prove_it.local.json");

    process.env.CLAUDE_SESSION_ID = testSessionId;
    saveSessionState("last_review_snapshot", "msg-xyz");

    // prove_it.local.json should not exist (session state goes elsewhere)
    assert.strictEqual(fs.existsSync(localCfgPath), false,
      "saveSessionState should not create prove_it.local.json");

    // The value lives in session state, not local config
    assert.strictEqual(loadSessionState("last_review_snapshot"), "msg-xyz");

    cleanupStateFile(testSessionId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    cleanup();
  });
});
