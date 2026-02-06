#!/usr/bin/env node
/**
 * prove_it: Stop hook
 *
 * Handles:
 * - Stop: runs fast tests, skips if tests passed more recently than latest mtime
 *
 * Mtime-based skip logic:
 * - Tracks last run timestamp for fast and full tests in .claude/prove_it.local.json
 * - Compares to max mtime of tracked files (git ls-files or configured globs)
 * - If last run passed after latest mtime → skip (no re-run needed)
 * - If last run failed after latest mtime → block immediately (fix tests first)
 *
 * Test script resolution (explicit config wins):
 * - Fast: cfg.commands.test.fast > script/test_fast > full tests
 * - Full: cfg.commands.test.full > script/test > script/test_slow
 */
const {
  shellEscape,
  readStdin,
  tryRun,
  isGitRepo,
  gitHead,
  emitJson,
  truncateChars,
  defaultTestConfig,
  loadGlobalConfig,
  isIgnoredPath,
  loadEffectiveConfig,
  loadRunData,
  saveRunData,
  loadSessionState,
  saveSessionState,
  resolveFastTests,
  testScriptExists,
  getLatestSnapshot,
  generateDiffsSince,
  logReview,
  resolveTestRoot,
  runTests,
  shouldSkipTests,
  fullTestsSatisfyFast,
  testScriptMissingMessage,
  parseJsonlOutput,
  parseVerdict,
  runReviewer,
} = require("../shared");

function softStopReminder() {
  return `prove_it: Tests passed. Before finishing, verify:
- Did you run every verification command yourself, or did you leave "Try X" for the user?
- If you couldn't run something, did you clearly mark it UNVERIFIED?
- Is the user receiving completed, verified work - or a verification TODO list?`;
}

const DEFAULT_COVERAGE_PROMPT = `Check that code changes have corresponding test coverage.

For each changed source file:
- Verify corresponding test files were also modified
- Check that tests actually exercise the changed behavior
- Watch for lazy testing: \`assert true\`, empty test bodies, tests that don't call the code

Be skeptical of:
- Source changes with no test changes
- New functions/methods without test cases
- Bug fixes without regression tests

Be lenient for:
- Documentation-only changes
- Config file changes
- Refactors where existing tests still apply
- Test-only changes`;

