#!/usr/bin/env node
/**
 * prove-it build script
 *
 * Inlines lib/shared.js into hooks in src/hooks/ and writes the result
 * to global/hooks/. This gives us DRY development with self-contained
 * runtime hooks.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC_HOOKS = path.join(ROOT, "src", "hooks");
const DST_HOOKS = path.join(ROOT, "global", "hooks");
const SHARED_LIB = path.join(ROOT, "lib", "shared.js");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Build a single hook file by inlining shared code.
 */
function buildHook(srcFile, dstFile) {
  const content = fs.readFileSync(srcFile, "utf8");

  // Check if it uses the shared lib
  if (!content.includes('require("../lib/shared")') && !content.includes("require('../lib/shared')")) {
    // No shared lib usage, just copy
    fs.copyFileSync(srcFile, dstFile);
    console.log(`  Copied: ${path.basename(srcFile)}`);
    return;
  }

  // Extract require statement for shared lib
  const sharedRequireMatch = content.match(/const \{([^}]+)\} = require\(['"]\.\.\/lib\/shared['"]\);?\n?/);
  if (!sharedRequireMatch) {
    console.error(`  Warning: Could not parse shared require in ${srcFile}`);
    fs.copyFileSync(srcFile, dstFile);
    return;
  }

  // Get the list of imported functions
  const importedFns = sharedRequireMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Read shared lib and extract only needed functions
  const sharedContent = fs.readFileSync(SHARED_LIB, "utf8");

  // Build a map of function names to their code
  const fnMap = {};

  // Match function declarations
  const fnPattern = /^function (\w+)\([^)]*\) \{[\s\S]*?^\}/gm;
  let match;
  while ((match = fnPattern.exec(sharedContent)) !== null) {
    fnMap[match[1]] = match[0];
  }

  // Resolve dependencies - some functions call other functions
  const deps = {
    isGitRepo: ["tryRun", "shellEscape"],
    gitRoot: ["tryRun", "shellEscape"],
    gitHead: ["tryRun", "shellEscape"],
    gitStatus: ["tryRun", "shellEscape"],
    gitStatusHash: ["tryRun", "sha256", "shellEscape"],
    gitTrackedFiles: ["tryRun", "shellEscape"],
    writeJson: ["ensureDir"],
    loadEffectiveConfig: ["mergeDeep", "loadJson", "migrateConfig"],
    loadRunData: ["loadJson"],
    saveRunData: ["loadJson", "writeJson"],
    getLatestMtime: ["gitTrackedFiles", "expandGlobs"],
    expandGlobs: ["globToRegex", "walkDir"],
    resolveFastGate: ["resolveFullGate"],
    resolveFullGate: [],
    gateExists: [],
  };

  // Map functions to their required modules
  const fnRequires = {
    tryRun: "spawnSync",
    sha256: "crypto",
  };

  // Collect all needed functions (with dependencies)
  const needed = new Set();
  const queue = [...importedFns];
  while (queue.length > 0) {
    const fn = queue.shift();
    if (needed.has(fn)) continue;
    needed.add(fn);
    if (deps[fn]) {
      queue.push(...deps[fn]);
    }
  }

  // Order functions (dependencies first)
  const ordered = [];
  const added = new Set();
  const addFn = (fn) => {
    if (added.has(fn) || !fnMap[fn]) return;
    // Add dependencies first
    if (deps[fn]) {
      deps[fn].forEach(addFn);
    }
    ordered.push(fn);
    added.add(fn);
  };
  [...needed].sort().forEach(addFn);

  // Determine which additional requires are needed
  const additionalRequires = new Set();
  for (const fn of ordered) {
    if (fnRequires[fn]) {
      additionalRequires.add(fnRequires[fn]);
    }
  }

  // Build the inlined code
  const inlinedFns = ordered.map((fn) => fnMap[fn]).join("\n\n");

  // Remove the shared require and insert inlined functions after the other requires
  let output = content.replace(sharedRequireMatch[0], "");

  // Build additional require statements
  let additionalRequireCode = "";
  if (additionalRequires.has("spawnSync")) {
    // Check if child_process is already required
    if (!output.includes('require("child_process")') && !output.includes("require('child_process')")) {
      additionalRequireCode += 'const { spawnSync } = require("child_process");\n';
    }
  }
  if (additionalRequires.has("crypto")) {
    if (!output.includes('require("crypto")') && !output.includes("require('crypto')")) {
      additionalRequireCode += 'const crypto = require("crypto");\n';
    }
  }

  // Find where to insert (after the last require statement)
  const lastRequire = output.match(/(?:const (?:\w+|\{[^}]+\}) = require\([^)]+\);?\n)+/);
  if (lastRequire) {
    const insertPos = lastRequire.index + lastRequire[0].length;
    output =
      output.slice(0, insertPos) + additionalRequireCode + "\n" + inlinedFns + "\n" + output.slice(insertPos);
  } else {
    // Insert after shebang and doc comment
    const headerMatch = output.match(/^(#!.*\n)?(\/\*\*[\s\S]*?\*\/\n)?/);
    const insertPos = headerMatch ? headerMatch[0].length : 0;
    output =
      output.slice(0, insertPos) + additionalRequireCode + "\n" + inlinedFns + "\n" + output.slice(insertPos);
  }

  fs.writeFileSync(dstFile, output);
  console.log(`  Built: ${path.basename(srcFile)} (inlined ${ordered.length} functions)`);
}

function main() {
  console.log("Building prove-it hooks...\n");

  // Ensure directories exist
  ensureDir(DST_HOOKS);

  // Check if src/hooks exists
  if (!fs.existsSync(SRC_HOOKS)) {
    console.log("No src/hooks/ directory found. Nothing to build.");
    return;
  }

  // Build each hook
  const files = fs.readdirSync(SRC_HOOKS).filter((f) => f.endsWith(".js"));
  if (files.length === 0) {
    console.log("No hook files found in src/hooks/");
    return;
  }

  for (const file of files) {
    const srcFile = path.join(SRC_HOOKS, file);
    const dstFile = path.join(DST_HOOKS, file);
    buildHook(srcFile, dstFile);
  }

  console.log("\nDone.");
}

main();
