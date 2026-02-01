#!/usr/bin/env node
/**
 * prove-it: SessionStart hook
 * - Records baseline git state for this session_id
 * - Optionally injects a small reminder into Claude's context
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  readStdin,
  ensureDir,
  isGitRepo,
  gitRoot,
  gitHead,
  gitStatusHash,
  emitJson,
} = require("../lib/shared");

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch (e) {
    // For SessionStart, failing to parse is less critical
    // Just log warning and continue without recording baseline
    console.error(`prove-it: Failed to parse SessionStart input: ${e.message}`);
    process.exit(0);
  }

  const sessionId = input.session_id || "unknown";
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  const home = os.homedir();
  const baseDir = path.join(home, ".claude", "prove-it");
  const sessionsDir = path.join(baseDir, "sessions");
  ensureDir(sessionsDir);

  let root = projectDir;
  let head = null;
  let statusHash = null;
  if (isGitRepo(projectDir)) {
    root = gitRoot(projectDir) || projectDir;
    head = gitHead(root);
    statusHash = gitStatusHash(root);
  }

  const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
  const payload = {
    session_id: sessionId,
    project_dir: projectDir,
    root_dir: root,
    started_at: new Date().toISOString(),
    git: {
      is_repo: isGitRepo(projectDir),
      root,
      head,
      status_hash: statusHash,
    },
  };

  try {
    fs.writeFileSync(sessionFile, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // ignore
  }

  // Add minimal context (stdout becomes context for SessionStart)
  const reminder = [
    "prove-it active: verifiability-first.",
    "Do not claim 'done' unless the suite gate passed (default: ./script/test).",
    "Prefer suite verification over ad-hoc scripts; if unverified, label UNVERIFIED.",
  ].join("\n");

  // For SessionStart, stdout is appended to Claude context.
  process.stdout.write(reminder);
}

main();
