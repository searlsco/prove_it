const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// Safely escape a string for shell use with single quotes.
// This is the safest way to pass arbitrary strings to shell commands.
function shellEscape(str) {
  if (typeof str !== "string") return String(str);
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

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

function mergeDeep(a, b) {
  if (b === undefined || b === null) return a;
  if (Array.isArray(a) && Array.isArray(b)) return b;
  if (typeof a === "object" && a && typeof b === "object" && b) {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = mergeDeep(a[k], b[k]);
    return out;
  }
  return b;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
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

function getLatestMtime(rootDir, globs) {
  let files = globs && globs.length > 0
    ? expandGlobs(rootDir, globs)
    : gitTrackedFiles(rootDir);

  let maxMtime = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(rootDir, file));
      if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
    } catch {}
  }
  return maxMtime;
}

function expandGlobs(rootDir, globs) {
  const files = new Set();
  for (const glob of globs) {
    walkDir(rootDir, rootDir, globToRegex(glob), files);
  }
  return Array.from(files);
}

function globToRegex(glob) {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, "{{GLOBSTAR}}");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/\?/g, ".");
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
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      walkDir(baseDir, fullPath, pattern, files);
    } else if (entry.isFile() && pattern.test(relativePath)) {
      files.add(relativePath);
    }
  }
}

// Priority: explicit config > script/test_fast > full tests
function resolveFastTests(rootDir, cfg) {
  if (cfg.commands?.test?.fast) return cfg.commands.test.fast;
  if (fs.existsSync(path.join(rootDir, "script", "test_fast"))) return "./script/test_fast";
  return resolveFullTests(rootDir, cfg);
}

// Priority: explicit config > script/test > script/test_slow
function resolveFullTests(rootDir, cfg) {
  if (cfg.commands?.test?.full) return cfg.commands.test.full;
  if (fs.existsSync(path.join(rootDir, "script", "test"))) return "./script/test";
  if (fs.existsSync(path.join(rootDir, "script", "test_slow"))) return "./script/test_slow";
  return "./script/test";
}

function testScriptExists(rootDir, testCmd) {
  if (!testCmd) return false;
  if (testCmd.startsWith("./script/") || testCmd.startsWith("./scripts/")) {
    return fs.existsSync(path.join(rootDir, testCmd.slice(2)));
  }
  return true;
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function truncateChars(s, maxChars) {
  if (s.length <= maxChars) return s;
  return s.slice(-maxChars);
}

function defaultTestConfig() {
  return {
    commands: { test: { full: null, fast: null } },
    sources: null,
    hooks: {
      done: {
        enabled: true,
        commandPatterns: [
          "(^|\\s)git\\s+commit\\b",
          "(^|\\s)(beads|bd)\\s+(done|finish|close)\\b",
        ],
      },
      stop: { enabled: true },
    },
    reviewer: {
      onStop: { enabled: true },
      onDone: { enabled: true },
    },
    format: { maxOutputChars: 12000 },
  };
}

function defaultBeadsConfig() {
  return { beads: { enabled: true } };
}

function loadGlobalConfig() {
  return loadJson(path.join(os.homedir(), ".claude", "prove_it", "config.json")) || {};
}

function isIgnoredPath(projectDir, ignoredPaths) {
  if (!ignoredPaths || !Array.isArray(ignoredPaths) || ignoredPaths.length === 0) {
    return false;
  }

  const home = os.homedir();
  const normalizedProject = path.resolve(projectDir);

  for (const ignored of ignoredPaths) {
    const normalizedIgnored = ignored.startsWith("~/")
      ? path.resolve(path.join(home, ignored.slice(2)))
      : path.resolve(ignored);

    if (normalizedProject === normalizedIgnored || normalizedProject.startsWith(normalizedIgnored + path.sep)) {
      return true;
    }
  }
  return false;
}

function loadEffectiveConfig(projectDir, defaultFn) {
  const home = os.homedir();
  const baseDir = path.join(home, ".claude", "prove_it");
  const globalCfgPath = path.join(baseDir, "config.json");
  const localCfgPath = path.join(projectDir, ".claude", "prove_it.local.json");

  let cfg = defaultFn();

  const globalCfg = loadJson(globalCfgPath);
  if (globalCfg) cfg = mergeDeep(cfg, globalCfg);

  const teamCfg = loadJson(path.join(projectDir, ".claude", "prove_it.json"));
  if (teamCfg) cfg = mergeDeep(cfg, teamCfg);

  const localCfg = loadJson(localCfgPath);
  if (localCfg) cfg = mergeDeep(cfg, localCfg);

  return { cfg, baseDir, localCfgPath };
}

function loadRunData(localCfgPath) {
  const data = loadJson(localCfgPath);
  return data?.runs || {};
}

function saveRunData(localCfgPath, runKey, runData) {
  const data = loadJson(localCfgPath) || {};
  if (!data.runs) data.runs = {};
  data.runs[runKey] = runData;
  writeJson(localCfgPath, data);
}

function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || null;
}

