#!/usr/bin/env node
/**
 * prove-it: Verifiability gate
 *
 * Handles:
 * - PreToolUse (Bash): wraps selected "completion boundary" commands with the full gate
 * - Stop: runs fast gate, skips if tests passed more recently than latest mtime
 *
 * Mtime-based skip logic:
 * - Tracks last run timestamp for fast and full gates in .claude/prove_it.local.json
 * - Compares to max mtime of tracked files (git ls-files or configured globs)
 * - If last run passed after latest mtime → skip (no re-run needed)
 * - If last run failed after latest mtime → block immediately (fix tests first)
 *
 * Gate resolution (explicit config wins):
 * - Fast: cfg.commands.test.fast > script/test_fast > full gate
 * - Full: cfg.commands.test.full > script/test > script/test_slow
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function defaultGateConfig() {
  return {
    commands: {
      test: {
        full: null, // resolved via convention if not set
        fast: null, // resolved via convention if not set
      },
    },
    sources: null, // glob patterns for source files; null = use git ls-files
    preToolUse: {
      enabled: true,
      permissionDecision: "allow",
      // Note: git push removed - commit already runs full gate
      gatedCommandRegexes: [
        "(^|\\s)git\\s+commit\\b",
        "(^|\\s)(beads|bd)\\s+(done|finish|close)\\b",
      ],
    },
    stop: {
      enabled: true,
      reviewer: {
        enabled: true,
      },
      maxOutputLines: 200,
      maxOutputChars: 12000,
    },
  };
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function globToRegex(glob) {
  // Escape special regex chars except * and ?
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Convert ** to match any path
  pattern = pattern.replace(/\*\*/g, "{{GLOBSTAR}}");
  // Convert * to match any file/dir name (not path separator)
  pattern = pattern.replace(/\*/g, "[^/]*");
  // Convert ? to match single char
  pattern = pattern.replace(/\?/g, ".");
  // Restore globstar
  pattern = pattern.replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp("^" + pattern + "$");
}

function walkDir(baseDir, currentDir, pattern, files) {
  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      walkDir(baseDir, fullPath, pattern, files);
    } else if (entry.isFile()) {
      if (pattern.test(relativePath)) {
        files.add(relativePath);
      }
    }
  }
}

function expandGlobs(rootDir, globs) {
  const files = new Set();

  for (const glob of globs) {
    // Convert glob to regex for simple matching
    // This handles basic patterns like "src/**", "*.js", "test/**/*.test.js"
    const pattern = globToRegex(glob);
    walkDir(rootDir, rootDir, pattern, files);
  }

  return Array.from(files);
}

function gateExists(rootDir, gateCmd) {
  if (!gateCmd) return false;

  // Handle ./script/* and ./scripts/* patterns
  if (gateCmd.startsWith("./script/")) {
    const scriptPath = path.join(rootDir, gateCmd.slice(2));
    return fs.existsSync(scriptPath);
  }
  if (gateCmd.startsWith("./scripts/")) {
    const scriptPath = path.join(rootDir, gateCmd.slice(2));
    return fs.existsSync(scriptPath);
  }

  // For other commands, assume they exist (can't reliably check)
  return true;
}

