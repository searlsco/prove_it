#!/usr/bin/env node
/**
 * prove_it: Beads enforcement hook
 *
 * Ensures work is tracked by a bead before allowing code changes.
 *
 * Handles:
 * - PreToolUse (Edit/Write): blocks if no in_progress bead exists
 *
 * The goal: no more "adding beads after the fact"
 */
const fs = require("fs");
const path = require("path");

const {
  readStdin,
  tryRun,
  isGitRepo,
  gitRoot,
  emitJson,
  defaultBeadsConfig,
  loadEffectiveConfig,
  loadGlobalConfig,
  isIgnoredPath,
  globToRegex,
} = require("../shared");

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


/**
 * Check if a file path matches any of the configured source globs.
 * If no sources configured, all files are considered source files.
 */
function isSourceFile(filePath, rootDir, sources) {
  if (!sources || sources.length === 0) return true;

  let relativePath;
  if (path.isAbsolute(filePath)) {
    relativePath = path.relative(rootDir, filePath);
  } else {
    relativePath = filePath;
  }

  // Outside the repo
  if (relativePath.startsWith("..")) return false;

  return sources.some((glob) => globToRegex(glob).test(relativePath));
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
    console.error(`prove_it: bd command failed: ${e.message}. Beads may need updating.`);
    return null; // Fail open with warning
  }

  if (r.code !== 0) {
    // bd command failed - could be bd not installed, or other error
    // Fail open but log a warning
    if (r.stderr && r.stderr.includes("command not found")) {
      console.error("prove_it: bd command not found. Install beads or disable beads enforcement.");
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

function isBashWriteOperation(command, patterns) {
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
      reason: `prove_it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`,
    });
    process.exit(0);
  }

  const hookEvent = input.hook_event_name;
  if (hookEvent !== "PreToolUse") process.exit(0);

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  // Skip hooks entirely for non-git directories (tmp, home, bin, etc.)
  if (!isGitRepo(projectDir)) {
    process.exit(0);
  }

  // Check for ignored paths in global config
  const globalCfg = loadGlobalConfig();
  if (isIgnoredPath(projectDir, globalCfg.ignoredPaths)) {
    process.exit(0);
  }

  const { cfg } = loadEffectiveConfig(projectDir, defaultBeadsConfig);

  // Check for top-level enabled: false in config
  if (cfg.enabled === false) {
    process.exit(0);
  }

  if (!cfg.beads?.enabled) process.exit(0);

  const toolName = input.tool_name;

  // Check if this tool requires a bead
  let requiresBead = GATED_TOOLS.includes(toolName);

  // For Bash, check if it looks like a write operation
  if (!requiresBead && toolName === "Bash") {
    const command = input.tool_input?.command || "";
    requiresBead = isBashWriteOperation(command, BASH_WRITE_PATTERNS);
  }

  if (!requiresBead) process.exit(0);

  // Find the repo root
  const rootDir = gitRoot(projectDir) || projectDir;

  // Skip enforcement for non-source files (e.g. docs, README)
  if (cfg.sources && cfg.sources.length > 0) {
    let targetPath = null;
    if (GATED_TOOLS.includes(toolName)) {
      targetPath = input.tool_input?.file_path || input.tool_input?.notebook_path;
    }
    if (targetPath && !isSourceFile(targetPath, rootDir, cfg.sources)) {
      process.exit(0);
    }
  }

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
  const reason = `prove_it: No bead is tracking this work.

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
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

// Export for CLI, auto-run when called directly
if (require.main === module) {
  main();
}
module.exports = { main, isSourceFile };
