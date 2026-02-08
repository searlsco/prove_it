const { describe, it } = require('node:test')
const assert = require('node:assert')

const { GATED_TOOLS, BASH_WRITE_PATTERNS } = require('../lib/checks/builtins')

describe('beads bash write patterns', () => {
  function isBashWriteOperation (command, patterns = BASH_WRITE_PATTERNS) {
    return patterns.some((pat) => {
      try {
        return new RegExp(pat, 'i').test(command)
      } catch {
        return false
      }
    })
  }

  describe('cat redirects', () => {
    it("blocks 'cat > file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('cat > file.txt'), true)
    })

    it("blocks 'cat foo > bar.txt'", () => {
      assert.strictEqual(isBashWriteOperation('cat foo > bar.txt'), true)
    })

    it("blocks 'cat <<EOF > file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('cat <<EOF > file.txt'), true)
    })

    it("does not block 'cat file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('cat file.txt'), false)
    })

    it("does not block 'cat file.txt | grep foo'", () => {
      assert.strictEqual(isBashWriteOperation('cat file.txt | grep foo'), false)
    })
  })

  describe('echo redirects', () => {
    it("blocks 'echo hello > file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('echo hello > file.txt'), true)
    })

    it("blocks 'echo \"content\" >> file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('echo "content" >> file.txt'), true)
    })

    it("does not block 'echo hello'", () => {
      assert.strictEqual(isBashWriteOperation('echo hello'), false)
    })
  })

  describe('tee', () => {
    it("blocks 'tee file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('tee file.txt'), true)
    })

    it("blocks 'echo foo | tee file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('echo foo | tee file.txt'), true)
    })

    it("blocks 'tee -a file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('tee -a file.txt'), true)
    })
  })

  describe('sed -i', () => {
    it("blocks 'sed -i s/foo/bar/ file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('sed -i s/foo/bar/ file.txt'), true)
    })

    it("blocks 'sed -i.bak s/foo/bar/ file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('sed -i.bak s/foo/bar/ file.txt'), true)
    })

    it("does not block 'sed s/foo/bar/ file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('sed s/foo/bar/ file.txt'), false)
    })
  })

  describe('non-write commands', () => {
    it("does not block 'ls -la'", () => {
      assert.strictEqual(isBashWriteOperation('ls -la'), false)
    })

    it("does not block 'git status'", () => {
      assert.strictEqual(isBashWriteOperation('git status'), false)
    })

    it("does not block 'npm test'", () => {
      assert.strictEqual(isBashWriteOperation('npm test'), false)
    })

    it("does not block 'grep foo file.txt'", () => {
      assert.strictEqual(isBashWriteOperation('grep foo file.txt'), false)
    })

    it("does not block 'bd list'", () => {
      assert.strictEqual(isBashWriteOperation('bd list'), false)
    })

    it("does not block 'bd create'", () => {
      assert.strictEqual(isBashWriteOperation('bd create'), false)
    })
  })
})

describe('tools that require a bead', () => {
  it('requires bead for Edit', () => {
    assert.strictEqual(GATED_TOOLS.includes('Edit'), true)
  })

  it('requires bead for Write', () => {
    assert.strictEqual(GATED_TOOLS.includes('Write'), true)
  })

  it('requires bead for NotebookEdit', () => {
    assert.strictEqual(GATED_TOOLS.includes('NotebookEdit'), true)
  })

  it('does not require bead for Read', () => {
    assert.strictEqual(GATED_TOOLS.includes('Read'), false)
  })

  it('does not require bead for Bash', () => {
    assert.strictEqual(GATED_TOOLS.includes('Bash'), false)
  })

  it('does not require bead for Glob', () => {
    assert.strictEqual(GATED_TOOLS.includes('Glob'), false)
  })

  it('does not require bead for Grep', () => {
    assert.strictEqual(GATED_TOOLS.includes('Grep'), false)
  })
})
