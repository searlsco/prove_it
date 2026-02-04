#!/usr/bin/env node
/**
 * prove_it CLI
 *
 * Commands:
 *   install   - Install prove-it globally (~/.claude/)
 *   uninstall - Remove prove-it from global config
 *   init      - Initialize prove-it in current repository
 *   deinit    - Remove prove-it files from current repository
 *   diagnose  - Check installation status and report issues
 *   migrate   - Upgrade config to latest version
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// Current config version
const CURRENT_CONFIG_VERSION = 4;

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
  // Check if this hook already exists (by command string)
  const groupStr = JSON.stringify(group);
  const exists = hooksObj[eventName].some((g) => JSON.stringify(g) === groupStr);
  if (!exists) {
    hooksObj[eventName].push(group);
  }
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

  // Create config if missing, or check if migration needed
  ensureDir(dstKitDir);
  const existingCfg = readJson(dstCfg);
  if (!existingCfg) {
    fs.copyFileSync(srcCfg, dstCfg);
  } else {
    const existingVersion = existingCfg._version || 1;
    if (existingVersion < CURRENT_CONFIG_VERSION) {
      log("");
      log("Note: Your config may need migration. Run: prove_it migrate");
    }
  }

  // Merge settings.json hooks
  const settingsPath = path.join(claudeDir, "settings.json");
  const settings = readJson(settingsPath) || {};
  if (!settings.hooks) settings.hooks = {};

  const hookVerifGate = path.join(dstHooksDir, "prove-it-gate.js");
  const hookSessionStart = path.join(dstHooksDir, "prove-it-session-start.js");
  const hookBeadsGate = path.join(dstHooksDir, "prove-it-beads-gate.js");

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

  // Beads enforcement for Edit/Write/NotebookEdit
  addHookGroup(settings.hooks, "PreToolUse", {
    matcher: "Edit|Write|NotebookEdit|Bash",
    hooks: [
      {
        type: "command",
        command: `node "${hookBeadsGate}"`,
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

  log("prove_it installed.");
  log(`  Global CLAUDE.md: ${dstClaudeMd}`);
  log(`  Hooks: ${dstHooksDir}`);
  log(`  Config: ${dstCfg}`);
  log(`  Settings merged: ${settingsPath}`);
  log("");
  log("════════════════════════════════════════════════════════════════════");
  log("IMPORTANT: Restart Claude Code for hooks to take effect.");
  log("════════════════════════════════════════════════════════════════════");
  log("");
  log("Next steps:");
  log("  1. Restart Claude Code (required)");
  log("  2. Run: prove_it init  in a repo to add local templates");
  log("  3. Run: prove_it diagnose  to verify installation");
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
      !serialized.includes("prove-it-session-start.js") &&
      !serialized.includes("prove-it-beads-gate.js")
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
  rmIfExists(path.join(claudeDir, "hooks", "prove-it-beads-gate.js"));

  log("prove_it uninstalled (best-effort).");
  log(`  Settings updated: ${settingsPath}`);
  log(`  Removed: ~/.claude/prove-it`);
  log(`  Removed: ~/.claude/hooks/prove-it-*.js`);
  log("");
  log("Note: CLAUDE.md was not removed automatically.");
}

// ============================================================================
// Init command
// ============================================================================

function addToGitignore(repoRoot, pattern) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let content = "";

  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
    // Check if pattern already exists
    if (content.split("\n").some((line) => line.trim() === pattern)) {
      return false; // Already present
    }
  }

  // Add pattern with a newline if needed
  if (content && !content.endsWith("\n")) {
    content += "\n";
  }
  content += pattern + "\n";
  fs.writeFileSync(gitignorePath, content);
  return true;
}

function cmdInit() {
  const repoRoot = process.cwd();
  const srcRoot = getSrcRoot();
  const tpl = path.join(srcRoot, "templates", "project");

  copyDir(tpl, repoRoot);

  // Create stub script/test if missing
  const scriptTest = path.join(repoRoot, "script", "test");
  if (!fs.existsSync(scriptTest)) {
    ensureDir(path.dirname(scriptTest));
    fs.copyFileSync(path.join(srcRoot, "templates", "script", "test"), scriptTest);
    chmodX(scriptTest);
  }

  // Add prove_it.local.json to .gitignore (it contains ephemeral run data)
  const addedToGitignore = addToGitignore(repoRoot, ".claude/prove_it.local.json");

  log("prove_it project templates copied (non-destructive).");
  log(`  Added (if missing): ${path.join(repoRoot, ".claude", "prove_it.json")} (team config)`);
  log(`  Added (if missing): ${path.join(repoRoot, ".claude", "prove_it.local.json")} (local/ephemeral)`);
  log(`  Added (if missing): ${scriptTest}`);
  if (addedToGitignore) {
    log(`  Added to .gitignore: .claude/prove_it.local.json`);
  }
  log("");
  log("Next:");
  log("  - Edit script/test to run your real test suite.");
  log("  - (Optional) Create script/test_fast for faster Stop-hook checks.");
  log("  - Fill in .claude/rules/project.md with repo-specific commands/oracles.");
  log("  - Commit .claude/prove_it.json and .claude/rules/* for team sharing.");
}

// ============================================================================
// Deinit command
// ============================================================================

// Files/directories that prove-it owns and can safely remove
const PROVE_IT_PROJECT_FILES = [
  ".claude/prove_it.json",
  ".claude/prove_it.local.json",
  ".claude/rules/project.md",
  ".claude/rules/oracles.md",
  ".claude/verification/README.md",
  ".claude/ui-evals/ui-evals.md",
];

const PROVE_IT_PROJECT_DIRS = [".claude/verification", ".claude/ui-evals", ".claude/rules"];

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

  // Check script/test - only remove if it's still the stub
  const scriptTest = path.join(repoRoot, "script", "test");
  if (fs.existsSync(scriptTest)) {
    try {
      const content = fs.readFileSync(scriptTest, "utf8");
      if (content.includes("prove-it suite gate stub")) {
        rmIfExists(scriptTest);
        removed.push("script/test");
        // Remove script/ dir if empty
        const scriptDir = path.join(repoRoot, "script");
        try {
          if (fs.readdirSync(scriptDir).length === 0) {
            fs.rmdirSync(scriptDir);
            removed.push("script/");
          }
        } catch {}
      } else {
        skipped.push("script/test (customized)");
      }
    } catch {
      skipped.push("script/test (error reading)");
    }
  }

  // Legacy: also check scripts/test
  const scriptsTest = path.join(repoRoot, "scripts", "test");
  if (fs.existsSync(scriptsTest)) {
    try {
      const content = fs.readFileSync(scriptsTest, "utf8");
      if (content.includes("prove-it suite gate stub")) {
        rmIfExists(scriptsTest);
        removed.push("scripts/test");
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

  log("prove_it project files removed.");
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
// Diagnose command
// ============================================================================

function cmdDiagnose() {
  const claudeDir = getClaudeDir();
  const repoRoot = process.cwd();
  const issues = [];

  log("prove_it diagnose\n");
  log("Global installation:");

  // Check global config
  const configPath = path.join(claudeDir, "prove-it", "config.json");
  const config = readJson(configPath);
  if (config) {
    const version = config._version || 1;
    if (version >= CURRENT_CONFIG_VERSION) {
      log(`  [x] Config exists (version ${version}): ${configPath}`);
    } else {
      log(`  [ ] Config outdated (version ${version}, current is ${CURRENT_CONFIG_VERSION}): ${configPath}`);
      issues.push("Run 'prove_it migrate' to update config");
    }
  } else {
    log(`  [ ] Config missing: ${configPath}`);
    issues.push("Run 'prove_it install' to create config");
  }

  // Check hook files
  const hookFiles = ["prove-it-gate.js", "prove-it-beads-gate.js", "prove-it-session-start.js"];
  const hooksDir = path.join(claudeDir, "hooks");
  for (const hook of hookFiles) {
    const hookPath = path.join(hooksDir, hook);
    if (fs.existsSync(hookPath)) {
      log(`  [x] Hook exists: ${hook}`);
    } else {
      log(`  [ ] Hook missing: ${hook}`);
      issues.push(`Run 'prove_it install' to create ${hook}`);
    }
  }

  // Check settings.json for hook registration
  const settingsPath = path.join(claudeDir, "settings.json");
  const settings = readJson(settingsPath);
  if (settings && settings.hooks) {
    const hasSessionStart = JSON.stringify(settings.hooks).includes("prove-it-session-start.js");
    const hasGate = JSON.stringify(settings.hooks).includes("prove-it-gate.js");
    const hasBeadsGate = JSON.stringify(settings.hooks).includes("prove-it-beads-gate.js");

    if (hasSessionStart && hasGate && hasBeadsGate) {
      log("  [x] Hooks registered in settings.json");
    } else {
      log("  [ ] Hooks not fully registered in settings.json");
      if (!hasSessionStart) issues.push("SessionStart hook not registered");
      if (!hasGate) issues.push("Gate hook not registered");
      if (!hasBeadsGate) issues.push("Beads gate hook not registered");
    }
  } else {
    log("  [ ] settings.json missing or has no hooks");
    issues.push("Run 'prove_it install' to register hooks");
  }

  log("\nCurrent repository:");

  // Check for gate scripts
  const scriptTest = path.join(repoRoot, "script", "test");
  const scriptTestFast = path.join(repoRoot, "script", "test_fast");

  if (fs.existsSync(scriptTest)) {
    log(`  [x] Full gate exists: ./script/test`);
  } else {
    log(`  [ ] Full gate missing: ./script/test`);
    issues.push("Create ./script/test for this repository");
  }

  if (fs.existsSync(scriptTestFast)) {
    log(`  [x] Fast gate exists: ./script/test_fast`);
  } else {
    log(`  [ ] Fast gate not configured (optional): ./script/test_fast`);
  }

  // Check team config
  const teamConfigPath = path.join(repoRoot, ".claude", "prove_it.json");
  if (fs.existsSync(teamConfigPath)) {
    log(`  [x] Team config exists: .claude/prove_it.json`);
  } else {
    log(`  [ ] Team config missing (optional): .claude/prove_it.json`);
  }

  // Check local config
  const localConfigPath = path.join(repoRoot, ".claude", "prove_it.local.json");
  if (fs.existsSync(localConfigPath)) {
    log(`  [x] Local config exists: .claude/prove_it.local.json`);
    const localConfig = readJson(localConfigPath);
    if (localConfig?.runs) {
      const fastRun = localConfig.runs.test_fast;
      const fullRun = localConfig.runs.test_full;
      if (fastRun) {
        const status = fastRun.pass ? "passed" : "failed";
        log(`      Last fast run: ${status} at ${new Date(fastRun.at).toISOString()}`);
      }
      if (fullRun) {
        const status = fullRun.pass ? "passed" : "failed";
        log(`      Last full run: ${status} at ${new Date(fullRun.at).toISOString()}`);
      }
    }
  } else {
    log(`  [ ] Local config missing (optional): .claude/prove_it.local.json`);
  }

  // Check .gitignore for prove_it.local.json
  const gitignorePath = path.join(repoRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
    if (gitignoreContent.includes("prove_it.local.json")) {
      log(`  [x] .gitignore includes prove_it.local.json`);
    } else {
      log(`  [ ] .gitignore missing prove_it.local.json`);
      issues.push("Add .claude/prove_it.local.json to .gitignore");
    }
  }

  // Check beads - must be a project .beads/, not the global ~/.beads/ config
  const beadsDir = path.join(repoRoot, ".beads");
  const isBeadsProject =
    fs.existsSync(beadsDir) &&
    (fs.existsSync(path.join(beadsDir, "config.yaml")) ||
      fs.existsSync(path.join(beadsDir, "beads.db")) ||
      fs.existsSync(path.join(beadsDir, "metadata.json")));
  if (isBeadsProject) {
    log("  [x] Beads directory exists: .beads/");
    log("      (beads enforcement is active for this repo)");
  } else {
    log("  [ ] Beads not initialized (optional): .beads/");
  }

  // Summary
  log("");
  if (issues.length === 0) {
    log("Status: All checks passed.");
  } else {
    log("Issues found:");
    for (const issue of issues) {
      log(`  - ${issue}`);
    }
  }
}

// ============================================================================
// Migrate command
// ============================================================================

function cmdMigrate() {
  const claudeDir = getClaudeDir();
  const configPath = path.join(claudeDir, "prove-it", "config.json");
  const config = readJson(configPath);

  if (!config) {
    log("No config found. Run 'prove_it install' first.");
    return;
  }

  const currentVersion = config._version || 1;
  log(`Current config version: ${currentVersion}`);
  log(`Latest config version: ${CURRENT_CONFIG_VERSION}`);

  if (currentVersion >= CURRENT_CONFIG_VERSION) {
    log("\nConfig is already up to date. No migration needed.");
    return;
  }

  log("\nApplying migrations...");

  // Migration v1 -> v2: scripts/test -> script/test
  if (currentVersion < 2) {
    log("  v1 -> v2: Updating default suite gate path");
    if (config.suiteGate && config.suiteGate.command === "./scripts/test") {
      config.suiteGate.command = "./script/test";
      log("    - Changed suiteGate.command from ./scripts/test to ./script/test");
    }
    config._version = 2;
  }

  // Migration v2 -> v3: permissionDecision "ask" -> "allow"
  if (config._version < 3) {
    log("  v2 -> v3: Changing permissionDecision from 'ask' to 'allow'");
    if (config.preToolUse && config.preToolUse.permissionDecision === "ask") {
      config.preToolUse.permissionDecision = "allow";
      log("    - Suite gate provides safety; no need to also require user confirmation");
    }
    config._version = 3;
  }

  // Migration v3 -> v4: suiteGate -> commands.test, remove git push from gated commands
  if (config._version < 4) {
    log("  v3 -> v4: Migrating to new config structure");

    // Migrate suiteGate to commands.test
    if (config.suiteGate) {
      if (!config.commands) config.commands = {};
      if (!config.commands.test) config.commands.test = {};

      if (config.suiteGate.command) {
        config.commands.test.full = config.suiteGate.command;
        log(`    - Moved suiteGate.command to commands.test.full: ${config.suiteGate.command}`);
      }
      delete config.suiteGate;
    }

    // Remove git push from gatedCommandRegexes (commit is sufficient)
    if (config.preToolUse?.gatedCommandRegexes) {
      const before = config.preToolUse.gatedCommandRegexes.length;
      config.preToolUse.gatedCommandRegexes = config.preToolUse.gatedCommandRegexes.filter(
        (re) => !re.includes("git\\s+push")
      );
      const after = config.preToolUse.gatedCommandRegexes.length;
      if (before !== after) {
        log("    - Removed git push from gated commands (commit already runs full gate)");
      }
    }

    // Remove cacheSeconds (replaced by mtime-based caching)
    if (config.stop?.cacheSeconds !== undefined) {
      delete config.stop.cacheSeconds;
      log("    - Removed cacheSeconds (replaced by mtime-based caching)");
    }

    config._version = 4;
  }

  // Write updated config
  writeJsonWithBackup(configPath, config);
  log(`\nMigration complete. Config updated to version ${CURRENT_CONFIG_VERSION}.`);
  log("");
  log("New config structure:");
  log("  - commands.test.full: Full test suite (runs on commit)");
  log("  - commands.test.fast: Fast tests (runs on Stop, optional)");
  log("  - sources: Glob patterns for source files to track (optional)");
  log("");
  log("Conventions:");
  log("  - ./script/test: Full test suite (default)");
  log("  - ./script/test_fast: Fast tests for Stop hook (optional)");
}

// ============================================================================
// Main CLI
// ============================================================================

function showHelp() {
  log(`prove_it - Verifiability-first hooks for Claude Code

Usage: prove_it <command>

Commands:
  install     Install prove_it globally (~/.claude/)
  uninstall   Remove prove_it from global config
  init        Initialize prove_it in current repository
  deinit      Remove prove_it files from current repository
  diagnose    Check installation status and report issues
  migrate     Upgrade config to latest version
  help        Show this help message
  -v, --version  Show version number

Examples:
  prove_it install      # Set up global hooks
  prove_it init         # Add templates to current repo
  prove_it diagnose     # Check installation status
  prove_it deinit       # Remove prove_it from current repo
  prove_it uninstall    # Remove global hooks
`);
}

function getVersion() {
  const pkg = readJson(path.join(__dirname, "package.json"));
  return pkg?.version || "unknown";
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
    case "diagnose":
      cmdDiagnose();
      break;
    case "migrate":
      cmdMigrate();
      break;
    case "-v":
    case "--version":
    case "version":
      log(getVersion());
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "prove_it help" for usage.');
      process.exit(1);
  }
}

main();
