const { describe, it } = require('node:test')
const assert = require('node:assert')

const { isSourceFile } = require('../lib/hooks/prove_it_edit')

// Test the beads enforcement logic

describe('beads bash write patterns', () => {
  const defaultPatterns = [
    '\\bcat\\s+.*>',
    '\\becho\\s+.*>',
    '\\btee\\s',
    '\\bsed\\s+-i',
    '\\bawk\\s+.*-i\\s*inplace'
  ]

  function isBashWriteOperation (command, patterns = defaultPatterns) {
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
      assert.ok(isBashWriteOperation('cat > file.txt'))
    })

    it("blocks 'cat foo > bar.txt'", () => {
      assert.ok(isBashWriteOperation('cat foo > bar.txt'))
    })

    it("blocks 'cat <<EOF > file.txt'", () => {
      assert.ok(isBashWriteOperation('cat <<EOF > file.txt'))
    })

    it("does not block 'cat file.txt'", () => {
      assert.ok(!isBashWriteOperation('cat file.txt'))
    })

    it("does not block 'cat file.txt | grep foo'", () => {
      assert.ok(!isBashWriteOperation('cat file.txt | grep foo'))
    })
  })

  describe('echo redirects', () => {
    it("blocks 'echo hello > file.txt'", () => {
      assert.ok(isBashWriteOperation('echo hello > file.txt'))
    })

    it("blocks 'echo \"content\" >> file.txt'", () => {
      assert.ok(isBashWriteOperation('echo "content" >> file.txt'))
    })

    it("does not block 'echo hello'", () => {
      assert.ok(!isBashWriteOperation('echo hello'))
    })
  })

  describe('tee', () => {
    it("blocks 'tee file.txt'", () => {
      assert.ok(isBashWriteOperation('tee file.txt'))
    })

    it("blocks 'echo foo | tee file.txt'", () => {
      assert.ok(isBashWriteOperation('echo foo | tee file.txt'))
    })

    it("blocks 'tee -a file.txt'", () => {
      assert.ok(isBashWriteOperation('tee -a file.txt'))
    })
  })

  describe('sed -i', () => {
    it("blocks 'sed -i s/foo/bar/ file.txt'", () => {
      assert.ok(isBashWriteOperation('sed -i s/foo/bar/ file.txt'))
    })

    it("blocks 'sed -i.bak s/foo/bar/ file.txt'", () => {
      assert.ok(isBashWriteOperation('sed -i.bak s/foo/bar/ file.txt'))
    })

    it("does not block 'sed s/foo/bar/ file.txt'", () => {
      assert.ok(!isBashWriteOperation('sed s/foo/bar/ file.txt'))
    })
  })

  describe('non-write commands', () => {
    it("does not block 'ls -la'", () => {
      assert.ok(!isBashWriteOperation('ls -la'))
    })

    it("does not block 'git status'", () => {
      assert.ok(!isBashWriteOperation('git status'))
    })

    it("does not block 'npm test'", () => {
      assert.ok(!isBashWriteOperation('npm test'))
    })

    it("does not block 'grep foo file.txt'", () => {
      assert.ok(!isBashWriteOperation('grep foo file.txt'))
    })

    it("does not block 'bd list'", () => {
      assert.ok(!isBashWriteOperation('bd list'))
    })

    it("does not block 'bd create'", () => {
      assert.ok(!isBashWriteOperation('bd create'))
    })
  })
})

describe('tools that require a bead', () => {
  const toolsRequiringBead = ['Edit', 'Write', 'NotebookEdit']

  function requiresBead (toolName, tools = toolsRequiringBead) {
    return tools.includes(toolName)
  }

  it('requires bead for Edit', () => {
    assert.ok(requiresBead('Edit'))
  })

  it('requires bead for Write', () => {
    assert.ok(requiresBead('Write'))
  })

  it('requires bead for NotebookEdit', () => {
    assert.ok(requiresBead('NotebookEdit'))
  })

  it('does not require bead for Read', () => {
    assert.ok(!requiresBead('Read'))
  })

  it('does not require bead for Bash', () => {
    // Bash is handled separately by bashWritePatterns
    assert.ok(!requiresBead('Bash'))
  })

  it('does not require bead for Glob', () => {
    assert.ok(!requiresBead('Glob'))
  })

  it('does not require bead for Grep', () => {
    assert.ok(!requiresBead('Grep'))
  })
})

describe('isSourceFile', () => {
  const rootDir = '/repo'
  const sources = ['lib/**/*.js', 'src/**/*.js', 'cli.js', 'test/**/*.js']

  it('matches files in lib/', () => {
    assert.ok(isSourceFile('/repo/lib/shared.js', rootDir, sources))
    assert.ok(isSourceFile('/repo/lib/hooks/prove_it_beads.js', rootDir, sources))
  })

  it('matches files in src/', () => {
    assert.ok(isSourceFile('/repo/src/index.js', rootDir, sources))
  })

  it('matches root-level source files', () => {
    assert.ok(isSourceFile('/repo/cli.js', rootDir, sources))
  })

  it('matches test files', () => {
    assert.ok(isSourceFile('/repo/test/beads.test.js', rootDir, sources))
  })

  it('does not match README', () => {
    assert.ok(!isSourceFile('/repo/README.md', rootDir, sources))
  })

  it('does not match docs', () => {
    assert.ok(!isSourceFile('/repo/docs/guide.md', rootDir, sources))
  })

  it('does not match config files', () => {
    assert.ok(!isSourceFile('/repo/.claude/prove_it.json', rootDir, sources))
    assert.ok(!isSourceFile('/repo/package.json', rootDir, sources))
  })

  it('does not match non-js files in lib/', () => {
    assert.ok(!isSourceFile('/repo/lib/README.md', rootDir, sources))
  })

  it('does not match files outside the repo', () => {
    assert.ok(!isSourceFile('/other/repo/lib/foo.js', rootDir, sources))
  })

  it('treats all files as source when sources is null', () => {
    assert.ok(isSourceFile('/repo/README.md', rootDir, null))
  })

  it('treats all files as source when sources is empty', () => {
    assert.ok(isSourceFile('/repo/README.md', rootDir, []))
  })

  it('works with relative paths', () => {
    assert.ok(isSourceFile('lib/shared.js', rootDir, sources))
    assert.ok(!isSourceFile('README.md', rootDir, sources))
  })
})
