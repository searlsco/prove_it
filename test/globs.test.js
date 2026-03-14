const { describe, it } = require('node:test')
const assert = require('node:assert')
const os = require('os')
const fs = require('fs')
const path = require('path')

const {
  isConfigFileEdit,
  isLocalConfigWrite,
  isSourceFile,
  isTestFile,
  globToRegex,
  expandBraces,
  expandGlobs,
  matchesGlobList,
  walkDir
} = require('../lib/globs')

describe('local config write protection', () => {
  describe('isConfigFileEdit', () => {
    const blockCases = [
      ['Write to prove_it.json', 'Write', { file_path: '/project/.claude/prove_it.json' }],
      ['Write to prove_it.local.json', 'Write', { file_path: '/project/.claude/prove_it.local.json' }],
      ['Edit to prove_it.json', 'Edit', { file_path: '.claude/prove_it.json' }],
      ['Edit to prove_it.local.json', 'Edit', { file_path: '.claude/prove_it.local.json' }],
      ['Write to global prove_it/config.json', 'Write', { file_path: '/Users/me/.claude/prove_it/config.json' }],
      ['Edit to global prove_it/config.json', 'Edit', { file_path: '/home/user/.claude/prove_it/config.json' }],
      ['Write to prove_it/config.local.json', 'Write', { file_path: '/project/.claude/prove_it/config.local.json' }],
      ['Edit to prove_it/config.local.json', 'Edit', { file_path: '.claude/prove_it/config.local.json' }]
    ]

    blockCases.forEach(([label, tool, input]) => {
      it(`blocks ${label}`, () => {
        assert.strictEqual(isConfigFileEdit(tool, input), true)
      })
    })

    const allowCases = [
      ['Write to other files', 'Write', { file_path: '/project/src/index.js' }],
      ['Edit to other files', 'Edit', { file_path: '.claude/settings.json' }],
      ['Read tool on config', 'Read', { file_path: '.claude/prove_it.json' }],
      ['Bash tool on config', 'Bash', { command: 'cat .claude/prove_it.json' }]
    ]

    allowCases.forEach(([label, tool, input]) => {
      it(`allows ${label}`, () => {
        assert.strictEqual(isConfigFileEdit(tool, input), false)
      })
    })
  })

  describe('isLocalConfigWrite', () => {
    const blockCases = [
      ['echo redirect', "echo '{\"suiteGate\":{\"require\":false}}' > .claude/prove_it.local.json"],
      ['append redirect', 'echo foo >> .claude/prove_it.local.json'],
      ['tee', 'echo foo | tee .claude/prove_it.local.json'],
      ['tee -a', 'echo foo | tee -a .claude/prove_it.local.json'],
      ['full path redirect', 'echo foo > /Users/justin/project/.claude/prove_it.local.json'],
      ['mkdir && echo combo', "mkdir -p .claude && echo '{\"suiteGate\":{\"require\":false}}' > .claude/prove_it.local.json"],
      ['redirect to prove_it.json', 'echo {} > .claude/prove_it.json'],
      ['redirect to global prove_it/config.json', 'echo {} > ~/.claude/prove_it/config.json'],
      ['redirect to prove_it/config.local.json', 'echo {} > .claude/prove_it/config.local.json'],
      ['tee to prove_it/config.local.json', 'echo foo | tee .claude/prove_it/config.local.json']
    ]

    blockCases.forEach(([label, command]) => {
      it(`blocks ${label}`, () => {
        assert.strictEqual(isLocalConfigWrite(command), true)
      })
    })

    const allowCases = [
      ['cat', 'cat .claude/prove_it.local.json'],
      ['grep', 'grep require .claude/prove_it.local.json'],
      ['jq', 'jq . .claude/prove_it.local.json'],
      ['input redirect (reading)', 'jq . < .claude/prove_it.local.json'],
      ['writing to other json files', 'echo {} > .claude/other.json']
    ]

    allowCases.forEach(([label, command]) => {
      it(`allows ${label}`, () => {
        assert.strictEqual(isLocalConfigWrite(command), false)
      })
    })
  })
})

describe('isSourceFile', () => {
  const rootDir = '/repo'
  const sources = ['lib/**/*.js', 'src/**/*.js', 'cli.js', 'test/**/*.js']

  const matchCases = [
    ['file in lib/', '/repo/lib/shared.js'],
    ['nested file in lib/', '/repo/lib/hooks/prove_it_edit.js'],
    ['file in src/', '/repo/src/index.js'],
    ['root-level source file', '/repo/cli.js'],
    ['test file', '/repo/test/config.test.js'],
    ['relative path in lib/', 'lib/shared.js']
  ]

  matchCases.forEach(([label, filePath]) => {
    it(`matches ${label}`, () => {
      assert.strictEqual(isSourceFile(filePath, rootDir, sources), true)
    })
  })

  const noMatchCases = [
    ['README', '/repo/README.md'],
    ['docs', '/repo/docs/guide.md'],
    ['config file (prove_it.json)', '/repo/.claude/prove_it.json'],
    ['config file (package.json)', '/repo/package.json'],
    ['non-js file in lib/', '/repo/lib/README.md'],
    ['file outside the repo', '/other/repo/lib/foo.js'],
    ['relative non-source path', 'README.md']
  ]

  noMatchCases.forEach(([label, filePath]) => {
    it(`does not match ${label}`, () => {
      assert.strictEqual(isSourceFile(filePath, rootDir, sources), false)
    })
  })

  it('treats all files as source when sources is null', () => {
    assert.strictEqual(isSourceFile('/repo/README.md', rootDir, null), true)
  })

  it('treats all files as source when sources is empty', () => {
    assert.strictEqual(isSourceFile('/repo/README.md', rootDir, []), true)
  })
})

