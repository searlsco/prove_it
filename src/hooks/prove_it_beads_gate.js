#!/usr/bin/env node
/**
 * prove-it: Beads enforcement gate
 *
 * Ensures work is tracked by a bead before allowing code changes.
 *
 * Handles:
 * - PreToolUse (Edit/Write): blocks if no in_progress bead exists
 *
 * The goal: no more "adding beads after the fact"
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  shellEscape,
  readStdin,
  loadJson,
  mergeDeep,
  tryRun,
  gitRoot,
  emitJson,
  migrateConfig,
} = require("../../lib/shared");

// Hardcoded: tools that require a bead to be in progress
const GATED_TOOLS = ["Edit", "Write", "NotebookEdit"];

// Hardcoded: bash patterns that look like code-writing operations
const BASH_WRITE_PATTERNS = [
  "\\bcat\\s+.*>",
  "\\becho\\s+.*>",
  "\\btee\\s",
  "\\bsed\\s+-i",
  "\\bawk\\s+.*-i\\s*inplace",
];

function defaultConfig() {
  return {
    beads: {
      enabled: true,
    },
  };
}

function loadEffectiveConfig(projectDir) {
  const home = os.homedir();
  const globalCfgPath = path.join(home, ".claude", "prove_it", "config.json");

  let cfg = defaultConfig();
  const globalCfg = loadJson(globalCfgPath);
  if (globalCfg) {
    cfg = mergeDeep(cfg, migrateConfig({ ...globalCfg }));
  }

  const teamCfgPath = path.join(projectDir, ".claude", "prove_it.json");
  const teamCfg = loadJson(teamCfgPath);
  if (teamCfg) {
    cfg = mergeDeep(cfg, migrateConfig({ ...teamCfg }));
  }

  const localCfgPath = path.join(projectDir, ".claude", "prove_it.local.json");
  const localCfg = loadJson(localCfgPath);
  if (localCfg) {
    cfg = mergeDeep(cfg, migrateConfig({ ...localCfg }));
  }

  return cfg;
}

function isBeadsRepo(dir) {
  // Check if .beads directory exists AND is a project (not just global config)
  // A beads project has config.yaml or beads.db; the global ~/.beads/ only has registry.json
  const beadsDir = path.join(dir, ".beads");
  if (!fs.existsSync(beadsDir)) return false;
  return (
    fs.existsSync(path.join(beadsDir, "config.yaml")) ||
    fs.existsSync(path.join(beadsDir, "beads.db")) ||
    fs.existsSync(path.join(beadsDir, "metadata.json"))
  );
}

function getInProgressBeads(dir) {
  // Try to get in_progress beads using bd command
  // Wrap in try/catch for resilience if bd is broken or missing
  let r;
  try {
    r = tryRun(`bd list --status in_progress 2>/dev/null`, { cwd: dir });
  } catch (e) {
    console.error(`prove-it: bd command failed: ${e.message}. Beads may need updating.`);
    return null; // Fail open with warning
  }

  if (r.code !== 0) {
    // bd command failed - could be bd not installed, or other error
    // Fail open but log a warning
    if (r.stderr && r.stderr.includes("command not found")) {
      console.error("prove-it: bd command not found. Install beads or disable beads enforcement.");
    }
    return null;
  }

  // Parse the output - bd list returns a table format
  // Look for any non-empty, non-header lines
  const lines = r.stdout
    .trim()
    .split("\n")
    .filter((line) => {
      // Skip empty lines and header separators
      if (!line.trim()) return false;
      if (line.includes("───") || line.includes("---")) return false;
      if (line.toLowerCase().includes("no issues found")) return false;
      // Skip the header line
      if (line.toLowerCase().includes("id") && line.toLowerCase().includes("subject")) return false;
      return true;
    });

  return lines;
}

function shouldGateBash(command, patterns) {
  return patterns.some((pat) => {
    try {
      return new RegExp(pat, "i").test(command);
    } catch {
      return false;
    }
  });
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch (e) {
    // Fail closed: if we can't parse input, block with error
    emitJson({
      decision: "block",
      reason: `prove-it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`,
    });
    process.exit(0);
  }

  const hookEvent = input.hook_event_name;
  if (hookEvent !== "PreToolUse") process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const cfg = loadEffectiveConfig(projectDir);

  if (!cfg.beads?.enabled) process.exit(0);

  const toolName = input.tool_name;

  // Check if this tool should be gated
  let shouldGate = GATED_TOOLS.includes(toolName);

  // For Bash, check if it looks like a write operation
  if (!shouldGate && toolName === "Bash") {
    const command = input.tool_input?.command || "";
    shouldGate = shouldGateBash(command, BASH_WRITE_PATTERNS);
  }

  if (!shouldGate) process.exit(0);

  // Find the repo root
  const rootDir = gitRoot(projectDir) || projectDir;

  // Check if this is a beads-enabled repo
  if (!isBeadsRepo(rootDir)) {
    // Not a beads repo, don't enforce
    process.exit(0);
  }

  // Check for in_progress beads
  const inProgress = getInProgressBeads(rootDir);

  if (inProgress === null) {
    // bd command failed or not available, don't block (fail open with warning already logged)
    process.exit(0);
  }

  if (inProgress.length > 0) {
    // There are in_progress beads, allow the operation
    process.exit(0);
  }

  // No in_progress beads - block and explain
  const reason = `prove-it: No bead is tracking this work.

Before making code changes, select or create a bead to track this work:

  bd ready              # Show tasks ready to work on
  bd list               # Show all tasks
  bd show <id>          # View task details
  bd update <id> --status in_progress   # Start working on a task
  bd create "Title"     # Create a new task

Once you have an in_progress bead, this operation will be allowed.

Tip: If this is exploratory work, you can disable beads enforcement in
.claude/prove_it.local.json by setting beads.enabled: false`;

  emitJson({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "block",
      permissionDecisionReason: reason,
    },
  });
}

// Export for CLI, auto-run when called directly
if (require.main === module) {
  main();
}
module.exports = { main };
