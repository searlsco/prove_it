const { describe, it } = require('node:test')
const assert = require('node:assert')

// Test the command matching logic extracted from the hook
// These are unit tests for the regex matching and config merging

describe('commands that require tests', () => {
  // Note: git push removed from defaults - commit already runs full tests
  const defaultRegexes = [
    '(^|\\s)git\\s+commit\\b'
  ]

  // For testing additional triggers that users can add via config
  const withPushRegexes = [
    '(^|\\s)git\\s+commit\\b',
    '(^|\\s)git\\s+push\\b'
  ]

  const withBeadsRegexes = [
    '(^|\\s)git\\s+commit\\b',
    '(^|\\s)(beads|bd)\\s+(done|finish|close)\\b'
  ]

  function shouldRequireTests (command, regexes = defaultRegexes) {
    return regexes.some((re) => {
      try {
        return new RegExp(re, 'i').test(command)
      } catch {
        return false
      }
    })
  }

  describe('git commit', () => {
    it("requires tests for 'git commit'", () => {
      assert.ok(shouldRequireTests('git commit'))
    })

    it("requires tests for 'git commit -m message'", () => {
      assert.ok(shouldRequireTests('git commit -m "message"'))
    })

    it("requires tests for 'git commit --amend'", () => {
      assert.ok(shouldRequireTests('git commit --amend'))
    })

    it("does not require tests for 'git commits' (different word)", () => {
      assert.ok(!shouldRequireTests('git commits'))
    })

    it("does not require tests for 'git log --oneline' (different command)", () => {
      assert.ok(!shouldRequireTests('git log --oneline'))
    })
  })

  describe('git push (not blocked by default)', () => {
    it("does not require tests for 'git push' by default", () => {
      assert.ok(!shouldRequireTests('git push'))
    })

    it("does not require tests for 'git push origin main' by default", () => {
      assert.ok(!shouldRequireTests('git push origin main'))
    })

    it("requires tests for 'git push' when added to regexes", () => {
      assert.ok(shouldRequireTests('git push', withPushRegexes))
    })

    it("requires tests for 'git push --force' when added to regexes", () => {
      assert.ok(shouldRequireTests('git push --force', withPushRegexes))
    })

    it("does not require tests for 'git pull'", () => {
      assert.ok(!shouldRequireTests('git pull'))
    })
  })

  describe('beads/bd done/finish/close (not triggered by default)', () => {
    it("does not require tests for 'beads done' by default", () => {
      assert.ok(!shouldRequireTests('beads done'))
    })

    it("does not require tests for 'bd close' by default", () => {
      assert.ok(!shouldRequireTests('bd close'))
    })

    it("requires tests for 'bd close' when added to regexes", () => {
      assert.ok(shouldRequireTests('bd close', withBeadsRegexes))
    })

    it("requires tests for 'beads done 123' when added to regexes", () => {
      assert.ok(shouldRequireTests('beads done 123', withBeadsRegexes))
    })

    it("does not require tests for 'beads list' even when beads triggers added", () => {
      assert.ok(!shouldRequireTests('beads list', withBeadsRegexes))
    })
  })

  describe('compound commands', () => {
    it("requires tests for 'npm test && git commit -m done'", () => {
      assert.ok(shouldRequireTests('npm test && git commit -m "done"'))
    })

    it("requires tests for 'echo foo; git push' when push is enabled", () => {
      assert.ok(shouldRequireTests('echo foo; git push', withPushRegexes))
    })

    it("does not require tests for 'echo foo; git push' by default", () => {
      assert.ok(!shouldRequireTests('echo foo; git push'))
    })
  })

  describe("commands that don't require tests", () => {
    it("does not require tests for 'npm test'", () => {
      assert.ok(!shouldRequireTests('npm test'))
    })

    it("does not require tests for 'ls -la'", () => {
      assert.ok(!shouldRequireTests('ls -la'))
    })

    it("does not require tests for 'git status'", () => {
      assert.ok(!shouldRequireTests('git status'))
    })

    it("does not require tests for 'git diff'", () => {
      assert.ok(!shouldRequireTests('git diff'))
    })

    it("does not require tests for 'git add .'", () => {
      assert.ok(!shouldRequireTests('git add .'))
    })
  })
})

