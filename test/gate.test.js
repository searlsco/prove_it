const { describe, it } = require("node:test");
const assert = require("node:assert");

// Test the gating logic extracted from the hook
// These are unit tests for the regex matching and config merging

describe("command gating regexes", () => {
  const defaultRegexes = [
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

  describe("git push", () => {
    it("gates 'git push'", () => {
      assert.ok(shouldGate("git push"));
    });

    it("gates 'git push origin main'", () => {
      assert.ok(shouldGate("git push origin main"));
    });

    it("gates 'git push --force'", () => {
      assert.ok(shouldGate("git push --force"));
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

    it("gates 'echo foo; git push'", () => {
      assert.ok(shouldGate("echo foo; git push"));
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

describe("config merging", () => {
  function mergeDeep(a, b) {
    if (!b) return a;
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
});
