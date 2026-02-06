#!/usr/bin/env node
/**
 * prove_it: Test enforcement hook
 *
 * Handles:
 * - PreToolUse (Bash): wraps selected "completion boundary" commands with the full test suite
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
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  shellEscape,
  readStdin,
  loadJson,
  writeJson,
  tryRun,
  isGitRepo,
  gitRoot,
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
  getLatestMtime,
  resolveFastTests,
  resolveFullTests,
  testScriptExists,
  getLatestSnapshot,
  generateDiffsSince,
  logReview,
} = require("../shared");

function shouldRequireTests(command, regexes) {
  const cmd = command || "";
  return regexes.some((re) => {
    try {
      return new RegExp(re, "i").test(cmd);
    } catch {
      return false;
    }
  });
}

function isLocalConfigWrite(command) {
  // Block Claude from writing to prove_it.local.json or prove_it.json via Bash
  // Must check that the redirect/tee actually targets the config file, not just
  // that both appear somewhere in the command (avoid false positives on echo examples)
  const cmd = command || "";
  // Pattern: redirect or tee followed by path containing prove_it config file
  return />\s*\S*prove_it(\.local)?\.json|tee\s+\S*prove_it(\.local)?\.json/.test(cmd);
}

function isConfigFileEdit(toolName, toolInput) {
  // Block Claude from editing prove_it config files via Write/Edit tools
  if (toolName !== "Write" && toolName !== "Edit") return false;
  const filePath = toolInput?.file_path || "";
  return filePath.includes("prove_it.json") || filePath.includes("prove_it.local.json");
}

/**
 * Find the test root by walking up from cwd.
 *
 * A directory is a test root if it has EITHER:
 * - script/test (actual test script)
 * - .claude/prove_it.json (explicit project marker)
 *
 * For git repos: walks from cwd to git root (won't search above).
 * For non-git dirs: only checks cwd (no upward walk).
 *
 * Returns cwd if not found (so error messages show the right path).
 */
function resolveTestRoot(projectDir) {
  // Resolve symlinks for accurate path comparison
  let current;
  try {
    current = fs.realpathSync(projectDir);
  } catch {
    current = path.resolve(projectDir);
  }

  // Get real git root path (also resolving symlinks)
  const rawRoot = gitRoot(current);
  let root = null;
  if (rawRoot) {
    try {
      root = fs.realpathSync(rawRoot);
    } catch {
      root = rawRoot;
    }
  }

  // Non-git directory: only check cwd, don't walk up
  if (!root) {
    return current;
  }

  while (true) {
    // Check if this is a project root (has test script OR prove_it config)
    const hasTestScript = fs.existsSync(path.join(current, "script", "test"));
    const hasConfig = fs.existsSync(path.join(current, ".claude", "prove_it.json"));

    if (hasTestScript || hasConfig) {
      return current;
    }

    // Stop at git root (don't search above it)
    if (current === root) {
      break;
    }

    // Stop at filesystem root (safety)
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  // Not found - return resolved cwd so error message is accurate
  return current;
}

function runTests(rootDir, testCmd) {
  const start = Date.now();
  const r = tryRun(testCmd, { cwd: rootDir });
  const durationMs = Date.now() - start;
  const combined = `${r.stdout}\n${r.stderr}`.trim();
  return { ...r, combined, durationMs };
}

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

const DEFAULT_CODE_PROMPT = `Review staged changes for three things:

## 1. Test coverage
- Source changes should have corresponding test changes
- New functions/methods need test cases
- Bug fixes need regression tests
- Be lenient for: docs, config, refactors where existing tests apply

## 2. Problems the tests may have missed
- Logic errors, edge cases, incorrect assumptions
- Anything that looks wrong but wouldn't cause a test failure

## 3. Dead code
- Unused functions, variables, or imports being added
- Code that can never execute
- Commented-out code that should be deleted

FAIL if ANY of these three checks fail. PASS only if all three pass.

Do NOT flag:
- Style issues or naming preferences
- Documentation gaps
- Existing dead code (only flag NEW dead code in this diff)`;

function getCodeReviewerPrompt(userPrompt, stagedDiff) {
  const job = userPrompt || DEFAULT_CODE_PROMPT;

  let diffSection = "";
  if (stagedDiff) {
    diffSection = `\n## Staged changes (about to be committed)\n\n\`\`\`diff\n${stagedDiff}\n\`\`\`\n`;
  }

  return `You are a code reviewer. A coding agent is about to commit.
${diffSection}
## Your task

${job}

## Rules

- If no changes staged, return PASS
- Only FAIL for real problems - when in doubt, PASS
- If diff not provided above, run: git diff --cached

## Response format

Return EXACTLY one of:
- PASS
- FAIL: <reason>

One line only. Be concise.`;
}

/**
 * Extract the model's response text from JSONL output (e.g. codex exec --json).
 * Finds the last item.completed event with type "agent_message".
 */
function parseJsonlOutput(stdout) {
  const lines = stdout.trim().split("\n");
  let lastMessage = null;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        lastMessage = event.item.text;
      }
    } catch {}
  }
  return lastMessage;
}