describe('local config write protection', () => {
  const { isConfigFileEdit, isLocalConfigWrite } = require('../lib/hooks/prove_it_edit')

  describe('blocks Write/Edit tools', () => {
    it('blocks Write to prove_it.json', () => {
      assert.ok(isConfigFileEdit('Write', { file_path: '/project/.claude/prove_it.json' }))
    })

    it('blocks Write to prove_it.local.json', () => {
      assert.ok(isConfigFileEdit('Write', { file_path: '/project/.claude/prove_it.local.json' }))
    })

    it('blocks Edit to prove_it.json', () => {
      assert.ok(isConfigFileEdit('Edit', { file_path: '.claude/prove_it.json' }))
    })

    it('blocks Edit to prove_it.local.json', () => {
      assert.ok(isConfigFileEdit('Edit', { file_path: '.claude/prove_it.local.json' }))
    })

    it('blocks Write to global prove_it/config.json', () => {
      assert.ok(isConfigFileEdit('Write', { file_path: '/Users/me/.claude/prove_it/config.json' }))
    })

    it('blocks Edit to global prove_it/config.json', () => {
      assert.ok(isConfigFileEdit('Edit', { file_path: '/home/user/.claude/prove_it/config.json' }))
    })

    it('allows Write to other files', () => {
      assert.ok(!isConfigFileEdit('Write', { file_path: '/project/src/index.js' }))
    })

    it('allows Edit to other files', () => {
      assert.ok(!isConfigFileEdit('Edit', { file_path: '.claude/settings.json' }))
    })

    it('allows Read tool', () => {
      assert.ok(!isConfigFileEdit('Read', { file_path: '.claude/prove_it.json' }))
    })

    it('allows Bash tool', () => {
      assert.ok(!isConfigFileEdit('Bash', { command: 'cat .claude/prove_it.json' }))
    })
  })

  describe('blocks writes', () => {
    it('blocks echo redirect', () => {
      assert.ok(isLocalConfigWrite('echo \'{"suiteGate":{"require":false}}\' > .claude/prove_it.local.json'))
    })

    it('blocks append redirect', () => {
      assert.ok(isLocalConfigWrite('echo foo >> .claude/prove_it.local.json'))
    })

    it('blocks tee', () => {
      assert.ok(isLocalConfigWrite('echo foo | tee .claude/prove_it.local.json'))
    })

    it('blocks tee -a', () => {
      assert.ok(isLocalConfigWrite('echo foo | tee -a .claude/prove_it.local.json'))
    })

    it('blocks with full path', () => {
      assert.ok(isLocalConfigWrite('echo foo > /Users/justin/project/.claude/prove_it.local.json'))
    })

    it('blocks mkdir && echo combo', () => {
      assert.ok(isLocalConfigWrite('mkdir -p .claude && echo \'{"suiteGate":{"require":false}}\' > .claude/prove_it.local.json'))
    })

    it('blocks redirect to prove_it.json', () => {
      assert.ok(isLocalConfigWrite('echo {} > .claude/prove_it.json'))
    })

    it('blocks redirect to global prove_it/config.json', () => {
      assert.ok(isLocalConfigWrite('echo {} > ~/.claude/prove_it/config.json'))
    })
  })

  describe('allows reads', () => {
    it('allows cat', () => {
      assert.ok(!isLocalConfigWrite('cat .claude/prove_it.local.json'))
    })

    it('allows grep', () => {
      assert.ok(!isLocalConfigWrite('grep require .claude/prove_it.local.json'))
    })

    it('allows jq', () => {
      assert.ok(!isLocalConfigWrite('jq . .claude/prove_it.local.json'))
    })

    it('allows input redirect (reading)', () => {
      assert.ok(!isLocalConfigWrite('jq . < .claude/prove_it.local.json'))
    })
  })

  describe('ignores other files', () => {
    it('allows writing to other json files', () => {
      assert.ok(!isLocalConfigWrite('echo {} > .claude/other.json'))
    })

    it('blocks writing to global prove_it/config.json', () => {
      assert.ok(isLocalConfigWrite('echo {} > ~/.claude/prove_it/config.json'))
    })
  })
})