function tryRun(cmd, opts) {
  const r = spawnSync(cmd, {
    ...opts,
    shell: true,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return { code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function shellEscape(str) {
  if (typeof str !== "string") return String(str);
  // Single-quote the string and escape any embedded single quotes
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function gitTrackedFiles(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} ls-files`, {});
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean);
}

function getLatestMtime(rootDir, globs) {
  let files;

  if (globs && globs.length > 0) {
    // Use glob patterns
    files = expandGlobs(rootDir, globs);
  } else {
    // Default: all git-tracked files
    files = gitTrackedFiles(rootDir);
  }

  let maxMtime = 0;
  for (const file of files) {
    const fullPath = path.join(rootDir, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
    } catch {
      // File might not exist (deleted but still tracked, or glob matched nothing)
    }
  }

  return maxMtime;
}

function gitHead(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse HEAD`, {});
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

function gitRoot(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse --show-toplevel`, {});
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

function isGitRepo(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse --is-inside-work-tree`, {});
  return r.code === 0 && r.stdout.trim() === "true";
}

function mergeDeep(a, b) {
  if (b === undefined || b === null) return a;
  if (Array.isArray(a) && Array.isArray(b)) return b; // override arrays
  if (typeof a === "object" && a && typeof b === "object" && b) {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = mergeDeep(a[k], b[k]);
    return out;
  }
  return b;
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function migrateConfig(cfg) {
  if (!cfg) return cfg;

  // Migrate suiteGate to commands.test
  if (cfg.suiteGate) {
    if (!cfg.commands) cfg.commands = {};
    if (!cfg.commands.test) cfg.commands.test = {};

    if (cfg.suiteGate.command && !cfg.commands.test.full) {
      cfg.commands.test.full = cfg.suiteGate.command;
    }

    // Copy require flag to a new location if needed (or just remove it)
    // For now, we'll remove suiteGate after migration
    delete cfg.suiteGate;
  }

  // Migrate old preToolUse.permissionDecision from "ask" to "allow"
  if (cfg.preToolUse?.permissionDecision === "ask") {
    cfg.preToolUse.permissionDecision = "allow";
  }

  // Remove git push from gatedCommandRegexes if present (old default)
  if (cfg.preToolUse?.gatedCommandRegexes) {
    cfg.preToolUse.gatedCommandRegexes = cfg.preToolUse.gatedCommandRegexes.filter(
      (re) => !re.includes("git\\s+push")
    );
  }

  return cfg;
}

function loadEffectiveConfig(projectDir, defaultFn) {
  const home = os.homedir();
  const baseDir = path.join(home, ".claude", "prove-it");
  const globalCfgPath = path.join(baseDir, "config.json");

  // Start with defaults
  let cfg = defaultFn();

  // Layer 1: Global user config (~/.claude/prove-it/config.json)
  const globalCfg = loadJson(globalCfgPath);
  if (globalCfg) {
    cfg = mergeDeep(cfg, migrateConfig({ ...globalCfg }));
  }

  // Layer 2: Project team config (.claude/prove_it.json) - committed to repo
  const teamCfgPath = path.join(projectDir, ".claude", "prove_it.json");
  const teamCfg = loadJson(teamCfgPath);
  if (teamCfg) {
    cfg = mergeDeep(cfg, migrateConfig({ ...teamCfg }));
  }

  // Layer 3: Project local config (.claude/prove_it.local.json) - gitignored
  const localCfgPath = path.join(projectDir, ".claude", "prove_it.local.json");
  const localCfg = loadJson(localCfgPath);
  if (localCfg) {
    cfg = mergeDeep(cfg, migrateConfig({ ...localCfg }));
  }

  return { cfg, baseDir, localCfgPath };
}

function loadRunData(localCfgPath) {
  const data = loadJson(localCfgPath);
  return data?.runs || {};
}

function nowIso() {
  return new Date().toISOString();
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function resolveFullGate(rootDir, cfg) {
  // Explicit config wins
  if (cfg.commands?.test?.full) {
    return cfg.commands.test.full;
  }

  // Convention: script/test
  const test = path.join(rootDir, "script", "test");
  if (fs.existsSync(test)) {
    return "./script/test";
  }

  // Fallback: script/test_slow
  const testSlow = path.join(rootDir, "script", "test_slow");
  if (fs.existsSync(testSlow)) {
    return "./script/test_slow";
  }

  // Default if nothing exists
  return "./script/test";
}

function resolveFastGate(rootDir, cfg) {
  // Explicit config wins
  if (cfg.commands?.test?.fast) {
    return cfg.commands.test.fast;
  }

  // Convention: script/test_fast
  const testFast = path.join(rootDir, "script", "test_fast");
  if (fs.existsSync(testFast)) {
    return "./script/test_fast";
  }

  // Fall back to full gate
  return resolveFullGate(rootDir, cfg);
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function saveRunData(localCfgPath, runKey, runData) {
  const data = loadJson(localCfgPath) || {};
  if (!data.runs) data.runs = {};
  data.runs[runKey] = runData;
  writeJson(localCfgPath, data);
}

function tailLines(s, n) {
  const lines = s.split(/\r?\n/);
  const tail = lines.slice(Math.max(0, lines.length - n));
  return tail.join("\n").trimEnd();
}

function truncateChars(s, maxChars) {
  if (s.length <= maxChars) return s;
  return s.slice(-maxChars);
}


function shouldGateCommand(command, regexes) {
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
  // Block Claude from writing to prove_it.local.json or prove_it.json
  const cmd = command || "";
  if (!cmd.includes("prove_it.local.json") && !cmd.includes("prove_it.json")) return false;
  // Check for write operators
  return /[^<]>|>>|\btee\b/.test(cmd);
}

function resolveRoot(projectDir) {
  if (isGitRepo(projectDir)) return gitRoot(projectDir) || projectDir;
  return projectDir;
}

function runGate(rootDir, gateCmd) {
  const start = Date.now();
  const r = tryRun(gateCmd, { cwd: rootDir });
  const durationMs = Date.now() - start;
  const combined = `${r.stdout}\n${r.stderr}`.trim();
  return { ...r, combined, durationMs };
}

function softStopReminder() {
  return `prove-it: Gate passed. Before finishing, verify:
- Did you run every verification command yourself, or did you leave "Try X" for the user?
- If you couldn't run something, did you clearly mark it UNVERIFIED?
- Is the user receiving completed, verified work - or a verification TODO list?`;
}

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

function runReviewer(rootDir) {
  // Check if claude CLI is available
  const whichResult = tryRun("which claude", {});
  if (whichResult.code !== 0) {
    return { available: false };
  }

  const prompt = getReviewerPrompt();
  const result = tryRun(`claude -p ${shellEscape(prompt)}`, {
    cwd: rootDir,
    timeout: 120000,
  });

  if (result.code !== 0) {
    return { available: true, error: result.stderr || "unknown error" };
  }

  const output = result.stdout.trim();
  const firstLine = output.split("\n")[0].trim();

  if (firstLine === "PASS") {
    return { available: true, pass: true };
  }

  if (firstLine.startsWith("FAIL:")) {
    return { available: true, pass: false, reason: firstLine.slice(5).trim() };
  }

  if (firstLine === "FAIL") {
    const lines = output.split("\n");
    const reason = lines.length > 1 ? lines[1].trim() : "No reason provided";
    return { available: true, pass: false, reason };
  }

  return { available: true, error: `Unexpected reviewer output: ${firstLine}` };
}

function gateMissingMessage(gateCmd, rootDir) {
  const esc = shellEscape(rootDir);
  return `prove-it: Gate not found.

The gate command '${gateCmd}' does not exist at:
  ${rootDir}

This is a safety block. Options:

1. CREATE THE GATE (recommended):
   prove_it init

2. USE A DIFFERENT COMMAND (e.g., npm test):
   Create .claude/prove_it.json with:
   { "commands": { "test": { "full": "npm test" } } }

3. Or create the script directly:
   mkdir -p ${esc}/script && echo '#!/bin/bash\\nnpm test' > ${esc}/script/test && chmod +x ${esc}/script/test

For more info: https://github.com/searlsco/prove-it#configuration`;
}

/**
 * Check if we should skip running a gate based on mtime comparison.
 * Returns: { skip: boolean, reason?: string, lastRun?: object }
 */
function shouldSkipGate(rootDir, cfg, localCfgPath, runKey) {
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
 * Check if full gate passed recently enough to also satisfy fast gate.
 */
function fullGateSatisfiesFast(rootDir, cfg, localCfgPath) {
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
      reason: `prove-it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`,
    });
    process.exit(0);
  }

  const hookEvent = input.hook_event_name;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const { cfg, localCfgPath } = loadEffectiveConfig(projectDir, defaultGateConfig);

  if (hookEvent === "PreToolUse") {
    if (!cfg.preToolUse.enabled) process.exit(0);
    if (input.tool_name !== "Bash") process.exit(0);

    const toolCmd = input.tool_input && input.tool_input.command ? String(input.tool_input.command) : "";
    if (!toolCmd.trim()) process.exit(0);

    // Block Claude from modifying config files
    if (isLocalConfigWrite(toolCmd)) {
      emitJson({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `prove-it: Cannot modify .claude/prove_it*.json\n\n` +
            `These files are for user configuration. ` +
            `To modify them, run the command directly in your terminal (not through Claude).`,
        },
      });
      process.exit(0);
    }

    // Only gate selected boundary commands
    if (!shouldGateCommand(toolCmd, cfg.preToolUse.gatedCommandRegexes)) process.exit(0);

    const rootDir = resolveRoot(projectDir);
    const fullGateCmd = resolveFullGate(rootDir, cfg);

    // Avoid double-wrapping
    if (toolCmd.includes(fullGateCmd)) process.exit(0);

    // Check if gate exists
    if (!gateExists(rootDir, fullGateCmd)) {
      const msg = gateMissingMessage(fullGateCmd, rootDir);
      emitJson({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: cfg.preToolUse.permissionDecision,
          permissionDecisionReason: "prove-it: gate missing; blocking completion boundary",
          updatedInput: {
            ...input.tool_input,
            command: `echo ${shellEscape(msg)} 1>&2; exit 1`,
          },
        },
      });
      process.exit(0);
    }

    // Check mtime-based skip for full gate
    const skipCheck = shouldSkipGate(rootDir, cfg, localCfgPath, "test_full");

    if (skipCheck.skip && skipCheck.reason === "passed") {
      // Full gate passed recently, allow the command without re-running
      process.exit(0);
    }

    if (skipCheck.skip && skipCheck.reason === "failed") {
      // Full gate failed recently, block immediately
      const lastRun = skipCheck.lastRun;
      const msg = `prove-it: Tests failed and no code has changed since.

Gate: ${fullGateCmd}
Last run: ${new Date(lastRun.at).toISOString()}
Result: FAILED

Fix the failing tests before committing.
(The gate will re-run automatically when source files change.)`;

      emitJson({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: cfg.preToolUse.permissionDecision,
          permissionDecisionReason: "prove-it: cached failure, no code changes",
          updatedInput: {
            ...input.tool_input,
            command: `echo ${shellEscape(msg)} 1>&2; exit 1`,
          },
        },
      });
      process.exit(0);
    }

    // Wrap: run full gate in repo root, then return to original cwd for the original command
    const cwd = input.cwd || projectDir;
    const wrapped = [
      `cd ${shellEscape(rootDir)}`,
      `&& ${fullGateCmd}`,
      `&& cd ${shellEscape(cwd)}`,
      `&& ${toolCmd}`,
    ].join(" ");

    emitJson({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: cfg.preToolUse.permissionDecision,
        permissionDecisionReason: `prove-it: running full gate (${fullGateCmd}) before this command`,
        updatedInput: {
          ...input.tool_input,
          command: wrapped,
          description:
            input.tool_input && input.tool_input.description
              ? `${input.tool_input.description} (prove-it: gated by ${fullGateCmd})`
              : `prove-it: gated by ${fullGateCmd}`,
        },
      },
    });
    process.exit(0);
  }

  if (hookEvent === "Stop") {
    if (!cfg.stop.enabled) process.exit(0);

    const rootDir = resolveRoot(projectDir);

    // If not a git repo, use simpler logic
    if (!isGitRepo(projectDir)) {
      emitJson({
        decision: "approve",
        reason: softStopReminder(),
      });
      process.exit(0);
    }

    const fastGateCmd = resolveFastGate(rootDir, cfg);
    const head = gitHead(rootDir);

    // Check if full gate passed recently (satisfies fast gate too)
    if (fullGateSatisfiesFast(rootDir, cfg, localCfgPath)) {
      emitJson({
        decision: "approve",
        reason: softStopReminder(),
      });
      process.exit(0);
    }

    // Check mtime-based skip for fast gate
    const skipCheck = shouldSkipGate(rootDir, cfg, localCfgPath, "test_fast");

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
          `prove-it: Tests failed and no code has changed since.\n\n` +
          `Gate: ${fastGateCmd}\n` +
          `Last run: ${new Date(lastRun.at).toISOString()}\n` +
          `Result: FAILED\n\n` +
          `Fix the failing tests, then try stopping again.\n` +
          `(The gate will re-run automatically when source files change.)`,
      });
      process.exit(0);
    }

    // Check if gate exists
    if (!gateExists(rootDir, fastGateCmd)) {
      emitJson({
        decision: "block",
        reason: gateMissingMessage(fastGateCmd, rootDir),
      });
      process.exit(0);
    }

    // Run the fast gate
    const run = runGate(rootDir, fastGateCmd);
    const outputTail = truncateChars(tailLines(run.combined, cfg.stop.maxOutputLines), cfg.stop.maxOutputChars);

    // Save run result
    saveRunData(localCfgPath, "test_fast", {
      at: Date.now(),
      head,
      pass: run.code === 0,
    });

    if (run.code === 0) {
      // Fast gate passed - run reviewer if enabled
      if (cfg.stop.reviewer?.enabled) {
        const review = runReviewer(rootDir);

        if (review.available && review.pass === false) {
          emitJson({
            decision: "block",
            reason:
              `prove-it: Test coverage review failed.\n\n` +
              `${review.reason}\n\n` +
              `The gate passed, but the reviewer found insufficient test coverage.\n` +
              `Add tests for the changed code, then try again.`,
          });
          process.exit(0);
        }

        if (review.error) {
          emitJson({
            decision: "approve",
            reason: `prove-it: Reviewer error (${review.error}). ${softStopReminder()}`,
          });
          process.exit(0);
        }
      }

      emitJson({
        decision: "approve",
        reason: softStopReminder(),
      });
      process.exit(0);
    } else {
      emitJson({
        decision: "block",
        reason:
          `prove-it: Gate failed; cannot stop.\n\n` +
          `Repo: ${rootDir}\n` +
          `Command: ${fastGateCmd}\n` +
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

main();