/**
 * Parse a PASS/FAIL verdict from the reviewer's response text.
 */
function parseVerdict(output) {
  if (!output) return { error: "No output from reviewer" };

  const firstLine = output.split("\n")[0].trim();

  if (firstLine === "PASS") {
    return { pass: true };
  }

  if (firstLine.startsWith("FAIL:")) {
    return { pass: false, reason: firstLine.slice(5).trim() };
  }

  if (firstLine === "FAIL") {
    const lines = output.split("\n");
    const reason = lines.length > 1 ? lines[1].trim() : "No reason provided";
    return { pass: false, reason };
  }

  return { error: `Unexpected reviewer output: ${firstLine}` };
}

function runReviewer(rootDir, reviewerCfg, prompt) {
  const command = reviewerCfg?.command || "claude -p {prompt}";
  const outputMode = reviewerCfg?.outputMode || "text";

  // Extract binary name for availability check
  const binary = command.split(/\s+/)[0];
  const whichResult = tryRun(`which ${shellEscape(binary)}`, {});
  if (whichResult.code !== 0) {
    return { available: false, binary };
  }

  // Substitute {prompt} in command template
  const fullCommand = command.replace("{prompt}", shellEscape(prompt));

  const result = tryRun(fullCommand, {
    cwd: rootDir,
    timeout: 120000,
  });

  if (result.code !== 0) {
    return { available: true, error: result.stderr || "unknown error" };
  }

  // Extract response text based on outputMode
  let responseText;
  if (outputMode === "jsonl") {
    responseText = parseJsonlOutput(result.stdout);
  } else {
    responseText = result.stdout.trim();
  }

  const verdict = parseVerdict(responseText);
  return { available: true, ...verdict };
}

function testScriptMissingMessage(testCmd, projectDir) {
  const home = os.homedir();
  const displayPath = projectDir.startsWith(home) ? "~" + projectDir.slice(home.length) : projectDir;

  return `prove_it: Test script not found.

The test command '${testCmd}' does not exist.

Options:

1. SET UP TESTING:
   - Run: prove_it init
   - Update script/test to run your full test suite (linter, formatter, etc.)
   - Create script/test_fast for just unit tests (faster feedback)

2. IGNORE THIS DIRECTORY (add to ~/.claude/prove_it/config.json):
   "ignoredPaths": ["${displayPath}"]

3. DISABLE VERIFICATION for this project:
   echo '{"enabled":false}' > .claude/prove_it.json

4. DISABLE GLOBALLY via environment:
   export PROVE_IT_DISABLED=1`;
}

/**
 * Check if we should skip running tests based on mtime comparison.
 * Returns: { skip: boolean, reason?: string, lastRun?: object }
 */
function shouldSkipTests(rootDir, cfg, localCfgPath, runKey) {
  const runs = loadRunData(localCfgPath);
  const lastRun = runs[runKey];

  if (!lastRun || !lastRun.at) {
    return { skip: false };
  }

  const latestMtime = getLatestMtime(rootDir, cfg.sources);

  // If no files found or mtime is 0, don't skip
  if (latestMtime === 0) {
    return { skip: false };
  }

  // Compare last run time to latest mtime
  if (lastRun.at > latestMtime) {
    if (lastRun.pass) {
      // Tests passed more recently than code changed - skip
      return { skip: true, reason: "passed", lastRun };
    } else {
      // Tests failed more recently than code changed - skip running, but block
      return { skip: true, reason: "failed", lastRun };
    }
  }

  return { skip: false };
}

