const { describe, it } = require('node:test')
const assert = require('node:assert')
const os = require('os')
const fs = require('fs')
const path = require('path')

const {
  isConfigFileEdit,
  isLocalConfigWrite,
  isSourceFile,
  globToRegex,
  walkDir
} = require('../lib/globs')

describe('local config write protection', () => {
  describe('blocks Write/Edit tools', () => {
    it('blocks Write to prove_it.json', () => {
      assert.strictEqual(isConfigFileEdit('Write', { file_path: '/project/.claude/prove_it.json' }), true)
    })

    it('blocks Write to prove_it.local.json', () => {
      assert.strictEqual(isConfigFileEdit('Write', { file_path: '/project/.claude/prove_it.local.json' }), true)
    })

    it('blocks Edit to prove_it.json', () => {
      assert.strictEqual(isConfigFileEdit('Edit', { file_path: '.claude/prove_it.json' }), true)
    })

    it('blocks Edit to prove_it.local.json', () => {
      assert.strictEqual(isConfigFileEdit('Edit', { file_path: '.claude/prove_it.local.json' }), true)
    })

    it('blocks Write to global prove_it/config.json', () => {
      assert.strictEqual(isConfigFileEdit('Write', { file_path: '/Users/me/.claude/prove_it/config.json' }), true)
    })

    it('blocks Edit to global prove_it/config.json', () => {
      assert.strictEqual(isConfigFileEdit('Edit', { file_path: '/home/user/.claude/prove_it/config.json' }), true)
    })

    it('allows Write to other files', () => {
      assert.strictEqual(isConfigFileEdit('Write', { file_path: '/project/src/index.js' }), false)
    })

    it('allows Edit to other files', () => {
      assert.strictEqual(isConfigFileEdit('Edit', { file_path: '.claude/settings.json' }), false)
    })

    it('allows Read tool', () => {
      assert.strictEqual(isConfigFileEdit('Read', { file_path: '.claude/prove_it.json' }), false)
    })

    it('allows Bash tool', () => {
      assert.strictEqual(isConfigFileEdit('Bash', { command: 'cat .claude/prove_it.json' }), false)
    })
  })

  describe('blocks writes', () => {
    it('blocks echo redirect', () => {
      assert.strictEqual(isLocalConfigWrite('echo \'{"suiteGate":{"require":false}}\' > .claude/prove_it.local.json'), true)
    })

    it('blocks append redirect', () => {
      assert.strictEqual(isLocalConfigWrite('echo foo >> .claude/prove_it.local.json'), true)
    })

    it('blocks tee', () => {
      assert.strictEqual(isLocalConfigWrite('echo foo | tee .claude/prove_it.local.json'), true)
    })

    it('blocks tee -a', () => {
      assert.strictEqual(isLocalConfigWrite('echo foo | tee -a .claude/prove_it.local.json'), true)
    })

    it('blocks with full path', () => {
      assert.strictEqual(isLocalConfigWrite('echo foo > /Users/justin/project/.claude/prove_it.local.json'), true)
    })

    it('blocks mkdir && echo combo', () => {
      assert.strictEqual(isLocalConfigWrite('mkdir -p .claude && echo \'{"suiteGate":{"require":false}}\' > .claude/prove_it.local.json'), true)
    })

    it('blocks redirect to prove_it.json', () => {
      assert.strictEqual(isLocalConfigWrite('echo {} > .claude/prove_it.json'), true)
    })

    it('blocks redirect to global prove_it/config.json', () => {
      assert.strictEqual(isLocalConfigWrite('echo {} > ~/.claude/prove_it/config.json'), true)
    })
  })

  describe('allows reads', () => {
    it('allows cat', () => {
      assert.strictEqual(isLocalConfigWrite('cat .claude/prove_it.local.json'), false)
    })

    it('allows grep', () => {
      assert.strictEqual(isLocalConfigWrite('grep require .claude/prove_it.local.json'), false)
    })

    it('allows jq', () => {
      assert.strictEqual(isLocalConfigWrite('jq . .claude/prove_it.local.json'), false)
    })

    it('allows input redirect (reading)', () => {
      assert.strictEqual(isLocalConfigWrite('jq . < .claude/prove_it.local.json'), false)
    })
  })

  describe('ignores other files', () => {
    it('allows writing to other json files', () => {
      assert.strictEqual(isLocalConfigWrite('echo {} > .claude/other.json'), false)
    })

    it('blocks writing to global prove_it/config.json', () => {
      assert.strictEqual(isLocalConfigWrite('echo {} > ~/.claude/prove_it/config.json'), true)
    })
  })
})