function getSessionJsonlPath(projectDir) {
  const sessionId = getSessionId();
  if (!sessionId) return null;
  const encoded = projectDir.replace(/\//g, "-").replace(/^-/, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

function getFileHistoryDir() {
  const sessionId = getSessionId();
  if (!sessionId) return null;
  return path.join(os.homedir(), ".claude", "file-history", sessionId);
}

function getLatestSnapshot(projectDir) {
  const jsonlPath = getSessionJsonlPath(projectDir);
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;

  try {
    const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "file-history-snapshot" && entry.snapshot) {
        return entry.snapshot;
      }
    }
  } catch {}
  return null;
}

function getEditedFilesSince(projectDir, previousMessageId) {
  const currentSnapshot = getLatestSnapshot(projectDir);
  if (!currentSnapshot) return [];

  const currentFiles = Object.keys(currentSnapshot.trackedFileBackups || {});
  if (!previousMessageId) return currentFiles;

  const jsonlPath = getSessionJsonlPath(projectDir);
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return currentFiles;

  try {
    const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
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

function generateDiffsSince(projectDir, previousMessageId, maxChars) {
  const editedFiles = getEditedFilesSince(projectDir, previousMessageId);
  if (editedFiles.length === 0) return [];

  const fileHistoryDir = getFileHistoryDir();
  const currentSnapshot = getLatestSnapshot(projectDir);
  if (!currentSnapshot || !fileHistoryDir) return [];

  const diffs = [];
  let totalChars = 0;

  for (const filePath of editedFiles) {
    const info = currentSnapshot.trackedFileBackups[filePath];
    if (!info) continue;

    const backupPath = path.join(fileHistoryDir, info.backupFileName);
    if (!fs.existsSync(backupPath)) continue;

    const currentPath = path.isAbsolute(filePath) ? filePath : path.join(projectDir, filePath);
    if (!fs.existsSync(currentPath)) continue;

    try {
      const backupContent = fs.readFileSync(backupPath, "utf8");
      const currentContent = fs.readFileSync(currentPath, "utf8");
      const diff = generateUnifiedDiff(filePath, backupContent, currentContent);

      if (diff && totalChars + diff.length <= maxChars) {
        diffs.push({ file: filePath, diff });
        totalChars += diff.length;
      } else if (diff) {
        const remaining = maxChars - totalChars;
        if (remaining > 100) {
          diffs.push({ file: filePath, diff: diff.slice(0, remaining) + "\n... (truncated)" });
        }
        break;
      }
    } catch {}
  }
  return diffs;
}

function generateUnifiedDiff(fileName, oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  if (oldContent === newContent) return null;

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

module.exports = {
  shellEscape,
  readStdin,
  loadJson,
  writeJson,
  ensureDir,
  mergeDeep,
  defaultTestConfig,
  defaultBeadsConfig,
  loadGlobalConfig,
  isIgnoredPath,
  loadEffectiveConfig,
  loadRunData,
  saveRunData,
  sha256,
  tryRun,
  isGitRepo,
  gitRoot,
  gitHead,
  gitStatusHash,
  gitTrackedFiles,
  getLatestMtime,
  expandGlobs,
  resolveFastTests,
  resolveFullTests,
  testScriptExists,
  emitJson,
  truncateChars,
  getSessionId,
  getLatestSnapshot,
  getEditedFilesSince,
  generateDiffsSince,
};