describe('globToRegex', () => {
  const cases = [
    ['simple wildcard', '*.js', [
      ['foo.js', true],
      ['bar.js', true],
      ['foo.ts', false],
      ['dir/foo.js', false, 'Single * should not match path separators']
    ]],
    ['globstar (**)', '**/*.js', [
      ['foo.js', true, '**/ should match zero directory segments (root-level)'],
      ['src/foo.js', true],
      ['src/deep/foo.js', true],
      ['src/foo.ts', false]
    ]],
    ['globstar with prefix (lib/**/*.js)', 'lib/**/*.js', [
      ['lib/shared.js', true, 'Should match files directly in lib/'],
      ['lib/hooks/edit.js', true, 'Should match nested files'],
      ['lib/shared.ts', false, 'Should not match wrong extension'],
      ['src/shared.js', false, 'Should not match wrong prefix']
    ]],
    ['single character wildcard (?)', 'file?.js', [
      ['file1.js', true],
      ['fileA.js', true],
      ['file12.js', false, '? should match exactly one character']
    ]],
    ['regex special characters', 'file.test.js', [
      ['file.test.js', true],
      ['fileXtestXjs', false, 'Dots should be literal, not regex wildcards']
    ]],
    ['exact filename without wildcards', 'package.json', [
      ['package.json', true],
      ['other.json', false],
      ['dir/package.json', false]
    ]],
    ['brace expansion with two options', '*.{js,ts}', [
      ['foo.js', true],
      ['foo.ts', true],
      ['foo.py', false, 'Should not match unlisted extensions']
    ]],
    ['brace expansion with three options', '*.{test,spec,unit}.js', [
      ['foo.test.js', true],
      ['foo.spec.js', true],
      ['foo.unit.js', true],
      ['foo.other.js', false]
    ]],
    ['brace expansion in directory name', '**/{test,tests,__tests__}/**/*.js', [
      ['test/foo.js', true],
      ['tests/foo.js', true],
      ['__tests__/foo.js', true],
      ['src/foo.js', false]
    ]],
    ['brace expansion with globstar prefix', '**/*.{test,spec}.*', [
      ['foo.test.js', true],
      ['foo.spec.ts', true],
      ['src/deep/bar.test.py', true],
      ['foo.js', false]
    ]]
  ]

  cases.forEach(([label, glob, assertions]) => {
    it(`matches ${label}`, () => {
      const re = globToRegex(glob)
      assertions.forEach(([testString, expected, message]) => {
        assert.strictEqual(re.test(testString), expected, message)
      })
    })
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

describe('expandBraces', () => {
  it('expands simple {a,b} to (?:a|b)', () => {
    assert.strictEqual(expandBraces('{js,ts}'), '(?:js|ts)')
  })

  it('expands multiple brace groups', () => {
    assert.strictEqual(expandBraces('{a,b}.{c,d}'), '(?:a|b).(?:c|d)')
  })

  it('passes through strings without braces', () => {
    assert.strictEqual(expandBraces('foo/bar/*.js'), 'foo/bar/*.js')
  })

  it('handles three-option groups', () => {
    assert.strictEqual(expandBraces('{test,spec,unit}'), '(?:test|spec|unit)')
  })

  it('handles single-option braces (degenerate case)', () => {
    assert.strictEqual(expandBraces('{only}'), '(?:only)')
  })
})

describe('isTestFile', () => {
  const rootDir = '/repo'
  const tests = [
    '**/*.{test,spec}.*',
    '**/*_{test,spec}.*',
    '**/{test,tests,spec,specs,__tests__}/**/*.*'
  ]

  const matchCases = [
    ['foo.test.js', 'foo.test.js'],
    ['foo.spec.ts', 'foo.spec.ts'],
    ['nested test file', 'src/lib/foo.test.js'],
    ['underscore test file', 'src/foo_test.py'],
    ['underscore spec file', 'src/foo_spec.rb'],
    ['file in test/ dir', 'test/helpers/setup.js'],
    ['file in tests/ dir', 'tests/unit/foo.js'],
    ['file in __tests__/ dir', '__tests__/foo.js'],
    ['file in spec/ dir', 'spec/models/user.js'],
    ['file in specs/ dir', 'specs/foo.js'],
    ['absolute path test file', '/repo/src/foo.test.js']
  ]

  matchCases.forEach(([label, filePath]) => {
    it(`matches ${label}`, () => {
      assert.strictEqual(isTestFile(filePath, rootDir, tests), true)
    })
  })

  const noMatchCases = [
    ['regular source file', 'src/app.js'],
    ['README', 'README.md'],
    ['config file', 'config/database.json'],
    ['file with test in name but not pattern', 'src/testUtils.js'],
    ['file outside repo', '/other/repo/foo.test.js']
  ]

  noMatchCases.forEach(([label, filePath]) => {
    it(`does not match ${label}`, () => {
      assert.strictEqual(isTestFile(filePath, rootDir, tests), false)
    })
  })

  it('returns false when tests is null', () => {
    assert.strictEqual(isTestFile('foo.test.js', rootDir, null), false)
  })

  it('returns false when tests is empty', () => {
    assert.strictEqual(isTestFile('foo.test.js', rootDir, []), false)
  })
})

describe('matchesGlobList', () => {
  it('matches with inclusion-only patterns (same as .some())', () => {
    assert.strictEqual(matchesGlobList('lib/foo.js', ['**/*.js']), true)
    assert.strictEqual(matchesGlobList('lib/foo.ts', ['**/*.js']), false)
  })

  it('excludes files matching a negated pattern', () => {
    assert.strictEqual(matchesGlobList('README.md', ['**/*.*', '!**/*.md']), false)
    assert.strictEqual(matchesGlobList('lib/foo.js', ['**/*.*', '!**/*.md']), true)
  })

  it('last matching pattern wins (order matters)', () => {
    // Excluded then re-included
    assert.strictEqual(matchesGlobList('docs/api.md', ['**/*.*', '!**/*.md', 'docs/**/*.md']), true)
    // Included then excluded
    assert.strictEqual(matchesGlobList('docs/api.md', ['**/*.*', 'docs/**/*.md', '!**/*.md']), false)
  })

  it('re-includes a specific file after broad exclusion', () => {
    const globs = ['**/*.*', '!**/*.md', 'CHANGELOG.md']
    assert.strictEqual(matchesGlobList('CHANGELOG.md', globs), true)
    assert.strictEqual(matchesGlobList('README.md', globs), false)
  })

  it('returns false when no patterns match', () => {
    assert.strictEqual(matchesGlobList('foo.py', ['**/*.js']), false)
  })

  it('handles brace expansion in negated patterns', () => {
    const globs = ['**/*.*', '!**/*.{md,txt}']
    assert.strictEqual(matchesGlobList('README.md', globs), false)
    assert.strictEqual(matchesGlobList('notes.txt', globs), false)
    assert.strictEqual(matchesGlobList('lib/foo.js', globs), true)
  })
})

describe('isSourceFile with negation patterns', () => {
  const rootDir = '/repo'

  it('excludes markdown files via negation', () => {
    const sources = ['**/*.*', '!**/*.md']
    assert.strictEqual(isSourceFile('/repo/lib/foo.js', rootDir, sources), true)
    assert.strictEqual(isSourceFile('/repo/README.md', rootDir, sources), false)
  })

  it('is backwards compatible with inclusion-only patterns', () => {
    const sources = ['lib/**/*.js', 'src/**/*.js']
    assert.strictEqual(isSourceFile('/repo/lib/foo.js', rootDir, sources), true)
    assert.strictEqual(isSourceFile('/repo/README.md', rootDir, sources), false)
  })
})

describe('isTestFile with negation patterns', () => {
  const rootDir = '/repo'

  it('excludes specific test files via negation', () => {
    const tests = ['test/**/*.*', '!test/fixtures/**/*.*']
    assert.strictEqual(isTestFile('test/foo.test.js', rootDir, tests), true)
    assert.strictEqual(isTestFile('test/fixtures/sample.js', rootDir, tests), false)
  })
})

describe('expandGlobs with negation', () => {
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

  it('excludes files matching negated patterns', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_neg_'))
    createTree(tmp, {
      'app.js': '1',
      'README.md': '2',
      'notes.txt': '3',
      lib: { 'util.js': '4', 'guide.md': '5' }
    })

    const files = expandGlobs(tmp, ['**/*.*', '!**/*.{md,txt}'])
    assert.ok(files.includes('app.js'), 'should include app.js')
    assert.ok(files.includes(path.join('lib', 'util.js')), 'should include lib/util.js')
    assert.ok(!files.includes('README.md'), 'should exclude README.md')
    assert.ok(!files.includes('notes.txt'), 'should exclude notes.txt')
    assert.ok(!files.includes(path.join('lib', 'guide.md')), 'should exclude lib/guide.md')

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('fast path: no negation patterns behaves as before', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_neg_'))
    createTree(tmp, { 'a.js': '1', 'b.ts': '2' })

    const files = expandGlobs(tmp, ['**/*.js'])
    assert.ok(files.includes('a.js'))
    assert.ok(!files.includes('b.ts'))

    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
