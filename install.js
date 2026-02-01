#!/usr/bin/env node
/**
 * CCVK installer
 *
 * - Copies global CLAUDE.md to ~/.claude/CLAUDE.md
 * - Copies hooks into ~/.claude/hooks/
 * - Creates ~/.claude/verifiability-kit/config.json if missing
 * - Merges hooks into ~/.claude/settings.json
 *
 * Makes timestamped backups of modified files.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFileWithBackup(src, dst) {
  if (fs.existsSync(dst)) {
    const backup = `${dst}.bak-${nowStamp()}`;
    fs.copyFileSync(dst, backup);
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function writeJsonWithBackup(p, obj) {
  if (fs.existsSync(p)) {
    const backup = `${p}.bak-${nowStamp()}`;
    fs.copyFileSync(p, backup);
  }
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function addHookGroup(hooksObj, eventName, group) {
  if (!hooksObj[eventName]) hooksObj[eventName] = [];
  // Append; users can reorder via /hooks if desired.
  hooksObj[eventName].push(group);
}

function main() {
  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");

  const srcRoot = __dirname;
  const globalDir = path.join(srcRoot, "global");

  const dstClaudeMd = path.join(claudeDir, "CLAUDE.md");
  const srcClaudeMd = path.join(globalDir, "CLAUDE.md");

  const dstHooksDir = path.join(claudeDir, "hooks");
  const srcHooksDir = path.join(globalDir, "hooks");

  const dstKitDir = path.join(claudeDir, "verifiability-kit");
  const srcCfg = path.join(globalDir, "verifiability-kit", "config.json");
  const dstCfg = path.join(dstKitDir, "config.json");

  // Copy CLAUDE.md
  copyFileWithBackup(srcClaudeMd, dstClaudeMd);

  // Copy hooks
  ensureDir(dstHooksDir);
  for (const f of fs.readdirSync(srcHooksDir)) {
    const src = path.join(srcHooksDir, f);
    const dst = path.join(dstHooksDir, f);
    copyFileWithBackup(src, dst);
    try { fs.chmodSync(dst, 0o755); } catch {}
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

  const hookVerifGate = path.join(dstHooksDir, "ccvk-verifiability-gate.js");
  const hookSessionStart = path.join(dstHooksDir, "ccvk-session-start.js");

  addHookGroup(settings.hooks, "SessionStart", {
    matcher: "startup|resume|clear|compact",
    hooks: [
      {
        type: "command",
        command: `node "${hookSessionStart}"`
      }
    ]
  });

  addHookGroup(settings.hooks, "PreToolUse", {
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: `node "${hookVerifGate}"`
      }
    ]
  });

  addHookGroup(settings.hooks, "Stop", {
    hooks: [
      {
        type: "command",
        command: `node "${hookVerifGate}"`,
        timeout: 3600
      }
    ]
  });

  writeJsonWithBackup(settingsPath, settings);

  process.stdout.write(
    [
      "CCVK installed.",
      `- Global CLAUDE.md: ${dstClaudeMd}`,
      `- Hooks: ${dstHooksDir}`,
      `- Config: ${dstCfg}`,
      `- Settings merged: ${settingsPath}`,
      "",
      "Next:",
      "- Restart Claude Code (hooks snapshot at startup).",
      "- (Optional) Run: node init-project.js in a repo to add local templates."
    ].join("\n") + "\n"
  );
}

main();
