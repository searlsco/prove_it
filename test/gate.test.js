const { describe, it } = require("node:test");
const assert = require("node:assert");

// Test the gating logic extracted from the hook
// These are unit tests for the regex matching and config merging

describe("command gating regexes", () => {
  // Note: git push removed from defaults - commit already runs full gate
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

  function shouldGate(command, regexes = defaultRegexes) {
    return regexes.some((re) => {
      try {
        return new RegExp(re, "i").test(command);
      } catch {
        return false;
      }
    });
  }

  describe("git commit", () => {
    it("gates 'git commit'", () => {
      assert.ok(shouldGate("git commit"));
    });

    it("gates 'git commit -m message'", () => {
      assert.ok(shouldGate('git commit -m "message"'));
    });

    it("gates 'git commit --amend'", () => {
      assert.ok(shouldGate("git commit --amend"));
    });

    it("does not gate 'git commits' (different word)", () => {
      assert.ok(!shouldGate("git commits"));
    });

    it("does not gate 'git log --oneline' (different command)", () => {
      assert.ok(!shouldGate("git log --oneline"));
    });
  });

  describe("git push (not gated by default)", () => {
    it("does not gate 'git push' by default", () => {
      assert.ok(!shouldGate("git push"));
    });

    it("does not gate 'git push origin main' by default", () => {
      assert.ok(!shouldGate("git push origin main"));
    });

    it("gates 'git push' when added to regexes", () => {
      assert.ok(shouldGate("git push", withPushRegexes));
    });

    it("gates 'git push --force' when added to regexes", () => {
      assert.ok(shouldGate("git push --force", withPushRegexes));
    });

    it("does not gate 'git pull'", () => {
      assert.ok(!shouldGate("git pull"));
    });
  });

  describe("beads/bd done/finish/close", () => {
    it("gates 'beads done'", () => {
      assert.ok(shouldGate("beads done"));
    });

    it("gates 'bd done'", () => {
      assert.ok(shouldGate("bd done"));
    });

    it("gates 'beads finish'", () => {
      assert.ok(shouldGate("beads finish"));
    });

    it("gates 'bd close'", () => {
      assert.ok(shouldGate("bd close"));
    });

    it("gates 'beads done 123'", () => {
      assert.ok(shouldGate("beads done 123"));
    });

    it("does not gate 'beads list'", () => {
      assert.ok(!shouldGate("beads list"));
    });

    it("does not gate 'bd show'", () => {
      assert.ok(!shouldGate("bd show"));
    });
  });

  describe("compound commands", () => {
    it("gates 'npm test && git commit -m done'", () => {
      assert.ok(shouldGate('npm test && git commit -m "done"'));
    });

    it("gates 'echo foo; git push' when push is gated", () => {
      assert.ok(shouldGate("echo foo; git push", withPushRegexes));
    });

    it("does not gate 'echo foo; git push' by default", () => {
      assert.ok(!shouldGate("echo foo; git push"));
    });
  });

  describe("non-gated commands", () => {
    it("does not gate 'npm test'", () => {
      assert.ok(!shouldGate("npm test"));
    });

    it("does not gate 'ls -la'", () => {
      assert.ok(!shouldGate("ls -la"));
    });

    it("does not gate 'git status'", () => {
      assert.ok(!shouldGate("git status"));
    });

    it("does not gate 'git diff'", () => {
      assert.ok(!shouldGate("git diff"));
    });

    it("does not gate 'git add .'", () => {
      assert.ok(!shouldGate("git add ."));
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
    const base = { gatedCommandRegexes: ["a", "b"] };
    const override = { gatedCommandRegexes: ["c"] };
    const result = mergeDeep(base, override);
    assert.deepStrictEqual(result, { gatedCommandRegexes: ["c"] });
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