describe('config merging', () => {
  const { mergeDeep } = require('../lib/shared')

  it('merges nested objects', () => {
    const base = { suiteGate: { command: './scripts/test', require: true } }
    const override = { suiteGate: { command: 'npm test' } }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, {
      suiteGate: { command: 'npm test', require: true }
    })
  })

  it('overrides arrays entirely', () => {
    const base = { triggers: ['a', 'b'] }
    const override = { triggers: ['c'] }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { triggers: ['c'] })
  })

  it('handles null override', () => {
    const base = { foo: 'bar' }
    const result = mergeDeep(base, null)
    assert.deepStrictEqual(result, { foo: 'bar' })
  })

  it('handles undefined override', () => {
    const base = { foo: 'bar' }
    const result = mergeDeep(base, undefined)
    assert.deepStrictEqual(result, { foo: 'bar' })
  })

  it('override scalar values', () => {
    const base = { cacheSeconds: 900 }
    const override = { cacheSeconds: 300 }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { cacheSeconds: 300 })
  })

  it('merges false values correctly', () => {
    const base = { suiteGate: { require: true, command: './script/test' } }
    const override = { suiteGate: { require: false } }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { suiteGate: { require: false, command: './script/test' } })
  })

  it('merges zero values correctly', () => {
    const base = { cacheSeconds: 900 }
    const override = { cacheSeconds: 0 }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { cacheSeconds: 0 })
  })

  it('merges empty string values correctly', () => {
    const base = { name: 'foo' }
    const override = { name: '' }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { name: '' })
  })
})