function getCoverageReviewerPrompt(userPrompt, diffs) {
  const job = userPrompt || DEFAULT_COVERAGE_PROMPT;

  let diffSection = "";
  if (diffs && diffs.length > 0) {
    diffSection = `\n## Changes since last review\n\n`;
    for (const { file, diff } of diffs) {
      diffSection += `### ${file}\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
    }
  }

  return `You are a code reviewer. A coding agent is trying to stop work.
${diffSection}
## Your task

${job}

## Rules

- If no changes to review, return PASS
- Only FAIL for clear violations - when in doubt, PASS
- If diffs not provided above, run: git diff --stat

## Response format

Return EXACTLY one of:
- PASS
- FAIL: <reason>

One line only. Be concise.`;
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch (e) {
    emitJson({
      decision: "block",
      reason: `prove_it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`,
    });
    process.exit(0);
  }

  const sessionId = input.session_id || null;
  const hookEvent = input.hook_event_name;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  // Only handle Stop events
  if (hookEvent !== "Stop") process.exit(0);

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0);
  }

  // Skip hooks entirely for non-git directories (tmp, home, bin, etc.)
  if (!isGitRepo(projectDir)) {
    process.exit(0);
  }

  // Check for ignored paths in global config
  const globalCfg = loadGlobalConfig();
  if (isIgnoredPath(projectDir, globalCfg.ignoredPaths)) {
    process.exit(0);
  }

  const { cfg, localCfgPath } = loadEffectiveConfig(projectDir, defaultTestConfig);

  // Check for top-level enabled: false in config
  if (cfg.enabled === false) {
    process.exit(0);
  }

  if (!cfg.hooks?.stop?.enabled) process.exit(0);

  const rootDir = resolveTestRoot(projectDir);

  // If not a git repo, use simpler logic
  if (!isGitRepo(projectDir)) {
    emitJson({
      decision: "approve",
      reason: softStopReminder(),
    });
    process.exit(0);
  }

  const fastTestCmd = resolveFastTests(rootDir, cfg);
  const head = gitHead(rootDir);

  // Check if full tests passed recently (satisfies fast tests too)
  if (fullTestsSatisfyFast(rootDir, cfg, localCfgPath)) {
    emitJson({
      decision: "approve",
      reason: softStopReminder(),
    });
    process.exit(0);
  }

  // Check mtime-based skip for fast tests
  const skipCheck = shouldSkipTests(rootDir, cfg, localCfgPath, "test_fast");

  if (skipCheck.skip && skipCheck.reason === "passed") {
    emitJson({
      decision: "approve",
      reason: softStopReminder(),
    });
    process.exit(0);
  }

  if (skipCheck.skip && skipCheck.reason === "failed") {
    const lastRun = skipCheck.lastRun;
    emitJson({
      decision: "block",
      reason:
        `prove_it: Tests failed and no code has changed since.\n\n` +
        `Command: ${fastTestCmd}\n` +
        `Last run: ${new Date(lastRun.at).toISOString()}\n` +
        `Result: FAILED\n\n` +
        `Fix the failing tests, then try stopping again.\n` +
        `(Tests will re-run automatically when source files change.)`,
    });
    process.exit(0);
  }

  // Check if test script exists
  if (!testScriptExists(rootDir, fastTestCmd)) {
    emitJson({
      decision: "block",
      reason: testScriptMissingMessage(fastTestCmd, rootDir),
    });
    process.exit(0);
  }

  // Run the fast tests
  const run = runTests(rootDir, fastTestCmd);
  const maxChars = cfg.format?.maxOutputChars || 12000;
  const outputTail = truncateChars(run.combined, maxChars);

  // Get current snapshot before saving run data
  const currentSnapshot = getLatestSnapshot(sessionId, projectDir);
  const currentSnapshotId = currentSnapshot?.messageId || null;

  // Save run result
  saveRunData(localCfgPath, "test_fast", {
    at: Date.now(),
    head,
    pass: run.code === 0,
  });

  if (run.code === 0) {
    // Fast tests passed - run coverage reviewer if enabled
    let coverageReviewStatus = null;
    let coverageReviewReason = null;
    if (cfg.hooks?.stop?.reviewer?.enabled) {
      // Get previous snapshot ID from last successful review (session-scoped)
      const lastReviewSnapshotId = loadSessionState(sessionId, "last_review_snapshot");

      // Generate diffs since last review
      const diffs = generateDiffsSince(sessionId, projectDir, lastReviewSnapshotId, maxChars);

      // No diffs = nothing to review = PASS
      if (!diffs || diffs.length === 0) {
        coverageReviewStatus = "PASS";
        coverageReviewReason = "no changes since last review";
        logReview(sessionId, projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
      } else {
        const prompt = getCoverageReviewerPrompt(cfg.hooks.stop.reviewer.prompt, diffs);
        const review = runReviewer(rootDir, cfg.hooks.stop.reviewer, prompt);

        if (!review.available) {
          coverageReviewStatus = "FAIL";
          coverageReviewReason = `${review.binary || "reviewer"} not found`;
          logReview(sessionId, projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
          emitJson({
            decision: "block",
            reason:
              `prove_it: Coverage reviewer: FAIL\n\n` +
              `${review.binary || "reviewer"} not found - cannot verify test coverage.\n\n` +
              `Install ${review.binary || "reviewer"} or disable coverage reviewer in .claude/prove_it.json`,
          });
          process.exit(0);
        }

        if (review.error) {
          // Reviewer errored = can't verify = FAIL
          coverageReviewStatus = "FAIL";
          coverageReviewReason = review.error;
          logReview(sessionId, projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
          emitJson({
            decision: "block",
            reason:
              `prove_it: Coverage reviewer: FAIL\n\n` +
              `Reviewer error: ${review.error}\n\n` +
              `Fix the issue or disable coverage reviewer in .claude/prove_it.json`,
          });
          process.exit(0);
        }

        if (review.pass === false) {
          coverageReviewStatus = "FAIL";
          coverageReviewReason = review.reason;
          logReview(sessionId, projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
          emitJson({
            decision: "block",
            reason:
              `prove_it: Coverage reviewer: FAIL\n\n` +
              `${review.reason}\n\n` +
              `Tests passed, but the reviewer found insufficient test coverage.\n` +
              `Add tests for the changed code, then try again.`,
          });
          process.exit(0);
        }

        coverageReviewStatus = "PASS";
        coverageReviewReason = null;
        logReview(sessionId, projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
        // Save snapshot ID for next time (session-scoped)
        if (currentSnapshotId) {
          saveSessionState(sessionId, "last_review_snapshot", currentSnapshotId);
        }
      }
    }

    const reviewerNote = coverageReviewStatus ? `Coverage reviewer: ${coverageReviewStatus}\n\n` : "";
    emitJson({
      decision: "approve",
      reason: `prove_it: Tests passed.${coverageReviewStatus ? ` ${reviewerNote.trim()}` : ""}\n\n${softStopReminder()}`,
    });
    process.exit(0);
  } else {
    emitJson({
      decision: "block",
      reason:
        `prove_it: Tests failed; cannot stop.\n\n` +
        `Repo: ${rootDir}\n` +
        `Command: ${fastTestCmd}\n` +
        `Exit: ${run.code}\n` +
        `Duration: ${(run.durationMs / 1000).toFixed(1)}s\n\n` +
        `Tail:\n${outputTail || "(no output captured)"}\n\n` +
        `Fix the failure, then try stopping again.`,
    });
    process.exit(0);
  }
}

// Export for CLI, auto-run when called directly
if (require.main === module) {
  main();
}
module.exports = { main };
