#!/usr/bin/env node
/**
 * CCVK uninstaller (best-effort)
 *
 * - Removes CCVK hook handlers from ~/.claude/settings.json
 * - Optionally removes CCVK files under ~/.claude/hooks and ~/.claude/verifiability-kit
 *
 * Leaves backups for any modified files.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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

function removeCcvkGroups(groups) {
  if (!Array.isArray(groups)) return groups;
  return groups.filter((g) => {
    const hooks = (g && g.hooks) ? g.hooks : [];
    const serialized = JSON.stringify(hooks);
    return !serialized.includes("ccvk-verifiability-gate.js") && !serialized.includes("ccvk-session-start.js");
  });
}

function rmIfExists(p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function main() {
  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  const settings = readJson(settingsPath);

  if (settings && settings.hooks) {
    for (const k of Object.keys(settings.hooks)) {
      settings.hooks[k] = removeCcvkGroups(settings.hooks[k]);
      if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) delete settings.hooks[k];
    }
    writeJsonWithBackup(settingsPath, settings);
  }

  // Remove CCVK files (best-effort)
  rmIfExists(path.join(claudeDir, "verifiability-kit"));
  // Only remove the CCVK hook scripts, not the whole hooks dir.
  rmIfExists(path.join(claudeDir, "hooks", "ccvk-verifiability-gate.js"));
  rmIfExists(path.join(claudeDir, "hooks", "ccvk-session-start.js"));

  process.stdout.write(
    [
      "CCVK uninstalled (best-effort).",
      `- Settings updated: ${settingsPath}`,
      `- Removed: ~/.claude/verifiability-kit`,
      `- Removed: ~/.claude/hooks/ccvk-*.js`,
      "",
      "Note: CLAUDE.md was not removed automatically."
    ].join("\n") + "\n"
  );
}

main();