describe('loadEffectiveConfig ancestor discovery', () => {
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const { loadEffectiveConfig, defaultTestConfig } = require('../lib/shared')

  const tmpBase = path.join(os.tmpdir(), 'prove_it_config_test_' + Date.now())

  // Setup: create nested directory structure
  // tmpBase/
  //   .claude/prove_it.json  (root config)
  //   child/
  //     .claude/prove_it.json  (child config)
  //     grandchild/
  //       (no config - should inherit)

  function setup () {
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(tmpBase, 'child', '.claude'), { recursive: true })
    fs.mkdirSync(path.join(tmpBase, 'child', 'grandchild'), { recursive: true })

    fs.writeFileSync(
      path.join(tmpBase, '.claude', 'prove_it.json'),
      JSON.stringify({ commands: { test: { full: './root-test' } } })
    )
    fs.writeFileSync(
      path.join(tmpBase, 'child', '.claude', 'prove_it.json'),
      JSON.stringify({ commands: { test: { fast: './child-fast' } } })
    )
  }

  function cleanup () {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }

  it('loads config from cwd', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child'), defaultTestConfig)
      assert.strictEqual(cfg.commands.test.fast, './child-fast')
    } finally {
      cleanup()
    }
  })

  it('inherits ancestor config (child overrides root)', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child'), defaultTestConfig)
      // Root sets full, child sets fast - both should be present
      assert.strictEqual(cfg.commands.test.full, './root-test')
      assert.strictEqual(cfg.commands.test.fast, './child-fast')
    } finally {
      cleanup()
    }
  })

  it('grandchild inherits from ancestors', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child', 'grandchild'), defaultTestConfig)
      // Grandchild has no config, should inherit from child and root
      assert.strictEqual(cfg.commands.test.full, './root-test')
      assert.strictEqual(cfg.commands.test.fast, './child-fast')
    } finally {
      cleanup()
    }
  })

  it('cwd config wins over ancestors', () => {
    setup()
    // Add grandchild config that overrides
    fs.mkdirSync(path.join(tmpBase, 'child', 'grandchild', '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpBase, 'child', 'grandchild', '.claude', 'prove_it.json'),
      JSON.stringify({ commands: { test: { full: './grandchild-test' } } })
    )
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child', 'grandchild'), defaultTestConfig)
      // Grandchild overrides root's full, keeps child's fast
      assert.strictEqual(cfg.commands.test.full, './grandchild-test')
      assert.strictEqual(cfg.commands.test.fast, './child-fast')
    } finally {
      cleanup()
    }
  })

  it('uses defaults when no config found', () => {
    const emptyDir = path.join(os.tmpdir(), 'prove_it_empty_' + Date.now())
    fs.mkdirSync(emptyDir, { recursive: true })
    try {
      const { cfg } = loadEffectiveConfig(emptyDir, defaultTestConfig)
      // Should have default values
      assert.strictEqual(cfg.hooks.stop.enabled, true)
      assert.strictEqual(cfg.commands.test.full, null)
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('isIgnoredPath', () => {
  const os = require('os')
  const path = require('path')
  const { isIgnoredPath } = require('../lib/shared')
  const home = os.homedir()

  it('returns false for empty ignoredPaths', () => {
    assert.strictEqual(isIgnoredPath('/some/path', []), false)
    assert.strictEqual(isIgnoredPath('/some/path', null), false)
    assert.strictEqual(isIgnoredPath('/some/path', undefined), false)
  })

  it('matches absolute paths exactly', () => {
    assert.strictEqual(isIgnoredPath('/Users/test/bin', ['/Users/test/bin']), true)
    assert.strictEqual(isIgnoredPath('/Users/test/bin', ['/Users/other/bin']), false)
  })

  it('matches home-relative paths with ~', () => {
    const binPath = path.join(home, 'bin')
    assert.strictEqual(isIgnoredPath(binPath, ['~/bin']), true)
    assert.strictEqual(isIgnoredPath(binPath, ['~/other']), false)
  })

  it('matches subdirectories of ignored paths', () => {
    const subPath = path.join(home, 'bin', 'scripts')
    assert.strictEqual(isIgnoredPath(subPath, ['~/bin']), true)
  })

  it('does not match partial directory names', () => {
    const binPath = path.join(home, 'binary')
    assert.strictEqual(isIgnoredPath(binPath, ['~/bin']), false)
  })

  it('handles multiple ignored paths', () => {
    const binPath = path.join(home, 'bin')
    const dotfilesPath = path.join(home, 'dotfiles')
    assert.strictEqual(isIgnoredPath(binPath, ['~/dotfiles', '~/bin']), true)
    assert.strictEqual(isIgnoredPath(dotfilesPath, ['~/dotfiles', '~/bin']), true)
    assert.strictEqual(isIgnoredPath(path.join(home, 'code'), ['~/dotfiles', '~/bin']), false)
  })
})

describe('logReview', () => {
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const { logReview } = require('../lib/shared')

  const tmpBase = path.join(os.tmpdir(), 'prove_it_log_test_' + Date.now())
  const originalProveItDir = process.env.PROVE_IT_DIR

  function setup () {
    fs.mkdirSync(tmpBase, { recursive: true })
    process.env.PROVE_IT_DIR = tmpBase
  }

  function cleanup () {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }) } catch {}
    if (originalProveItDir !== undefined) {
      process.env.PROVE_IT_DIR = originalProveItDir
    } else {
      delete process.env.PROVE_IT_DIR
    }
  }

  it('appends review entry to session log file', () => {
    setup()

    logReview('test-session-123', '/some/project', 'code', 'PASS', null)

    const logFile = path.join(tmpBase, 'sessions', 'test-session-123.jsonl')
    assert.ok(fs.existsSync(logFile), 'Log file should be created')
    const content = fs.readFileSync(logFile, 'utf8')
    const lastEntry = JSON.parse(content.trim().split('\n').pop())
    assert.strictEqual(lastEntry.reviewer, 'code')
    assert.strictEqual(lastEntry.status, 'PASS')
    assert.strictEqual(lastEntry.projectDir, '/some/project')
    assert.strictEqual(lastEntry.sessionId, 'test-session-123')

    cleanup()
  })

  it('logs FAIL with reason', () => {
    setup()

    logReview('test-session-456', '/another/project', 'coverage', 'FAIL', 'Missing tests for new function')

    const logFile = path.join(tmpBase, 'sessions', 'test-session-456.jsonl')
    assert.ok(fs.existsSync(logFile), 'Log file should be created')
    const lastEntry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').pop())
    assert.strictEqual(lastEntry.reviewer, 'coverage')
    assert.strictEqual(lastEntry.status, 'FAIL')
    assert.strictEqual(lastEntry.reason, 'Missing tests for new function')

    cleanup()
  })

  it('skips logging when no session ID', () => {
    setup()

    logReview(null, '/project', 'code', 'PASS', null)

    const logFile = path.join(tmpBase, 'sessions', 'unknown.jsonl')
    assert.ok(!fs.existsSync(logFile), 'Should not create unknown.jsonl')

    cleanup()
  })
})

