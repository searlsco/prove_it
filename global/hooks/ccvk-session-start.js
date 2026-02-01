#!/usr/bin/env node
/**
 * CCVK: SessionStart hook
 * - Records baseline git state for this session_id
 * - Optionally injects a small reminder into Claude's context
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function tryRun(cmd, opts) {
  const r = spawnSync(cmd, { ...opts, shell: true, encoding: "utf8" });
  return { code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function isGitRepo(dir) {
  const r = tryRun(`git -C "${dir}" rev-parse --is-inside-work-tree`, {});
  return r.code === 0 && r.stdout.trim() === "true";
}

function gitRoot(dir) {
  const r = tryRun(`git -C "${dir}" rev-parse --show-toplevel`, {});
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

function gitHead(dir) {
  const r = tryRun(`git -C "${dir}" rev-parse HEAD`, {});
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

function gitStatusHash(dir) {
  const r = tryRun(`git -C "${dir}" status --porcelain=v1`, {});
  if (r.code !== 0) return null;
  return sha256(r.stdout);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    process.exit(0);
  }

  const sessionId = input.session_id || "unknown";
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  const home = os.homedir();
  const baseDir = path.join(home, ".claude", "verifiability-kit");
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
      status_hash: statusHash
    }
  };

  try {
    fs.writeFileSync(sessionFile, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // ignore
  }

  // Add minimal context (stdout becomes context for SessionStart)
  const reminder = [
    "CCVK active: verifiability-first.",
    "Do not claim 'done' unless the suite gate passed (default: ./scripts/test).",
    "Prefer suite verification over ad-hoc scripts; if unverified, label UNVERIFIED."
  ].join("\n");

  // For SessionStart, stdout is appended to Claude context.
  process.stdout.write(reminder);
}

main();
