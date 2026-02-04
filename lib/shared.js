/**
 * prove-it: Shared utilities
 *
 * Common functions used by hooks. During development, hooks in src/hooks/
 * require this file. The build script inlines these functions into
 * global/hooks/ for runtime use.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// ============================================================================
// Shell escaping (security)
// ============================================================================

/**
 * Safely escape a string for shell use with single quotes.
 * This is the safest way to pass arbitrary strings to shell commands.
 */
function shellEscape(str) {
  if (typeof str !== "string") return String(str);
  // Single-quote the string and escape any embedded single quotes
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ============================================================================
// I/O utilities
// ============================================================================

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// ============================================================================
// Config merging
// ============================================================================

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

// ============================================================================
// Hashing
// ============================================================================

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ============================================================================
// Command execution
// ============================================================================

function tryRun(cmd, opts) {
  const r = spawnSync(cmd, {
    ...opts,
    shell: true,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return { code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ============================================================================
// Git utilities
// ============================================================================

function isGitRepo(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse --is-inside-work-tree`, {});
  return r.code === 0 && r.stdout.trim() === "true";
}

function gitRoot(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse --show-toplevel`, {});
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

function gitHead(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse HEAD`, {});
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

function gitStatusHash(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} status --porcelain=v1`, {});
  if (r.code !== 0) return null;
  return sha256(r.stdout);
}

function gitTrackedFiles(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} ls-files`, {});
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean);
}

// ============================================================================
// Mtime tracking
// ============================================================================

/**
 * Get the latest mtime of tracked files in a directory.
 * @param {string} rootDir - The root directory to scan
 * @param {string[]|null} globs - Optional glob patterns to filter files. If null, uses git ls-files.
 * @returns {number} - The latest mtime in milliseconds, or 0 if no files found
 */
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

/**
 * Expand glob patterns to file paths.
 * Simple implementation using fs and path matching.
 */
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

// ============================================================================
// Gate resolution
// ============================================================================

/**
 * Resolve the fast gate command.
 * Priority: explicit config > script/test_fast > full gate > script/test
 */
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

/**
 * Resolve the full gate command.
 * Priority: explicit config > script/test > script/test_slow
 */
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

/**
 * Check if a gate command exists.
 */
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

// ============================================================================
// Output utilities
// ============================================================================

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function truncateChars(s, maxChars) {
  if (s.length <= maxChars) return s;
  return s.slice(-maxChars);
}

// ============================================================================
// Time utilities
// ============================================================================

// ============================================================================
// Config loading
// ============================================================================

function defaultGateConfig() {
  return {
    commands: {
      test: {
        full: null, // resolved via convention if not set
        fast: null, // resolved via convention if not set
      },
    },
    sources: null, // glob patterns for source files; null = use git ls-files
    hooks: {
      done: {
        enabled: true,
        commandPatterns: [
          "(^|\\s)git\\s+commit\\b",
          "(^|\\s)(beads|bd)\\s+(done|finish|close)\\b",
        ],
      },
      stop: {
        enabled: true,
      },
    },
    reviewer: {
      onStop: { enabled: true },
      onDone: { enabled: true },
    },
    format: {
      maxOutputChars: 12000,
    },
  };
}

function defaultBeadsConfig() {
  return {
    beads: {
      enabled: true,
    },
  };
}

/**
 * Migrate old config format to new format.
 * Migrations:
 * - suiteGate.command → commands.test.full
 * - preToolUse.* → hooks.done.*
 * - stop.* → hooks.stop.*
 * - beads.gatedTools/gateBashWrites/bashWritePatterns → removed (hardcoded)
 */
function migrateConfig(cfg) {
  if (!cfg) return cfg;

  // Migrate suiteGate to commands.test
  if (cfg.suiteGate) {
    if (!cfg.commands) cfg.commands = {};
    if (!cfg.commands.test) cfg.commands.test = {};

    if (cfg.suiteGate.command && !cfg.commands.test.full) {
      cfg.commands.test.full = cfg.suiteGate.command;
    }
    delete cfg.suiteGate;
  }

  // Migrate preToolUse → hooks.done
  if (cfg.preToolUse) {
    if (!cfg.hooks) cfg.hooks = {};
    if (!cfg.hooks.done) cfg.hooks.done = {};

    if (cfg.preToolUse.enabled !== undefined) {
      cfg.hooks.done.enabled = cfg.preToolUse.enabled;
    }
    if (cfg.preToolUse.gatedCommandRegexes) {
      // Remove git push if present (old default)
      cfg.hooks.done.commandPatterns = cfg.preToolUse.gatedCommandRegexes.filter(
        (re) => !re.includes("git\\s+push")
      );
    }
    // permissionDecision is eliminated
    delete cfg.preToolUse;
  }

  // Migrate stop → hooks.stop + top-level reviewer
  if (cfg.stop) {
    if (!cfg.hooks) cfg.hooks = {};
    if (!cfg.hooks.stop) cfg.hooks.stop = {};

    if (cfg.stop.enabled !== undefined) {
      cfg.hooks.stop.enabled = cfg.stop.enabled;
    }
    // Move reviewer to reviewer.onStop
    if (cfg.stop.reviewer) {
      if (!cfg.reviewer) cfg.reviewer = {};
      if (!cfg.reviewer.onStop) cfg.reviewer.onStop = {};
      if (cfg.stop.reviewer.enabled !== undefined) {
        cfg.reviewer.onStop.enabled = cfg.stop.reviewer.enabled;
      }
      if (cfg.stop.reviewer.prompt) {
        cfg.reviewer.onStop.prompt = cfg.stop.reviewer.prompt;
      }
    }
    // Migrate maxOutputChars to format.maxOutputChars
    if (cfg.stop.maxOutputChars) {
      if (!cfg.format) cfg.format = {};
      cfg.format.maxOutputChars = cfg.stop.maxOutputChars;
    }
    delete cfg.stop;
  }

  // Migrate hooks.stop.reviewer → reviewer.onStop
  if (cfg.hooks?.stop?.reviewer) {
    if (!cfg.reviewer) cfg.reviewer = {};
    if (!cfg.reviewer.onStop) cfg.reviewer.onStop = {};
    if (cfg.hooks.stop.reviewer.enabled !== undefined) {
      cfg.reviewer.onStop.enabled = cfg.hooks.stop.reviewer.enabled;
    }
    if (cfg.hooks.stop.reviewer.prompt) {
      cfg.reviewer.onStop.prompt = cfg.hooks.stop.reviewer.prompt;
    }
    delete cfg.hooks.stop.reviewer;
  }

  // Migrate flat reviewer → reviewer.onStop
  if (cfg.reviewer && (cfg.reviewer.enabled !== undefined || cfg.reviewer.prompt) && !cfg.reviewer.onStop) {
    const enabled = cfg.reviewer.enabled;
    const prompt = cfg.reviewer.prompt;
    cfg.reviewer = {
      onStop: {
        enabled: enabled !== undefined ? enabled : true,
        prompt: prompt,
      },
    };
  }

  // Simplify beads config - remove implementation details
  if (cfg.beads) {
    const wasEnabled = cfg.beads.enabled;
    cfg.beads = { enabled: wasEnabled !== false };
  }

  return cfg;
}

function loadEffectiveConfig(projectDir, defaultFn) {
  const home = os.homedir();
  const baseDir = path.join(home, ".claude", "prove_it");
  const globalCfgPath = path.join(baseDir, "config.json");

  // Start with defaults
  let cfg = defaultFn();

  // Layer 1: Global user config (~/.claude/prove_it/config.json)
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

/**
 * Load run tracking data from prove_it.local.json
 */
function loadRunData(localCfgPath) {
  const data = loadJson(localCfgPath);
  return data?.runs || {};
}

/**
 * Save run tracking data to prove_it.local.json
 */
function saveRunData(localCfgPath, runKey, runData) {
  const data = loadJson(localCfgPath) || {};
  if (!data.runs) data.runs = {};
  data.runs[runKey] = runData;
  writeJson(localCfgPath, data);
}

// ============================================================================
// Checkpoint introspection
// ============================================================================

/**
 * Get the session ID from environment or return null.
 */
function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || null;
}

/**
 * Get the path to the session JSONL file.
 */
function getSessionJsonlPath(projectDir) {
  const sessionId = getSessionId();
  if (!sessionId) return null;

  const home = os.homedir();
  // Encode project path: /Users/foo/bar -> -Users-foo-bar
  const encoded = projectDir.replace(/\//g, "-").replace(/^-/, "-");
  return path.join(home, ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

/**
 * Get the file history directory for the current session.
 */
function getFileHistoryDir() {
  const sessionId = getSessionId();
  if (!sessionId) return null;

  const home = os.homedir();
  return path.join(home, ".claude", "file-history", sessionId);
}

/**
 * Read the latest file-history-snapshot from the session JSONL.
 * Returns: { messageId, trackedFileBackups: { [filePath]: { backupFileName, version } } }
 */
function getLatestSnapshot(projectDir) {
  const jsonlPath = getSessionJsonlPath(projectDir);
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;

  try {
    const content = fs.readFileSync(jsonlPath, "utf8");
    const lines = content.trim().split("\n").reverse(); // Most recent first

    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "file-history-snapshot" && entry.snapshot) {
        return entry.snapshot;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Get list of files edited since a given snapshot messageId.
 * If previousMessageId is null, returns all tracked files.
 */
function getEditedFilesSince(projectDir, previousMessageId) {
  const currentSnapshot = getLatestSnapshot(projectDir);
  if (!currentSnapshot) return [];

  const currentFiles = Object.keys(currentSnapshot.trackedFileBackups || {});

  if (!previousMessageId) {
    return currentFiles;
  }

  // Find the previous snapshot and compare
  const jsonlPath = getSessionJsonlPath(projectDir);
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return currentFiles;

  try {
    const content = fs.readFileSync(jsonlPath, "utf8");
    const lines = content.trim().split("\n");

    let previousSnapshot = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "file-history-snapshot" && entry.snapshot?.messageId === previousMessageId) {
        previousSnapshot = entry.snapshot;
        break;
      }
    }

    if (!previousSnapshot) return currentFiles;

    // Files that are new or have different versions
    const previousBackups = previousSnapshot.trackedFileBackups || {};
    const currentBackups = currentSnapshot.trackedFileBackups || {};
    const editedFiles = [];

    for (const [filePath, info] of Object.entries(currentBackups)) {
      const prev = previousBackups[filePath];
      if (!prev || prev.version !== info.version) {
        editedFiles.push(filePath);
      }
    }

    return editedFiles;
  } catch {
    return currentFiles;
  }
}

/**
 * Generate diffs for edited files since last snapshot.
 * Returns: [{ file, diff }]
 */
function generateDiffsSince(projectDir, previousMessageId, maxChars) {
  const editedFiles = getEditedFilesSince(projectDir, previousMessageId);
  if (editedFiles.length === 0) return [];

  const fileHistoryDir = getFileHistoryDir();
  const currentSnapshot = getLatestSnapshot(projectDir);
  if (!currentSnapshot || !fileHistoryDir) return [];

  const diffs = [];
  let totalChars = 0;
  const perFileLimit = Math.floor(maxChars / Math.max(editedFiles.length, 1));

  for (const filePath of editedFiles) {
    const info = currentSnapshot.trackedFileBackups[filePath];
    if (!info) continue;

    // Get backup file (original content before edits)
    const backupPath = path.join(fileHistoryDir, info.backupFileName);
    if (!fs.existsSync(backupPath)) continue;

    // Get current file content
    const currentPath = path.isAbsolute(filePath) ? filePath : path.join(projectDir, filePath);
    if (!fs.existsSync(currentPath)) continue;

    try {
      const backupContent = fs.readFileSync(backupPath, "utf8");
      const currentContent = fs.readFileSync(currentPath, "utf8");

      // Generate unified diff
      const diff = generateUnifiedDiff(filePath, backupContent, currentContent);

      if (diff && totalChars + diff.length <= maxChars) {
        diffs.push({ file: filePath, diff });
        totalChars += diff.length;
      } else if (diff) {
        // Truncate this diff to fit
        const remaining = maxChars - totalChars;
        if (remaining > 100) {
          diffs.push({ file: filePath, diff: diff.slice(0, remaining) + "\n... (truncated)" });
        }
        break;
      }
    } catch {
      continue;
    }
  }

  return diffs;
}

/**
 * Simple unified diff generator.
 */
function generateUnifiedDiff(fileName, oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  if (oldContent === newContent) return null;

  // Simple diff: show changed lines with context
  const diff = [`--- a/${fileName}`, `+++ b/${fileName}`];
  let inHunk = false;
  let hunkStart = 0;
  let hunkLines = [];

  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine !== newLine) {
      if (!inHunk) {
        inHunk = true;
        hunkStart = Math.max(0, i - 2);
        // Add context before
        for (let j = hunkStart; j < i; j++) {
          if (oldLines[j] !== undefined) hunkLines.push(` ${oldLines[j]}`);
        }
      }
      if (oldLine !== undefined && newLine !== undefined) {
        hunkLines.push(`-${oldLine}`);
        hunkLines.push(`+${newLine}`);
      } else if (oldLine !== undefined) {
        hunkLines.push(`-${oldLine}`);
      } else if (newLine !== undefined) {
        hunkLines.push(`+${newLine}`);
      }
    } else if (inHunk) {
      hunkLines.push(` ${oldLine}`);
      // End hunk after 2 lines of context
      if (hunkLines.filter((l) => l.startsWith(" ")).length >= 2) {
        diff.push(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`);
        diff.push(...hunkLines);
        hunkLines = [];
        inHunk = false;
      }
    }
  }

  if (hunkLines.length > 0) {
    diff.push(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`);
    diff.push(...hunkLines);
  }

  return diff.length > 2 ? diff.join("\n") : null;
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Security
  shellEscape,
  // I/O
  readStdin,
  loadJson,
  writeJson,
  ensureDir,
  // Config
  mergeDeep,
  migrateConfig,
  defaultGateConfig,
  defaultBeadsConfig,
  loadEffectiveConfig,
  loadRunData,
  saveRunData,
  // Hashing
  sha256,
  // Command execution
  tryRun,
  // Git
  isGitRepo,
  gitRoot,
  gitHead,
  gitStatusHash,
  gitTrackedFiles,
  // Mtime
  getLatestMtime,
  expandGlobs,
  // Gate resolution
  resolveFastGate,
  resolveFullGate,
  gateExists,
  // Output
  emitJson,
  truncateChars,
  // Checkpoints
  getSessionId,
  getLatestSnapshot,
  getEditedFilesSince,
  generateDiffsSince,
};
