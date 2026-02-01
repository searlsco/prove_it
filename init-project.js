#!/usr/bin/env node
/**
 * CCVK project initializer
 *
 * Copies templates into the current repository to bootstrap per-project assets.
 */
const fs = require("fs");
const path = require("path");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else {
      if (fs.existsSync(d)) continue; // do not overwrite
      fs.copyFileSync(s, d);
    }
  }
}

function chmodX(p) {
  try { fs.chmodSync(p, 0o755); } catch {}
}

function main() {
  const repoRoot = process.cwd();
  const srcRoot = __dirname;
  const tpl = path.join(srcRoot, "templates", "project");

  copyDir(tpl, repoRoot);

  // Create stub scripts/test if missing
  const scriptsTest = path.join(repoRoot, "scripts", "test");
  if (!fs.existsSync(scriptsTest)) {
    ensureDir(path.dirname(scriptsTest));
    fs.copyFileSync(path.join(srcRoot, "templates", "scripts", "test"), scriptsTest);
    chmodX(scriptsTest);
  }

  process.stdout.write(
    [
      "CCVK project templates copied (non-destructive).",
      `- Added (if missing): ${path.join(repoRoot, ".claude")}`,
      `- Added (if missing): ${scriptsTest}`,
      "",
      "Next:",
      "- Edit scripts/test to run your real suite gate.",
      "- Fill in .claude/rules/project.md with repo-specific commands/oracles.",
      "- (Optional) Commit .claude/rules/* and .claude/ui-evals/* for team sharing."
    ].join("\n") + "\n"
  );
}

main();
