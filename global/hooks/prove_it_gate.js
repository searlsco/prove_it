#!/usr/bin/env node
/**
 * prove-it: Verifiability gate (shim)
 *
 * This is a thin shim that calls the prove_it CLI.
 * The actual logic lives in the prove_it package.
 */
const { spawnSync } = require("child_process");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const result = spawnSync("prove_it", ["hook", "gate"], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 0);
});
