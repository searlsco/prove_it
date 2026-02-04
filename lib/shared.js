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

function gitStatus(dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} status --porcelain=v1`, {});
  if (r.code !== 0) return null;
  return r.stdout;
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

function tailLines(s, n) {
  const lines = s.split(/\r?\n/);
  const tail = lines.slice(Math.max(0, lines.length - n));
  return tail.join("\n").trimEnd();
}

function truncateChars(s, maxChars) {
  if (s.length <= maxChars) return s;
  return s.slice(-maxChars);
}

// ============================================================================
// Time utilities
// ============================================================================

function nowIso() {
  return new Date().toISOString();
}

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

function defaultBeadsConfig() {
  return {
    beads: {
      enabled: true,
      gatedTools: ["Edit", "Write", "NotebookEdit"],
      gateBashWrites: true,
      bashWritePatterns: [
        "\\bcat\\s+.*>",
        "\\becho\\s+.*>",
        "\\btee\\s",
        "\\bsed\\s+-i",
        "\\bawk\\s+.*-i\\s*inplace",
      ],
    },
  };
}

/**
 * Migrate old config format to new format.
 * Old: suiteGate.command, suiteGate.require
 * New: commands.test.full, commands.test.fast
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
  gitStatus,
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
  tailLines,
  truncateChars,
  // Time
  nowIso,
};