describe('session state', () => {
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const { loadSessionState, saveSessionState } = require('../lib/shared')

  const tmpBase = path.join(os.tmpdir(), 'prove_it_state_test_' + Date.now())
  const originalProveItDir = process.env.PROVE_IT_DIR

  function setup () {
    fs.mkdirSync(tmpBase, { recursive: true })
    process.env.PROVE_IT_DIR = tmpBase
  }

  function cleanup () {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }) } catch {}
    if (originalProveItDir !== undefined) {
      process.env.PROVE_IT_DIR = originalProveItDir
    } else {
      delete process.env.PROVE_IT_DIR
    }
  }

  it('returns null when sessionId is null', () => {
    setup()
    const result = loadSessionState(null, 'last_review_snapshot')
    assert.strictEqual(result, null)
    cleanup()
  })

  it('saveSessionState is a no-op when sessionId is null', () => {
    setup()
    saveSessionState(null, 'last_review_snapshot', 'some-value')
    cleanup()
  })

  it('round-trips a value via save and load', () => {
    setup()

    saveSessionState('test-roundtrip', 'last_review_snapshot', 'msg-abc-123')
    const result = loadSessionState('test-roundtrip', 'last_review_snapshot')
    assert.strictEqual(result, 'msg-abc-123')

    cleanup()
  })

  it('supports multiple keys in the same state file', () => {
    setup()

    saveSessionState('test-multikey', 'key_a', 'value_a')
    saveSessionState('test-multikey', 'key_b', 'value_b')

    assert.strictEqual(loadSessionState('test-multikey', 'key_a'), 'value_a')
    assert.strictEqual(loadSessionState('test-multikey', 'key_b'), 'value_b')

    cleanup()
  })

  it('returns null for a key that does not exist in state file', () => {
    setup()

    saveSessionState('test-missing-key', 'existing_key', 'some_value')
    const result = loadSessionState('test-missing-key', 'nonexistent_key')
    assert.strictEqual(result, null)

    cleanup()
  })

  it('isolates state between sessions (the core property)', () => {
    setup()

    saveSessionState('session-A', 'last_review_snapshot', 'msg-from-A')
    saveSessionState('session-B', 'last_review_snapshot', 'msg-from-B')

    assert.strictEqual(loadSessionState('session-A', 'last_review_snapshot'), 'msg-from-A')
    assert.strictEqual(loadSessionState('session-B', 'last_review_snapshot'), 'msg-from-B')

    cleanup()
  })

  it('does not write to prove_it.local.json', () => {
    setup()
    const projectTmp = path.join(os.tmpdir(), 'prove_it_local_check_' + Date.now())
    fs.mkdirSync(path.join(projectTmp, '.claude'), { recursive: true })
    const localCfgPath = path.join(projectTmp, '.claude', 'prove_it.local.json')

    saveSessionState('test-no-local', 'last_review_snapshot', 'msg-xyz')

    assert.strictEqual(fs.existsSync(localCfgPath), false,
      'saveSessionState should not create prove_it.local.json')
    assert.strictEqual(loadSessionState('test-no-local', 'last_review_snapshot'), 'msg-xyz')

    fs.rmSync(projectTmp, { recursive: true, force: true })
    cleanup()
  })
})

describe('generateUnifiedDiff', () => {
  const { generateUnifiedDiff } = require('../lib/shared')

  it('returns null when content is identical', () => {
    assert.strictEqual(generateUnifiedDiff('file.js', 'hello\n', 'hello\n'), null)
  })

  it('shows a single-line change', () => {
    const diff = generateUnifiedDiff('file.js', 'hello\n', 'world\n')
    assert.ok(diff.includes('--- a/file.js'))
    assert.ok(diff.includes('+++ b/file.js'))
    assert.ok(diff.includes('-hello'))
    assert.ok(diff.includes('+world'))
  })

  it('shows added lines', () => {
    const diff = generateUnifiedDiff('file.js', 'a\nb\n', 'a\nb\nc\n')
    assert.ok(diff.includes('+c'))
    assert.ok(!diff.includes('-c'))
  })

  it('shows removed lines', () => {
    const diff = generateUnifiedDiff('file.js', 'a\nb\nc\n', 'a\nb\n')
    assert.ok(diff.includes('-c'))
    assert.ok(!diff.includes('+c'))
  })

  it('handles empty old content (new file)', () => {
    const diff = generateUnifiedDiff('new.js', '', 'line1\nline2\n')
    assert.ok(diff.includes('+line1'))
    assert.ok(diff.includes('+line2'))
  })

  it('handles empty new content (deleted file)', () => {
    const diff = generateUnifiedDiff('old.js', 'line1\nline2\n', '')
    assert.ok(diff.includes('-line1'))
    assert.ok(diff.includes('-line2'))
  })

  it('includes context lines around changes', () => {
    const old = 'a\nb\nc\nd\ne\n'
    const nu = 'a\nb\nX\nd\ne\n'
    const diff = generateUnifiedDiff('file.js', old, nu)
    // Context should include 'a' or 'b' before the change
    assert.ok(diff.includes(' a') || diff.includes(' b'), 'Should include context before change')
    assert.ok(diff.includes('-c'))
    assert.ok(diff.includes('+X'))
  })

  it('handles multiple hunks', () => {
    const old = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n'
    const nu = '1\nX\n3\n4\n5\n6\n7\n8\nY\n10\n'
    const diff = generateUnifiedDiff('file.js', old, nu)
    assert.ok(diff.includes('-2'))
    assert.ok(diff.includes('+X'))
    assert.ok(diff.includes('-9'))
    assert.ok(diff.includes('+Y'))
  })

  it('hunk headers include line counts', () => {
    const diff = generateUnifiedDiff('file.js', 'a\nb\nc\n', 'a\nb\nX\n')
    assert.ok(diff, 'Should produce a diff')
    const hunkHeader = diff.split('\n').find((l) => l.startsWith('@@'))
    assert.ok(hunkHeader, 'Should have a hunk header')
    assert.match(hunkHeader, /@@ -\d+,\d+ \+\d+,\d+ @@/, 'Hunk header should include counts')
  })

  it('line numbers diverge on add', () => {
    // Adding a line makes new side longer than old
    const old = 'a\nb\nc\n'
    const nu = 'a\nb\nINSERTED\nc\n'
    const diff = generateUnifiedDiff('file.js', old, nu)
    assert.ok(diff, 'Should produce a diff')
    assert.ok(diff.includes('+INSERTED'), 'Should show added line')
  })

  it('line numbers diverge on delete', () => {
    // Deleting a line makes old side longer than new
    const old = 'a\nb\nc\nd\n'
    const nu = 'a\nb\nd\n'
    const diff = generateUnifiedDiff('file.js', old, nu)
    assert.ok(diff, 'Should produce a diff')
    assert.ok(diff.includes('-c'), 'Should show removed line')
  })
})

