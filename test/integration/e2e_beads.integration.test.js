const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  HOOKS_DIR,
} = require("./hook-harness");

/**
 * E2E test: runs claude CLI with hooks and verifies that the beads
 * enforcement hook actually prevents edits when no bead is in_progress.
 *
 * Requires claude CLI + API access.
 */

function claudeAvailable() {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0;
}

function bdAvailable() {
  const r = spawnSync("bd", ["--version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0;
}

describe("E2E: beads enforcement via claude CLI", () => {
  let tmpDir;

  beforeEach(() => {
    if (!claudeAvailable()) {
      throw new Error("claude CLI not found in PATH");
    }
    if (!bdAvailable()) {
      throw new Error("bd CLI not found in PATH");
    }

    tmpDir = createTempDir("prove_it_e2e_");
    initGitRepo(tmpDir);

    // Use real `bd init` so the database exists and `bd list` works
    spawnSync("bd", ["init", "-q"], { cwd: tmpDir, encoding: "utf8" });

    // Create a target file for claude to attempt editing
    createFile(tmpDir, "target.txt", "original content\n");

    // Initial commit so git is clean
    spawnSync("git", ["add", "."], { cwd: tmpDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tmpDir });
  });

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("denies file edit when no bead is in_progress", () => {
    const beadsHookPath = path.join(HOOKS_DIR, "prove_it_beads.js");
    const hookLog = path.join(tmpDir, "hook.log");

    // Wrapper that logs invocation details and delegates to the real hook
    const wrapperScript = path.join(tmpDir, ".claude", "hooks", "beads-wrapper.sh");
    createFile(tmpDir, ".claude/hooks/beads-wrapper.sh", [
      "#!/bin/bash",
      "INPUT=$(cat)",
      'TOOL=$(echo "$INPUT" | jq -r .tool_name 2>/dev/null)',
      `echo "HOOK_FIRED: tool=$TOOL" >> ${hookLog}`,
      `OUTPUT=$(echo "$INPUT" | node ${beadsHookPath})`,
      "EXIT=$?",
      `echo "HOOK_OUTPUT: exit=$EXIT output=$OUTPUT" >> ${hookLog}`,
      'echo "$OUTPUT"',
      "exit $EXIT",
    ].join("\n"));
    fs.chmodSync(wrapperScript, 0o755);

    createFile(
      tmpDir,
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write|NotebookEdit|Bash",
              hooks: [{ type: "command", command: wrapperScript }],
            },
          ],
        },
      }, null, 2)
    );

    const result = spawnSync(
      "claude",
      [
        "-p",
        "Edit the file target.txt: change 'original content' to 'modified content'. Use the Edit tool.",
        "--output-format", "json",
        "--max-budget-usd", "0.05",
        "--model", "haiku",
        "--setting-sources", "project",
        "--no-session-persistence",
        "--allowedTools", "Edit,Read",
      ],
      {
        cwd: tmpDir,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
      }
    );

    const hookFired = fs.existsSync(hookLog);
    const content = fs.readFileSync(path.join(tmpDir, "target.txt"), "utf8");

    // Diagnostic output on failure
    if (content !== "original content\n" || !hookFired) {
      console.log("HOOK FIRED:", hookFired);
      if (hookFired) console.log("HOOK LOG:", fs.readFileSync(hookLog, "utf8"));
      console.log("STDOUT:", (result.stdout || "").slice(0, 500));
      console.log("STDERR:", (result.stderr || "").slice(0, 500));
    }

    assert.ok(hookFired, "Hook should have fired for Edit tool");
    assert.strictEqual(
      content,
      "original content\n",
      "File should not be modified when no bead is in_progress"
    );
  });
});