/**
 * Check if full tests passed recently enough to also satisfy fast tests.
 */
function fullTestsSatisfyFast(rootDir, cfg, localCfgPath) {
  const runs = loadRunData(localCfgPath);
  const fullRun = runs["test_full"];

  if (!fullRun || !fullRun.at || !fullRun.pass) {
    return false;
  }

  const latestMtime = getLatestMtime(rootDir, cfg.sources);
  return latestMtime > 0 && fullRun.at > latestMtime;
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

  const hookEvent = input.hook_event_name;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

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

  if (hookEvent === "PreToolUse") {
    // Block Claude from modifying config files via Write/Edit
    if (isConfigFileEdit(input.tool_name, input.tool_input)) {
      emitJson({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `prove_it: Cannot modify .claude/prove_it*.json\n\n` +
            `These files are for user configuration. ` +
            `To modify them, run the command directly in your terminal (not through Claude).`,
        },
      });
      process.exit(0);
    }

    if (!cfg.hooks?.done?.enabled) process.exit(0);
    if (input.tool_name !== "Bash") process.exit(0);

    const toolCmd = input.tool_input && input.tool_input.command ? String(input.tool_input.command) : "";
    if (!toolCmd.trim()) process.exit(0);

    // Block Claude from modifying config files via Bash
    if (isLocalConfigWrite(toolCmd)) {
      emitJson({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `prove_it: Cannot modify .claude/prove_it*.json\n\n` +
            `These files are for user configuration. ` +
            `To modify them, run the command directly in your terminal (not through Claude).`,
        },
      });
      process.exit(0);
    }

    // Only require tests for selected boundary commands
    const patterns = cfg.hooks?.done?.triggers || [];
    if (!shouldRequireTests(toolCmd, patterns)) process.exit(0);

    const rootDir = resolveTestRoot(projectDir);
    const fullTestCmd = resolveFullTests(rootDir, cfg);

    // Avoid double-wrapping
    if (toolCmd.includes(fullTestCmd)) process.exit(0);

    // Check if test script exists
    if (!testScriptExists(rootDir, fullTestCmd)) {
      const msg = testScriptMissingMessage(fullTestCmd, rootDir);
      emitJson({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "prove_it: test script missing; blocking completion boundary",
          updatedInput: {
            ...input.tool_input,
            command: `echo ${shellEscape(msg)} 1>&2; exit 1`,
          },
        },
      });
      process.exit(0);
    }

    // Check mtime-based skip for full tests
    const skipCheck = shouldSkipTests(rootDir, cfg, localCfgPath, "test_full");

    if (skipCheck.skip && skipCheck.reason === "passed") {
      // Full tests passed recently, allow the command without re-running
      process.exit(0);
    }

    if (skipCheck.skip && skipCheck.reason === "failed") {
      // Full tests failed recently, block immediately
      const lastRun = skipCheck.lastRun;
      const msg = `prove_it: Tests failed and no code has changed since.

Command: ${fullTestCmd}
Last run: ${new Date(lastRun.at).toISOString()}
Result: FAILED

Fix the failing tests before committing.
(Tests will re-run automatically when source files change.)`;

      emitJson({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "prove_it: cached failure, no code changes",
          updatedInput: {
            ...input.tool_input,
            command: `echo ${shellEscape(msg)} 1>&2; exit 1`,
          },
        },
      });
      process.exit(0);
    }

    // Run code reviewer on staged changes if enabled
    let codeReviewStatus = null;
    let codeReviewReason = null;
    if (cfg.hooks?.done?.reviewer?.enabled) {
      const stagedResult = tryRun("git diff --cached", { cwd: rootDir });
      const stagedDiff = stagedResult.code === 0 ? stagedResult.stdout.trim() : null;

      // No staged changes = nothing to review = PASS
      if (!stagedDiff) {
        codeReviewStatus = "PASS";
        codeReviewReason = "no staged changes";
      } else {
        const prompt = getCodeReviewerPrompt(cfg.hooks.done.reviewer.prompt, stagedDiff);
        const review = runReviewer(rootDir, cfg.hooks.done.reviewer, prompt);

        if (!review.available) {
          codeReviewStatus = "FAIL";
          codeReviewReason = `${review.binary || "reviewer"} not found`;
          const msg = `prove_it: Code review failed.\n\n${review.binary || "reviewer"} not found - cannot verify code.\n\nInstall ${review.binary || "reviewer"} or disable code reviewer in .claude/prove_it.json`;
          emitJson({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: `prove_it: code reviewer: FAIL (${review.binary || "reviewer"} not found)`,
              updatedInput: {
                ...input.tool_input,
                command: `echo ${shellEscape(msg)} 1>&2; exit 1`,
              },
            },
          });
          logReview(projectDir, "code", codeReviewStatus, codeReviewReason);
          process.exit(0);
        }

        if (review.error) {
          // Reviewer errored = can't verify = FAIL
          codeReviewStatus = "FAIL";
          codeReviewReason = review.error;
          const msg = `prove_it: Code review failed.\n\nReviewer error: ${review.error}`;
          emitJson({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: `prove_it: code reviewer: FAIL (${review.error})`,
              updatedInput: {
                ...input.tool_input,
                command: `echo ${shellEscape(msg)} 1>&2; exit 1`,
              },
            },
          });
          logReview(projectDir, "code", codeReviewStatus, codeReviewReason);
          process.exit(0);
        }

        if (review.pass === false) {
          codeReviewStatus = "FAIL";
          codeReviewReason = review.reason;
          const msg = `prove_it: Code review failed.\n\n${review.reason}\n\nFix the issue before committing.`;
          emitJson({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "prove_it: code reviewer: FAIL",
              updatedInput: {
                ...input.tool_input,
                command: `echo ${shellEscape(msg)} 1>&2; exit 1`,
              },
            },
          });
          logReview(projectDir, "code", codeReviewStatus, codeReviewReason);
          process.exit(0);
        }

        codeReviewStatus = "PASS";
        codeReviewReason = null;
      }

      logReview(projectDir, "code", codeReviewStatus, codeReviewReason);
    }

    // Wrap: run full tests in repo root, then return to original cwd for the original command
    const cwd = input.cwd || projectDir;
    const wrapped = [
      `cd ${shellEscape(rootDir)}`,
      `&& ${fullTestCmd}`,
      `&& cd ${shellEscape(cwd)}`,
      `&& ${toolCmd}`,
    ].join(" ");

    const reviewerNote = codeReviewStatus ? ` | code reviewer: ${codeReviewStatus}` : "";
    emitJson({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: `prove_it: running tests (${fullTestCmd})${reviewerNote}`,
        updatedInput: {
          ...input.tool_input,
          command: wrapped,
          description:
            input.tool_input && input.tool_input.description
              ? `${input.tool_input.description} (prove_it: requires ${fullTestCmd})`
              : `prove_it: requires ${fullTestCmd}`,
        },
      },
    });
    process.exit(0);
  }

  if (hookEvent === "Stop") {
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
    const currentSnapshot = getLatestSnapshot(projectDir);
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
        const lastReviewSnapshotId = loadSessionState("last_review_snapshot");

        // Generate diffs since last review
        const diffs = generateDiffsSince(projectDir, lastReviewSnapshotId, maxChars);

        // No diffs = nothing to review = PASS
        if (!diffs || diffs.length === 0) {
          coverageReviewStatus = "PASS";
          coverageReviewReason = "no changes since last review";
          logReview(projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
        } else {
          const prompt = getCoverageReviewerPrompt(cfg.hooks.stop.reviewer.prompt, diffs);
          const review = runReviewer(rootDir, cfg.hooks.stop.reviewer, prompt);

          if (!review.available) {
            coverageReviewStatus = "FAIL";
            coverageReviewReason = `${review.binary || "reviewer"} not found`;
            logReview(projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
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
            logReview(projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
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
            logReview(projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
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
          logReview(projectDir, "coverage", coverageReviewStatus, coverageReviewReason);
          // Save snapshot ID for next time (session-scoped)
          if (currentSnapshotId) {
            saveSessionState("last_review_snapshot", currentSnapshotId);
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

  // Ignore other events
  process.exit(0);
}

// Export for CLI, auto-run when called directly
if (require.main === module) {
  main();
}
module.exports = { main, parseVerdict, parseJsonlOutput, runReviewer };
