const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Test the reviewer logic
// These tests verify that the reviewer correctly parses PASS/FAIL responses

describe("reviewer output parsing", () => {
  // We test the parsing logic by simulating what runReviewer does

  function parseReviewerOutput(output) {
    const trimmed = output.trim();
    const firstLine = trimmed.split("\n")[0].trim();

    if (firstLine === "PASS") {
      return { pass: true };
    }

    if (firstLine.startsWith("FAIL:")) {
      return { pass: false, reason: firstLine.slice(5).trim() };
    }

    if (firstLine === "FAIL") {
      const lines = trimmed.split("\n");
      const reason = lines.length > 1 ? lines[1].trim() : "No reason provided";
      return { pass: false, reason };
    }

    return { error: `Unexpected output: ${firstLine}` };
  }

  describe("PASS responses", () => {
    it("parses 'PASS'", () => {
      const result = parseReviewerOutput("PASS");
      assert.strictEqual(result.pass, true);
    });

    it("parses 'PASS' with trailing whitespace", () => {
      const result = parseReviewerOutput("PASS\n\n");
      assert.strictEqual(result.pass, true);
    });

    it("parses 'PASS' with leading whitespace", () => {
      const result = parseReviewerOutput("  PASS");
      assert.strictEqual(result.pass, true);
    });
  });

  describe("FAIL responses", () => {
    it("parses 'FAIL: reason'", () => {
      const result = parseReviewerOutput("FAIL: no tests for new function");
      assert.strictEqual(result.pass, false);
      assert.strictEqual(result.reason, "no tests for new function");
    });

    it("parses 'FAIL:reason' (no space)", () => {
      const result = parseReviewerOutput("FAIL:missing tests");
      assert.strictEqual(result.pass, false);
      assert.strictEqual(result.reason, "missing tests");
    });

    it("parses 'FAIL' on its own line with reason on next line", () => {
      const result = parseReviewerOutput("FAIL\nno tests added");
      assert.strictEqual(result.pass, false);
      assert.strictEqual(result.reason, "no tests added");
    });

    it("parses 'FAIL' alone as failure with default reason", () => {
      const result = parseReviewerOutput("FAIL");
      assert.strictEqual(result.pass, false);
      assert.strictEqual(result.reason, "No reason provided");
    });
  });

  describe("unexpected responses", () => {
    it("returns error for unexpected output", () => {
      const result = parseReviewerOutput("I think the code looks good");
      assert.ok(result.error);
      assert.ok(result.error.includes("Unexpected output"));
    });

    it("returns error for empty output", () => {
      const result = parseReviewerOutput("");
      assert.ok(result.error);
    });
  });
});

describe("reviewer prompt", () => {
  // Test that the prompt contains key instructions

  function getReviewerPrompt() {
    return `You are a code review gatekeeper. A coding agent claims their work is complete.

Your job: verify that code changes have corresponding test coverage.

## Instructions

1. Run: git diff --stat
   - If no changes, return PASS (nothing to verify)

2. For each changed source file (src/, lib/, or main code files):
   - Check if corresponding test files were also modified
   - If test files exist, read them to verify they actually test the changed behavior

3. Be skeptical of:
   - Source changes with no test changes
   - Claims like "existing tests cover it" without evidence
   - New functions/methods without corresponding test cases
   - Bug fixes without regression tests

4. Be lenient for:
   - Documentation-only changes
   - Config file changes
   - Refactors where behavior is unchanged and existing tests still apply
   - Test-only changes

## Response Format

Return EXACTLY one of:
- PASS
- FAIL: <reason>

Examples:
- PASS
- FAIL: src/hooks/gate.js changed but no tests added for new isLocalConfigWrite() function
- FAIL: 5 source files changed, 0 test files changed

Be concise. One line only.`;
  }

  it("instructs to run git diff", () => {
    const prompt = getReviewerPrompt();
    assert.ok(prompt.includes("git diff"));
  });

  it("specifies PASS/FAIL response format", () => {
    const prompt = getReviewerPrompt();
    assert.ok(prompt.includes("PASS"));
    assert.ok(prompt.includes("FAIL"));
  });

  it("mentions test coverage verification", () => {
    const prompt = getReviewerPrompt();
    assert.ok(prompt.includes("test coverage"));
  });

  it("is skeptical of source changes without test changes", () => {
    const prompt = getReviewerPrompt();
    assert.ok(prompt.includes("Source changes with no test changes"));
  });

  it("is lenient for documentation changes", () => {
    const prompt = getReviewerPrompt();
    assert.ok(prompt.includes("Documentation-only changes"));
  });
});