describe('globToRegex', () => {
  const { globToRegex } = require('../lib/shared')

  it('matches simple wildcard', () => {
    const re = globToRegex('*.js')
    assert.ok(re.test('foo.js'))
    assert.ok(re.test('bar.js'))
    assert.ok(!re.test('foo.ts'))
    assert.ok(!re.test('dir/foo.js'), 'Single * should not match path separators')
  })

  it('matches globstar (**)', () => {
    const re = globToRegex('**/*.js')
    // **/ matches zero or more directory segments
    assert.ok(re.test('foo.js'), '**/ should match zero directory segments (root-level)')
    assert.ok(re.test('src/foo.js'))
    assert.ok(re.test('src/deep/foo.js'))
    assert.ok(!re.test('src/foo.ts'))
  })

  it('matches globstar with prefix (lib/**/*.js)', () => {
    const re = globToRegex('lib/**/*.js')
    assert.ok(re.test('lib/shared.js'), 'Should match files directly in lib/')
    assert.ok(re.test('lib/hooks/beads.js'), 'Should match nested files')
    assert.ok(!re.test('lib/shared.ts'), 'Should not match wrong extension')
    assert.ok(!re.test('src/shared.js'), 'Should not match wrong prefix')
  })

  it('matches single character wildcard (?)', () => {
    const re = globToRegex('file?.js')
    assert.ok(re.test('file1.js'))
    assert.ok(re.test('fileA.js'))
    assert.ok(!re.test('file12.js'), '? should match exactly one character')
  })

  it('escapes regex special characters', () => {
    const re = globToRegex('file.test.js')
    assert.ok(re.test('file.test.js'))
    assert.ok(!re.test('fileXtestXjs'), 'Dots should be literal, not regex wildcards')
  })

  it('matches exact filename without wildcards', () => {
    const re = globToRegex('package.json')
    assert.ok(re.test('package.json'))
    assert.ok(!re.test('other.json'))
    assert.ok(!re.test('dir/package.json'))
  })
})

describe('walkDir', () => {
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const { walkDir, globToRegex } = require('../lib/shared')

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
    assert.ok(files.has('a.js'))
    assert.ok(!files.has('b.ts'))
    assert.ok(!files.has(path.join('sub', 'c.js')), '*.js should not match subdirectory files')

    // **/*.js matches files at any depth including root
    const deepFiles = new Set()
    walkDir(tmp, tmp, globToRegex('**/*.js'), deepFiles)
    assert.ok(deepFiles.has(path.join('sub', 'c.js')))
    assert.ok(deepFiles.has('a.js'), '**/*.js should match root-level files too')

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
    assert.ok(files.has(path.join('src', 'a.js')))
    assert.strictEqual(files.size, 1, 'Should only find src/a.js, skipping .hidden and node_modules')

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns empty set for nonexistent directory', () => {
    const files = new Set()
    walkDir('/nonexistent', '/nonexistent', globToRegex('*.js'), files)
    assert.strictEqual(files.size, 0)
  })
})