describe('isSourceFile', () => {
  const rootDir = '/repo'
  const sources = ['lib/**/*.js', 'src/**/*.js', 'cli.js', 'test/**/*.js']

  it('matches files in lib/', () => {
    assert.strictEqual(isSourceFile('/repo/lib/shared.js', rootDir, sources), true)
    assert.strictEqual(isSourceFile('/repo/lib/hooks/prove_it_beads.js', rootDir, sources), true)
  })

  it('matches files in src/', () => {
    assert.strictEqual(isSourceFile('/repo/src/index.js', rootDir, sources), true)
  })

  it('matches root-level source files', () => {
    assert.strictEqual(isSourceFile('/repo/cli.js', rootDir, sources), true)
  })

  it('matches test files', () => {
    assert.strictEqual(isSourceFile('/repo/test/beads.test.js', rootDir, sources), true)
  })

  it('does not match README', () => {
    assert.strictEqual(isSourceFile('/repo/README.md', rootDir, sources), false)
  })

  it('does not match docs', () => {
    assert.strictEqual(isSourceFile('/repo/docs/guide.md', rootDir, sources), false)
  })

  it('does not match config files', () => {
    assert.strictEqual(isSourceFile('/repo/.claude/prove_it.json', rootDir, sources), false)
    assert.strictEqual(isSourceFile('/repo/package.json', rootDir, sources), false)
  })

  it('does not match non-js files in lib/', () => {
    assert.strictEqual(isSourceFile('/repo/lib/README.md', rootDir, sources), false)
  })

  it('does not match files outside the repo', () => {
    assert.strictEqual(isSourceFile('/other/repo/lib/foo.js', rootDir, sources), false)
  })

  it('treats all files as source when sources is null', () => {
    assert.strictEqual(isSourceFile('/repo/README.md', rootDir, null), true)
  })

  it('treats all files as source when sources is empty', () => {
    assert.strictEqual(isSourceFile('/repo/README.md', rootDir, []), true)
  })

  it('works with relative paths', () => {
    assert.strictEqual(isSourceFile('lib/shared.js', rootDir, sources), true)
    assert.strictEqual(isSourceFile('README.md', rootDir, sources), false)
  })
})

describe('globToRegex', () => {
  it('matches simple wildcard', () => {
    const re = globToRegex('*.js')
    assert.strictEqual(re.test('foo.js'), true)
    assert.strictEqual(re.test('bar.js'), true)
    assert.strictEqual(re.test('foo.ts'), false)
    assert.strictEqual(re.test('dir/foo.js'), false, 'Single * should not match path separators')
  })

  it('matches globstar (**)', () => {
    const re = globToRegex('**/*.js')
    assert.strictEqual(re.test('foo.js'), true, '**/ should match zero directory segments (root-level)')
    assert.strictEqual(re.test('src/foo.js'), true)
    assert.strictEqual(re.test('src/deep/foo.js'), true)
    assert.strictEqual(re.test('src/foo.ts'), false)
  })

  it('matches globstar with prefix (lib/**/*.js)', () => {
    const re = globToRegex('lib/**/*.js')
    assert.strictEqual(re.test('lib/shared.js'), true, 'Should match files directly in lib/')
    assert.strictEqual(re.test('lib/hooks/beads.js'), true, 'Should match nested files')
    assert.strictEqual(re.test('lib/shared.ts'), false, 'Should not match wrong extension')
    assert.strictEqual(re.test('src/shared.js'), false, 'Should not match wrong prefix')
  })

  it('matches single character wildcard (?)', () => {
    const re = globToRegex('file?.js')
    assert.strictEqual(re.test('file1.js'), true)
    assert.strictEqual(re.test('fileA.js'), true)
    assert.strictEqual(re.test('file12.js'), false, '? should match exactly one character')
  })

  it('escapes regex special characters', () => {
    const re = globToRegex('file.test.js')
    assert.strictEqual(re.test('file.test.js'), true)
    assert.strictEqual(re.test('fileXtestXjs'), false, 'Dots should be literal, not regex wildcards')
  })

  it('matches exact filename without wildcards', () => {
    const re = globToRegex('package.json')
    assert.strictEqual(re.test('package.json'), true)
    assert.strictEqual(re.test('other.json'), false)
    assert.strictEqual(re.test('dir/package.json'), false)
  })
})

describe('walkDir', () => {
  function createTree (base, structure) {
    for (const [name, content] of Object.entries(structure)) {
      const full = path.join(base, name)
      if (typeof content === 'object') {
        fs.mkdirSync(full, { recursive: true })
        createTree(full, content)
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, content)
      }
    }
  }

  it('finds files matching a glob pattern', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_walk_'))
    createTree(tmp, { 'a.js': '1', 'b.ts': '2', sub: { 'c.js': '3' } })

    const files = new Set()
    walkDir(tmp, tmp, globToRegex('*.js'), files)
    assert.strictEqual(files.has('a.js'), true)
    assert.strictEqual(files.has('b.ts'), false)
    assert.strictEqual(files.has(path.join('sub', 'c.js')), false, '*.js should not match subdirectory files')

    const deepFiles = new Set()
    walkDir(tmp, tmp, globToRegex('**/*.js'), deepFiles)
    assert.strictEqual(deepFiles.has(path.join('sub', 'c.js')), true)
    assert.strictEqual(deepFiles.has('a.js'), true, '**/*.js should match root-level files too')

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('skips dotfiles and node_modules', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_walk_'))
    createTree(tmp, {
      src: { 'a.js': '1' },
      '.hidden': { 'b.js': '2' },
      node_modules: { 'c.js': '3' }
    })

    const files = new Set()
    walkDir(tmp, tmp, globToRegex('**/*.js'), files)
    assert.strictEqual(files.has(path.join('src', 'a.js')), true)
    assert.strictEqual(files.size, 1, 'Should only find src/a.js, skipping .hidden and node_modules')

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns empty set for nonexistent directory', () => {
    const files = new Set()
    walkDir('/nonexistent', '/nonexistent', globToRegex('*.js'), files)
    assert.strictEqual(files.size, 0)
  })
})
