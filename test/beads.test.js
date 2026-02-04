const { describe, it } = require("node:test");
const assert = require("node:assert");

// Test the beads enforcement logic

describe("beads bash write patterns", () => {
  const defaultPatterns = [
    "\\bcat\\s+.*>",
    "\\becho\\s+.*>",
    "\\btee\\s",
    "\\bsed\\s+-i",
    "\\bawk\\s+.*-i\\s*inplace",
  ];

  function isBashWriteOperation(command, patterns = defaultPatterns) {
    return patterns.some((pat) => {
      try {
        return new RegExp(pat, "i").test(command);
      } catch {
        return false;
      }
    });
  }

  describe("cat redirects", () => {
    it("blocks 'cat > file.txt'", () => {
      assert.ok(isBashWriteOperation("cat > file.txt"));
    });

    it("blocks 'cat foo > bar.txt'", () => {
      assert.ok(isBashWriteOperation("cat foo > bar.txt"));
    });

    it("blocks 'cat <<EOF > file.txt'", () => {
      assert.ok(isBashWriteOperation("cat <<EOF > file.txt"));
    });

    it("does not block 'cat file.txt'", () => {
      assert.ok(!isBashWriteOperation("cat file.txt"));
    });

    it("does not block 'cat file.txt | grep foo'", () => {
      assert.ok(!isBashWriteOperation("cat file.txt | grep foo"));
    });
  });

  describe("echo redirects", () => {
    it("blocks 'echo hello > file.txt'", () => {
      assert.ok(isBashWriteOperation("echo hello > file.txt"));
    });

    it("blocks 'echo \"content\" >> file.txt'", () => {
      assert.ok(isBashWriteOperation('echo "content" >> file.txt'));
    });

    it("does not block 'echo hello'", () => {
      assert.ok(!isBashWriteOperation("echo hello"));
    });
  });

  describe("tee", () => {
    it("blocks 'tee file.txt'", () => {
      assert.ok(isBashWriteOperation("tee file.txt"));
    });

    it("blocks 'echo foo | tee file.txt'", () => {
      assert.ok(isBashWriteOperation("echo foo | tee file.txt"));
    });

    it("blocks 'tee -a file.txt'", () => {
      assert.ok(isBashWriteOperation("tee -a file.txt"));
    });
  });

  describe("sed -i", () => {
    it("blocks 'sed -i s/foo/bar/ file.txt'", () => {
      assert.ok(isBashWriteOperation("sed -i s/foo/bar/ file.txt"));
    });

    it("blocks 'sed -i.bak s/foo/bar/ file.txt'", () => {
      assert.ok(isBashWriteOperation("sed -i.bak s/foo/bar/ file.txt"));
    });

    it("does not block 'sed s/foo/bar/ file.txt'", () => {
      assert.ok(!isBashWriteOperation("sed s/foo/bar/ file.txt"));
    });
  });

  describe("non-write commands", () => {
    it("does not block 'ls -la'", () => {
      assert.ok(!isBashWriteOperation("ls -la"));
    });

    it("does not block 'git status'", () => {
      assert.ok(!isBashWriteOperation("git status"));
    });

    it("does not block 'npm test'", () => {
      assert.ok(!isBashWriteOperation("npm test"));
    });

    it("does not block 'grep foo file.txt'", () => {
      assert.ok(!isBashWriteOperation("grep foo file.txt"));
    });

    it("does not block 'bd list'", () => {
      assert.ok(!isBashWriteOperation("bd list"));
    });

    it("does not block 'bd create'", () => {
      assert.ok(!isBashWriteOperation("bd create"));
    });
  });
});

describe("tools that require a bead", () => {
  const toolsRequiringBead = ["Edit", "Write", "NotebookEdit"];

  function requiresBead(toolName, tools = toolsRequiringBead) {
    return tools.includes(toolName);
  }

  it("requires bead for Edit", () => {
    assert.ok(requiresBead("Edit"));
  });

  it("requires bead for Write", () => {
    assert.ok(requiresBead("Write"));
  });

  it("requires bead for NotebookEdit", () => {
    assert.ok(requiresBead("NotebookEdit"));
  });

  it("does not require bead for Read", () => {
    assert.ok(!requiresBead("Read"));
  });

  it("does not require bead for Bash", () => {
    // Bash is handled separately by bashWritePatterns
    assert.ok(!requiresBead("Bash"));
  });

  it("does not require bead for Glob", () => {
    assert.ok(!requiresBead("Glob"));
  });

  it("does not require bead for Grep", () => {
    assert.ok(!requiresBead("Grep"));
  });
});
