#!/usr/bin/env node
/**
 * prove-it CLI
 *
 * Commands:
 *   install   - Install prove-it globally (~/.claude/)
 *   uninstall - Remove prove-it from global config
 *   init      - Initialize prove-it in current repository
 *   deinit    - Remove prove-it files from current repository
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// ============================================================================
// Shared utilities
// ============================================================================

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function writeJsonWithBackup(p, obj) {
  if (fs.existsSync(p)) {
    const backup = `${p}.bak-${nowStamp()}`;
    fs.copyFileSync(p, backup);
  }
  writeJson(p, obj);
}

function copyFileWithBackup(src, dst) {
  if (fs.existsSync(dst)) {
    const backup = `${dst}.bak-${nowStamp()}`;
    fs.copyFileSync(dst, backup);
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst, overwrite = false) {
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDir(s, d, overwrite);
    } else {
      if (!overwrite && fs.existsSync(d)) continue;
      fs.copyFileSync(s, d);
    }
  }
}

function rmIfExists(p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function chmodX(p) {
  try {
    fs.chmodSync(p, 0o755);
  } catch {}
}

function log(...args) {
  console.log(...args);
}

function getClaudeDir() {
  return path.join(os.homedir(), ".claude");
}

function getSrcRoot() {
  return __dirname;
}

// ============================================================================
// Install command
// ============================================================================

function addHookGroup(hooksObj, eventName, group) {
  if (!hooksObj[eventName]) hooksObj[eventName] = [];
  hooksObj[eventName].push(group);
}

function cmdInstall() {
  const claudeDir = getClaudeDir();
  const srcRoot = getSrcRoot();
  const globalDir = path.join(srcRoot, "global");

  const dstClaudeMd = path.join(claudeDir, "CLAUDE.md");
  const srcClaudeMd = path.join(globalDir, "CLAUDE.md");

  const dstHooksDir = path.join(claudeDir, "hooks");
  const srcHooksDir = path.join(globalDir, "hooks");

  const dstKitDir = path.join(claudeDir, "prove-it");
  const srcCfg = path.join(globalDir, "prove-it", "config.json");
  const dstCfg = path.join(dstKitDir, "config.json");

  // Copy CLAUDE.md
  copyFileWithBackup(srcClaudeMd, dstClaudeMd);

  // Copy hooks
  ensureDir(dstHooksDir);
  for (const f of fs.readdirSync(srcHooksDir)) {
    const src = path.join(srcHooksDir, f);
    const dst = path.join(dstHooksDir, f);
    copyFileWithBackup(src, dst);
    chmodX(dst);
  }

  // Create config if missing
  ensureDir(dstKitDir);
  if (!fs.existsSync(dstCfg)) {
    fs.copyFileSync(srcCfg, dstCfg);
  }

  // Merge settings.json hooks
  const settingsPath = path.join(claudeDir, "settings.json");
  const settings = readJson(settingsPath) || {};
  if (!settings.hooks) settings.hooks = {};

  const hookVerifGate = path.join(dstHooksDir, "prove-it-gate.js");
  const hookSessionStart = path.join(dstHooksDir, "prove-it-session-start.js");

  addHookGroup(settings.hooks, "SessionStart", {
    matcher: "startup|resume|clear|compact",
    hooks: [
      {
        type: "command",
        command: `node "${hookSessionStart}"`,
      },
    ],
  });

  addHookGroup(settings.hooks, "PreToolUse", {
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: `node "${hookVerifGate}"`,
      },
    ],
  });

  addHookGroup(settings.hooks, "Stop", {
    hooks: [
      {
        type: "command",
        command: `node "${hookVerifGate}"`,
        timeout: 3600,
      },
    ],
  });

  writeJsonWithBackup(settingsPath, settings);

  log("prove-it installed.");
  log(`  Global CLAUDE.md: ${dstClaudeMd}`);
  log(`  Hooks: ${dstHooksDir}`);
  log(`  Config: ${dstCfg}`);
  log(`  Settings merged: ${settingsPath}`);
  log("");
  log("Next:");
  log("  - Restart Claude Code (hooks snapshot at startup).");
  log("  - (Optional) Run: prove-it init  in a repo to add local templates.");
}

// ============================================================================
// Uninstall command
// ============================================================================

function removeProveItGroups(groups) {
  if (!Array.isArray(groups)) return groups;
  return groups.filter((g) => {
    const hooks = g && g.hooks ? g.hooks : [];
    const serialized = JSON.stringify(hooks);
    return (
      !serialized.includes("prove-it-gate.js") &&
      !serialized.includes("prove-it-session-start.js")
    );
  });
}

function cmdUninstall() {
  const claudeDir = getClaudeDir();
  const settingsPath = path.join(claudeDir, "settings.json");
  const settings = readJson(settingsPath);

  if (settings && settings.hooks) {
    for (const k of Object.keys(settings.hooks)) {
      settings.hooks[k] = removeProveItGroups(settings.hooks[k]);
      if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
        delete settings.hooks[k];
      }
    }
    writeJsonWithBackup(settingsPath, settings);
  }

  // Remove prove-it files (best-effort)
  rmIfExists(path.join(claudeDir, "prove-it"));
  rmIfExists(path.join(claudeDir, "hooks", "prove-it-gate.js"));
  rmIfExists(path.join(claudeDir, "hooks", "prove-it-session-start.js"));

  log("prove-it uninstalled (best-effort).");
  log(`  Settings updated: ${settingsPath}`);
  log(`  Removed: ~/.claude/prove-it`);
  log(`  Removed: ~/.claude/hooks/prove-it-*.js`);
  log("");
  log("Note: CLAUDE.md was not removed automatically.");
}

// ============================================================================
// Init command
// ============================================================================

function cmdInit() {
  const repoRoot = process.cwd();
  const srcRoot = getSrcRoot();
  const tpl = path.join(srcRoot, "templates", "project");

  copyDir(tpl, repoRoot);

  // Create stub scripts/test if missing
  const scriptsTest = path.join(repoRoot, "scripts", "test");
  if (!fs.existsSync(scriptsTest)) {
    ensureDir(path.dirname(scriptsTest));
    fs.copyFileSync(path.join(srcRoot, "templates", "scripts", "test"), scriptsTest);
    chmodX(scriptsTest);
  }

  log("prove-it project templates copied (non-destructive).");
  log(`  Added (if missing): ${path.join(repoRoot, ".claude")}`);
  log(`  Added (if missing): ${scriptsTest}`);
  log("");
  log("Next:");
  log("  - Edit scripts/test to run your real suite gate.");
  log("  - Fill in .claude/rules/project.md with repo-specific commands/oracles.");
  log("  - (Optional) Commit .claude/rules/* and .claude/ui-evals/* for team sharing.");
}

// ============================================================================
// Deinit command
// ============================================================================

// Files/directories that prove-it owns and can safely remove
const PROVE_IT_PROJECT_FILES = [
  ".claude/verifiability.local.json",
  ".claude/rules/project.md",
  ".claude/rules/oracles.md",
  ".claude/verification/README.md",
  ".claude/ui-evals/ui-evals.md",
];

const PROVE_IT_PROJECT_DIRS = [
  ".claude/verification",
  ".claude/ui-evals",
  ".claude/rules",
];

function cmdDeinit() {
  const repoRoot = process.cwd();
  const removed = [];
  const skipped = [];

  // Remove files we created
  for (const relPath of PROVE_IT_PROJECT_FILES) {
    const absPath = path.join(repoRoot, relPath);
    if (fs.existsSync(absPath)) {
      rmIfExists(absPath);
      removed.push(relPath);
    }
  }

  // Remove directories if empty
  for (const relPath of PROVE_IT_PROJECT_DIRS) {
    const absPath = path.join(repoRoot, relPath);
    if (fs.existsSync(absPath)) {
      try {
        const contents = fs.readdirSync(absPath);
        if (contents.length === 0) {
          fs.rmdirSync(absPath);
          removed.push(relPath + "/");
        } else {
          skipped.push(`${relPath}/ (not empty)`);
        }
      } catch {
        skipped.push(`${relPath}/ (error)`);
      }
    }
  }

  // Check scripts/test - only remove if it's still the stub
  const scriptsTest = path.join(repoRoot, "scripts", "test");
  if (fs.existsSync(scriptsTest)) {
    try {
      const content = fs.readFileSync(scriptsTest, "utf8");
      if (content.includes("prove-it suite gate stub")) {
        rmIfExists(scriptsTest);
        removed.push("scripts/test");
        // Remove scripts/ dir if empty
        const scriptsDir = path.join(repoRoot, "scripts");
        try {
          if (fs.readdirSync(scriptsDir).length === 0) {
            fs.rmdirSync(scriptsDir);
            removed.push("scripts/");
          }
        } catch {}
      } else {
        skipped.push("scripts/test (customized)");
      }
    } catch {
      skipped.push("scripts/test (error reading)");
    }
  }

  // Try to remove .claude/ if empty
  const claudeDir = path.join(repoRoot, ".claude");
  if (fs.existsSync(claudeDir)) {
    try {
      const contents = fs.readdirSync(claudeDir);
      if (contents.length === 0) {
        fs.rmdirSync(claudeDir);
        removed.push(".claude/");
      }
    } catch {}
  }

  log("prove-it project files removed.");
  if (removed.length > 0) {
    log("  Removed:");
    for (const f of removed) log(`    - ${f}`);
  }
  if (skipped.length > 0) {
    log("  Skipped:");
    for (const f of skipped) log(`    - ${f}`);
  }
  if (removed.length === 0 && skipped.length === 0) {
    log("  (nothing to remove)");
  }
}

// ============================================================================
// Main CLI
// ============================================================================

function showHelp() {
  log(`prove-it - Verifiability-first hooks for Claude Code

Usage: prove-it <command>

Commands:
  install     Install prove-it globally (~/.claude/)
  uninstall   Remove prove-it from global config
  init        Initialize prove-it in current repository
  deinit      Remove prove-it files from current repository
  help        Show this help message

Examples:
  prove-it install      # Set up global hooks
  prove-it init         # Add templates to current repo
  prove-it deinit       # Remove prove-it from current repo
  prove-it uninstall    # Remove global hooks
`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "install":
      cmdInstall();
      break;
    case "uninstall":
      cmdUninstall();
      break;
    case "init":
      cmdInit();
      break;
    case "deinit":
      cmdDeinit();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "prove-it help" for usage.');
      process.exit(1);
  }
}

main();
