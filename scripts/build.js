#!/usr/bin/env node
/**
 * prove-it build script
 *
 * Generates thin shim files in global/hooks/ that call the prove_it CLI.
 * The actual hook logic lives in src/hooks/ and is invoked via `prove_it hook <type>`.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DST_HOOKS = path.join(ROOT, "global", "hooks");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function generateShim(hookType, description) {
  return `#!/usr/bin/env node
/**
 * prove-it: ${description} (shim)
 *
 * This is a thin shim that calls the prove_it CLI.
 * The actual logic lives in the prove_it package.
 */
const { spawnSync } = require("child_process");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const result = spawnSync("prove_it", ["hook", "${hookType}"], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 0);
});
`;
}

function main() {
  console.log("Building prove-it hooks...\n");

  ensureDir(DST_HOOKS);

  const hooks = [
    { file: "prove_it_gate.js", type: "gate", desc: "Verifiability gate" },
    { file: "prove_it_beads_gate.js", type: "beads-gate", desc: "Beads enforcement gate" },
    { file: "prove_it_session_start.js", type: "session-start", desc: "SessionStart hook" },
  ];

  for (const hook of hooks) {
    const dstFile = path.join(DST_HOOKS, hook.file);
    const content = generateShim(hook.type, hook.desc);
    fs.writeFileSync(dstFile, content);
    console.log(`  Built: ${hook.file} (shim)`);
  }

  console.log("\nDone.");
}

main();
