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
  if (!b) return a;
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
    suiteGate: {
      command: "./script/test",
      require: true,
    },
    preToolUse: {
      enabled: true,
      permissionDecision: "ask",
      gatedCommandRegexes: [
        "(^|\\s)git\\s+commit\\b",
        "(^|\\s)git\\s+push\\b",
        "(^|\\s)(beads|bd)\\s+(done|finish|close)\\b",
      ],
    },
    stop: {
      enabled: true,
      cacheSeconds: 900,
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

function loadEffectiveConfig(projectDir, defaultFn) {
  const home = os.homedir();
  const baseDir = path.join(home, ".claude", "prove-it");
  const globalCfgPath = path.join(baseDir, "config.json");

  let cfg = defaultFn();
  cfg = mergeDeep(cfg, loadJson(globalCfgPath));

  // Per-project override (optional)
  const localCfgPath = path.join(projectDir, ".claude", "verifiability.local.json");
  cfg = mergeDeep(cfg, loadJson(localCfgPath));

  return { cfg, baseDir };
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
  defaultGateConfig,
  defaultBeadsConfig,
  loadEffectiveConfig,
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
  // Output
  emitJson,
  tailLines,
  truncateChars,
  // Time
  nowIso,
};
