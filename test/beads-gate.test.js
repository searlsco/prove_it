const { describe, it } = require("node:test");
const assert = require("node:assert");

// Test the beads gating logic

describe("beads bash write patterns", () => {
  const defaultPatterns = [
    "\\bcat\\s+.*>",
    "\\becho\\s+.*>",
    "\\btee\\s",
    "\\bsed\\s+-i",
    "\\bawk\\s+.*-i\\s*inplace",
  ];

  function shouldGateBash(command, patterns = defaultPatterns) {
    return patterns.some((pat) => {
      try {
        return new RegExp(pat, "i").test(command);
      } catch {
        return false;
      }
    });
  }

  describe("cat redirects", () => {
    it("gates 'cat > file.txt'", () => {
      assert.ok(shouldGateBash("cat > file.txt"));
    });

    it("gates 'cat foo > bar.txt'", () => {
      assert.ok(shouldGateBash("cat foo > bar.txt"));
    });

    it("gates 'cat <<EOF > file.txt'", () => {
      assert.ok(shouldGateBash("cat <<EOF > file.txt"));
    });

    it("does not gate 'cat file.txt'", () => {
      assert.ok(!shouldGateBash("cat file.txt"));
    });

    it("does not gate 'cat file.txt | grep foo'", () => {
      assert.ok(!shouldGateBash("cat file.txt | grep foo"));
    });
  });

  describe("echo redirects", () => {
    it("gates 'echo hello > file.txt'", () => {
      assert.ok(shouldGateBash("echo hello > file.txt"));
    });

    it("gates 'echo \"content\" >> file.txt'", () => {
      assert.ok(shouldGateBash('echo "content" >> file.txt'));
    });

    it("does not gate 'echo hello'", () => {
      assert.ok(!shouldGateBash("echo hello"));
    });
  });

  describe("tee", () => {
    it("gates 'tee file.txt'", () => {
      assert.ok(shouldGateBash("tee file.txt"));
    });

    it("gates 'echo foo | tee file.txt'", () => {
      assert.ok(shouldGateBash("echo foo | tee file.txt"));
    });

    it("gates 'tee -a file.txt'", () => {
      assert.ok(shouldGateBash("tee -a file.txt"));
    });
  });

  describe("sed -i", () => {
    it("gates 'sed -i s/foo/bar/ file.txt'", () => {
      assert.ok(shouldGateBash("sed -i s/foo/bar/ file.txt"));
    });

    it("gates 'sed -i.bak s/foo/bar/ file.txt'", () => {
      assert.ok(shouldGateBash("sed -i.bak s/foo/bar/ file.txt"));
    });

    it("does not gate 'sed s/foo/bar/ file.txt'", () => {
      assert.ok(!shouldGateBash("sed s/foo/bar/ file.txt"));
    });
  });

  describe("non-write commands", () => {
    it("does not gate 'ls -la'", () => {
      assert.ok(!shouldGateBash("ls -la"));
    });

    it("does not gate 'git status'", () => {
      assert.ok(!shouldGateBash("git status"));
    });

    it("does not gate 'npm test'", () => {
      assert.ok(!shouldGateBash("npm test"));
    });

    it("does not gate 'grep foo file.txt'", () => {
      assert.ok(!shouldGateBash("grep foo file.txt"));
    });

    it("does not gate 'bd list'", () => {
      assert.ok(!shouldGateBash("bd list"));
    });

    it("does not gate 'bd create'", () => {
      assert.ok(!shouldGateBash("bd create"));
    });
  });
});

describe("beads gated tools", () => {
  const defaultGatedTools = ["Edit", "Write", "NotebookEdit"];

  function shouldGateTool(toolName, gatedTools = defaultGatedTools) {
    return gatedTools.includes(toolName);
  }

  it("gates Edit", () => {
    assert.ok(shouldGateTool("Edit"));
  });

  it("gates Write", () => {
    assert.ok(shouldGateTool("Write"));
  });

  it("gates NotebookEdit", () => {
    assert.ok(shouldGateTool("NotebookEdit"));
  });

  it("does not gate Read", () => {
    assert.ok(!shouldGateTool("Read"));
  });

  it("does not gate Bash", () => {
    // Bash is handled separately by bashWritePatterns
    assert.ok(!shouldGateTool("Bash"));
  });

  it("does not gate Glob", () => {
    assert.ok(!shouldGateTool("Glob"));
  });

  it("does not gate Grep", () => {
    assert.ok(!shouldGateTool("Grep"));
  });
});
