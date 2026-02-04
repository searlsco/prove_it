const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync, spawnSync } = require("node:child_process");

const CLI_PATH = path.join(__dirname, "..", "cli.js");

function runCli(args, options = {}) {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    ...options,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status,
  };
}

describe("CLI", () => {
  describe("help", () => {
    it("shows help with no arguments", () => {
      const result = runCli([]);
      assert.match(result.stdout, /prove_it.*Verifiability-first/s);
      assert.match(result.stdout, /install/);
      assert.match(result.stdout, /uninstall/);
      assert.match(result.stdout, /init/);
      assert.match(result.stdout, /deinit/);
    });

    it("shows help with help command", () => {
      const result = runCli(["help"]);
      assert.match(result.stdout, /prove_it.*Verifiability-first/s);
    });

    it("shows help with --help flag", () => {
      const result = runCli(["--help"]);
      assert.match(result.stdout, /prove_it.*Verifiability-first/s);
    });
  });

  describe("unknown command", () => {
    it("exits with error for unknown command", () => {
      const result = runCli(["foobar"]);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.stderr, /Unknown command: foobar/);
    });
  });
});

describe("init/deinit", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prove-it-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("init creates expected files", () => {
    const result = runCli(["init"], { cwd: tmpDir });
    assert.strictEqual(result.exitCode, 0);

    // Check files exist
    assert.ok(fs.existsSync(path.join(tmpDir, ".claude", "prove_it.json")));
    assert.ok(fs.existsSync(path.join(tmpDir, ".claude", "prove_it.local.json")));
    assert.ok(fs.existsSync(path.join(tmpDir, "script", "test")));

    // Check script/test is executable
    const stat = fs.statSync(path.join(tmpDir, "script", "test"));
    assert.ok(stat.mode & fs.constants.S_IXUSR, "script/test should be executable");
  });

  it("init is non-destructive", () => {
    // Create a custom prove_it.json first
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude", "prove_it.json"), '{"custom": true}');

    runCli(["init"], { cwd: tmpDir });

    // Custom content should be preserved
    const content = fs.readFileSync(path.join(tmpDir, ".claude", "prove_it.json"), "utf8");
    assert.strictEqual(content, '{"custom": true}');
  });

  it("deinit removes prove-it files", () => {
    // First init
    runCli(["init"], { cwd: tmpDir });
    assert.ok(fs.existsSync(path.join(tmpDir, ".claude", "prove_it.local.json")));

    // Then deinit
    const result = runCli(["deinit"], { cwd: tmpDir });
    assert.strictEqual(result.exitCode, 0);

    // Files should be gone
    assert.ok(!fs.existsSync(path.join(tmpDir, ".claude", "prove_it.json")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".claude", "prove_it.local.json")));
  });

  it("deinit preserves customized script/test", () => {
    // Init first
    runCli(["init"], { cwd: tmpDir });

    // Customize script/test
    fs.writeFileSync(path.join(tmpDir, "script", "test"), "#!/bin/bash\nnpm test\n");

    // Deinit
    runCli(["deinit"], { cwd: tmpDir });

    // script/test should still exist since it was customized
    assert.ok(fs.existsSync(path.join(tmpDir, "script", "test")));
  });

  it("deinit removes stub script/test", () => {
    // Init creates stub
    runCli(["init"], { cwd: tmpDir });

    // Deinit should remove it since it's still the stub
    runCli(["deinit"], { cwd: tmpDir });

    assert.ok(!fs.existsSync(path.join(tmpDir, "script", "test")));
  });
});
