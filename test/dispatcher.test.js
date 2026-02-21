const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { freshRepo } = require('./helpers')
const { matchesHookEntry, evaluateWhen, defaultConfig, BUILTIN_EDIT_TOOLS, PREREQUISITE_KEYS, TRIGGER_KEYS } = require('../lib/dispatcher/claude')
const { recordFileEdit, resetTurnTracking } = require('../lib/session')
const { updateRef, churnSinceRef, sanitizeRefName, incrementGross, grossChurnSince } = require('../lib/git')

describe('claude dispatcher', () => {
  describe('matchesHookEntry', () => {
    it('matches type and event', () => {
      const entry = { type: 'claude', event: 'Stop', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'Stop', {}), true)
    })

    it('rejects wrong type', () => {
      const entry = { type: 'git', event: 'Stop', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'Stop', {}), false)
    })

    it('rejects wrong event', () => {
      const entry = { type: 'claude', event: 'PreToolUse', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'Stop', {}), false)
    })

    it('matches tool name via matcher', () => {
      const entry = { type: 'claude', event: 'PreToolUse', matcher: 'Edit|Write', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Edit' }), true)
    })

    it('rejects non-matching tool name', () => {
      const entry = { type: 'claude', event: 'PreToolUse', matcher: 'Edit|Write', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Read' }), false)
    })

    it('matches when no matcher specified', () => {
      const entry = { type: 'claude', event: 'PreToolUse', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Read' }), true)
    })

    it('matches triggers for Bash commands', () => {
      const entry = {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Bash',
        triggers: ['(^|\\s)git\\s+commit\\b'],
        tasks: []
      }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' }
      }), true)
    })

    it('rejects non-matching triggers', () => {
      const entry = {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Bash',
        triggers: ['(^|\\s)git\\s+commit\\b'],
        tasks: []
      }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'git status' }
      }), false)
    })

    it('matches SessionStart source', () => {
      const entry = { type: 'claude', event: 'SessionStart', source: 'startup|resume', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'SessionStart', { source: 'startup' }), true)
    })

    it('rejects non-matching SessionStart source', () => {
      const entry = { type: 'claude', event: 'SessionStart', source: 'startup|resume', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'SessionStart', { source: 'clear' }), false)
    })

    it('matches SessionStart with no source filter', () => {
      const entry = { type: 'claude', event: 'SessionStart', tasks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'SessionStart', { source: 'anything' }), true)
    })
  })

  describe('evaluateWhen', () => {
    it('returns true when no conditions', () => {
      assert.strictEqual(evaluateWhen(null, { rootDir: '.' }), true)
    })

    it('returns true when undefined', () => {
      assert.strictEqual(evaluateWhen(undefined, { rootDir: '.' }), true)
    })

    it('checks fileExists — passes when file exists', () => {
      assert.strictEqual(evaluateWhen({ fileExists: 'package.json' }, { rootDir: process.cwd() }), true)
    })

    it('checks fileExists — returns reason when file missing', () => {
      const result = evaluateWhen({ fileExists: 'nonexistent-file-xyz.json' }, { rootDir: process.cwd() })
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('was not found'), `Expected 'was not found' reason, got: ${result}`)
      assert.ok(result.includes('nonexistent-file-xyz.json'), `Expected path in reason, got: ${result}`)
    })

    it('checks envSet — passes when env var is set', () => {
      process.env.PROVE_IT_TEST_VAR = '1'
      try {
        assert.strictEqual(evaluateWhen({ envSet: 'PROVE_IT_TEST_VAR' }, { rootDir: '.' }), true)
      } finally {
        delete process.env.PROVE_IT_TEST_VAR
      }
    })

    it('checks envSet — returns reason when env var is unset', () => {
      delete process.env.PROVE_IT_FAKE_ENV_VAR
      const result = evaluateWhen({ envSet: 'PROVE_IT_FAKE_ENV_VAR' }, { rootDir: '.' })
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('was not set'), `Expected 'was not set' reason, got: ${result}`)
      assert.ok(result.includes('$PROVE_IT_FAKE_ENV_VAR'), `Expected var name in reason, got: ${result}`)
    })

    it('checks envNotSet — passes when env var is unset', () => {
      delete process.env.PROVE_IT_FAKE_ENV_VAR2
      assert.strictEqual(evaluateWhen({ envNotSet: 'PROVE_IT_FAKE_ENV_VAR2' }, { rootDir: '.' }), true)
    })

    it('checks envNotSet — returns reason when env var is set', () => {
      process.env.PROVE_IT_TEST_VAR2 = 'yes'
      try {
        const result = evaluateWhen({ envNotSet: 'PROVE_IT_TEST_VAR2' }, { rootDir: '.' })
        assert.notStrictEqual(result, true)
        assert.ok(result.includes('was set'), `Expected 'was set' reason, got: ${result}`)
        assert.ok(result.includes('$PROVE_IT_TEST_VAR2'), `Expected var name in reason, got: ${result}`)
      } finally {
        delete process.env.PROVE_IT_TEST_VAR2
      }
    })

    describe('variablesPresent', () => {
      let tmpDir

      beforeEach(() => {
        tmpDir = freshRepo((dir) => {
          fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n')
        })
      })

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      })

      it('passes when variable resolves to non-empty value', () => {
        // Stage a change so staged_diff is non-empty
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'changed\n')
        spawnSync('git', ['add', 'file.txt'], { cwd: tmpDir })

        const result = evaluateWhen(
          { variablesPresent: ['staged_diff'] },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
        )
        assert.strictEqual(result, true)
      })

      it('returns reason when variable resolves to empty (no staged changes)', () => {
        const result = evaluateWhen(
          { variablesPresent: ['staged_diff'] },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
        )
        assert.notStrictEqual(result, true)
        assert.ok(result.includes('staged_diff'), `Expected variable name in reason, got: ${result}`)
        assert.ok(result.includes('was not present'), `Expected 'was not present' in reason, got: ${result}`)
      })

      it('returns reason for session_diff when sessionId is null', () => {
        const result = evaluateWhen(
          { variablesPresent: ['session_diff'] },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
        )
        assert.notStrictEqual(result, true)
        assert.ok(result.includes('session_diff'), `Expected variable name in reason, got: ${result}`)
      })

      it('returns reason for unknown variable name', () => {
        const result = evaluateWhen(
          { variablesPresent: ['nonexistent_var'] },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
        )
        assert.notStrictEqual(result, true)
        assert.ok(result.includes('nonexistent_var'), `Expected variable name in reason, got: ${result}`)
        assert.ok(result.includes('is not a known variable'), `Expected 'is not a known variable' in reason, got: ${result}`)
      })

      it('passes for empty array', () => {
        const result = evaluateWhen(
          { variablesPresent: [] },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
        )
        assert.strictEqual(result, true)
      })
    })
  })

  describe('evaluateWhen — linesChanged (git-based)', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = freshRepo((dir) => {
        fs.writeFileSync(path.join(dir, 'app.js'), 'initial\n')
      })
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns reason on bootstrap (0 churn)', () => {
      const result = evaluateWhen(
        { linesChanged: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('0'), `Expected 0 in reason, got: ${result}`)
      assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
      assert.ok(result.includes('lines changed since last run'), `Expected reason, got: ${result}`)
    })

    it('returns true when churn meets threshold', () => {
      // Bootstrap ref
      churnSinceRef(tmpDir, sanitizeRefName('my-check'), ['**/*.js'])

      // Generate enough churn
      const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add lines'], { cwd: tmpDir })

      const result = evaluateWhen(
        { linesChanged: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.strictEqual(result, true)
    })

    it('returns reason when churn is below threshold', () => {
      // Bootstrap ref
      churnSinceRef(tmpDir, sanitizeRefName('my-check'), ['**/*.js'])

      // Small change
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'initial\nsmall change\n')
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'small'], { cwd: tmpDir })

      const result = evaluateWhen(
        { linesChanged: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
    })

    it('resets after ref is advanced (simulating pass)', () => {
      churnSinceRef(tmpDir, sanitizeRefName('my-check'), ['**/*.js'])

      // Generate churn
      const lines = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'big change'], { cwd: tmpDir })

      // Fires
      const result = evaluateWhen(
        { linesChanged: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.strictEqual(result, true)

      // Advance ref (what dispatcher does on pass)
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
      updateRef(tmpDir, sanitizeRefName('my-check'), head)

      // Should not fire anymore
      const result2 = evaluateWhen(
        { linesChanged: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.notStrictEqual(result2, true)
    })

    it('fires again after more churn post-reset', () => {
      churnSinceRef(tmpDir, sanitizeRefName('my-check'), ['**/*.js'])

      // First round of churn
      const lines = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'round 1'], { cwd: tmpDir })

      // Advance ref (pass)
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
      updateRef(tmpDir, sanitizeRefName('my-check'), head)

      // Second round of churn
      const lines2 = Array.from({ length: 500 }, (_, i) => `new_line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines2)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'round 2'], { cwd: tmpDir })

      const result = evaluateWhen(
        { linesChanged: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.strictEqual(result, true)
    })

    it('returns reason in non-git directory (0 churn)', () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_nogit_'))
      try {
        const result = evaluateWhen(
          { linesChanged: 500 },
          { rootDir: nonGitDir, sources: ['**/*.js'] },
          'my-check'
        )
        assert.notStrictEqual(result, true)
        assert.ok(result.includes('0'), `Expected 0 in reason, got: ${result}`)
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true })
      }
    })
  })

  describe('evaluateWhen — linesWritten (gross churn)', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = freshRepo((dir) => {
        fs.writeFileSync(path.join(dir, 'app.js'), 'initial\n')
      })
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns reason on bootstrap (0 gross churn)', () => {
      const result = evaluateWhen(
        { linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('0'), `Expected 0 in reason, got: ${result}`)
      assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
      assert.ok(result.includes('gross lines changed'), `Expected reason, got: ${result}`)
    })

    it('returns true when gross churn meets threshold', () => {
      // Bootstrap
      grossChurnSince(tmpDir, sanitizeRefName('my-check'))
      // Accumulate enough gross churn
      incrementGross(tmpDir, 600)

      const result = evaluateWhen(
        { linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.strictEqual(result, true)
    })

    it('returns reason when gross churn is below threshold', () => {
      grossChurnSince(tmpDir, sanitizeRefName('my-check'))
      incrementGross(tmpDir, 100)

      const result = evaluateWhen(
        { linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'my-check'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('100'), `Expected churn in reason, got: ${result}`)
      assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
    })

    it('OR-ed triggers — gross passes, net fails → task fires', () => {
      // Bootstrap both refs
      churnSinceRef(tmpDir, sanitizeRefName('dual-check'), ['**/*.js'])
      grossChurnSince(tmpDir, sanitizeRefName('dual-check'))

      // Gross churn meets threshold, but net churn does not
      incrementGross(tmpDir, 600)

      const result = evaluateWhen(
        { linesChanged: 500, linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'dual-check'
      )
      // Triggers are OR-ed: gross passes → task fires even though net fails
      assert.strictEqual(result, true)
    })
  })

  describe('evaluateWhen — sourcesModifiedSinceLastRun', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_smslr_'))
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('passes on first run (no prior run data)', () => {
      // Create a source file so latestSourceMtime > 0
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime } = require('../lib/testing')
      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        {
          rootDir: tmpDir,
          localCfgPath: path.join(tmpDir, '.claude', 'prove_it/config.local.json'),
          latestSourceMtime: getLatestMtime(tmpDir, ['**/*.js'])
        },
        'my-task'
      )
      assert.strictEqual(result, true)
    })

    it('skips when sources have not changed since last run', () => {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime, saveRunData } = require('../lib/testing')
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      const mtime = getLatestMtime(tmpDir, ['**/*.js'])
      // Record a run after the source was last modified
      saveRunData(localCfgPath, 'my-task', { at: mtime + 1000 })

      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, localCfgPath, latestSourceMtime: mtime },
        'my-task'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('no sources were modified'), `Expected reason, got: ${result}`)
    })

    it('passes through cached failures (pass: false) even when sources unchanged', () => {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime, saveRunData } = require('../lib/testing')
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      const mtime = getLatestMtime(tmpDir, ['**/*.js'])
      // Record a failed run after the source was last modified
      saveRunData(localCfgPath, 'my-task', { at: mtime + 1000, pass: false })

      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, localCfgPath, latestSourceMtime: mtime },
        'my-task'
      )
      assert.strictEqual(result, true, 'Should pass through so cached failure re-fires')
    })

    it('passes when sources are newer than last run', () => {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime, saveRunData } = require('../lib/testing')
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      // Record a run well in the past
      saveRunData(localCfgPath, 'my-task', { at: 1000 })
      const mtime = getLatestMtime(tmpDir, ['**/*.js'])

      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, localCfgPath, latestSourceMtime: mtime },
        'my-task'
      )
      assert.strictEqual(result, true)
    })

    it('passes through result: skip even when sources unchanged', () => {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime, saveRunData } = require('../lib/testing')
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      const mtime = getLatestMtime(tmpDir, ['**/*.js'])
      // New format: result: 'skip'
      saveRunData(localCfgPath, 'my-task', { at: mtime + 1000, result: 'skip' })

      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, localCfgPath, latestSourceMtime: mtime },
        'my-task'
      )
      assert.strictEqual(result, true, 'Should re-fire on skip result (not suppress)')
    })

    it('suppresses re-run for result: pass (new format)', () => {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime, saveRunData } = require('../lib/testing')
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      const mtime = getLatestMtime(tmpDir, ['**/*.js'])
      saveRunData(localCfgPath, 'my-task', { at: mtime + 1000, result: 'pass' })

      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, localCfgPath, latestSourceMtime: mtime },
        'my-task'
      )
      assert.notStrictEqual(result, true, 'Should suppress re-run on pass result')
    })

    it('backward compat: pass: true (old format) still suppresses re-run', () => {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime, saveRunData } = require('../lib/testing')
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      const mtime = getLatestMtime(tmpDir, ['**/*.js'])
      // Old format
      saveRunData(localCfgPath, 'my-task', { at: mtime + 1000, pass: true })

      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, localCfgPath, latestSourceMtime: mtime },
        'my-task'
      )
      assert.notStrictEqual(result, true, 'Old format pass: true should still suppress')
    })

    it('skips when latestSourceMtime is 0 (no source files)', () => {
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, localCfgPath, latestSourceMtime: 0 },
        'my-task'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('no source files were found'), `Expected reason, got: ${result}`)
    })
  })

  describe('evaluateWhen — toolsUsed', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_tu_'))
      origProveItDir = process.env.PROVE_IT_DIR
      process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
    })

    afterEach(() => {
      if (origProveItDir === undefined) {
        delete process.env.PROVE_IT_DIR
      } else {
        process.env.PROVE_IT_DIR = origProveItDir
      }
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('PreToolUse passes when toolName is in the list', () => {
      const result = evaluateWhen(
        { toolsUsed: ['XcodeEdit', 'Edit'] },
        { rootDir: '.', hookEvent: 'PreToolUse', toolName: 'Edit', sessionId: null }
      )
      assert.strictEqual(result, true)
    })

    it('PreToolUse skips when toolName is not in the list', () => {
      const result = evaluateWhen(
        { toolsUsed: ['XcodeEdit'] },
        { rootDir: '.', hookEvent: 'PreToolUse', toolName: 'Edit', sessionId: null }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('none of'), `Expected skip reason, got: ${result}`)
    })

    it('Stop passes when a listed tool was used', () => {
      const sessionId = 'test-tu-stop-pass'
      recordFileEdit(sessionId, 'XcodeEdit', 'src/app.swift')
      const result = evaluateWhen(
        { toolsUsed: ['XcodeEdit'] },
        { rootDir: '.', hookEvent: 'Stop', sessionId }
      )
      assert.strictEqual(result, true)
    })

    it('Stop skips when no listed tool was used', () => {
      const sessionId = 'test-tu-stop-skip'
      recordFileEdit(sessionId, 'Edit', 'src/app.js')
      const result = evaluateWhen(
        { toolsUsed: ['XcodeEdit'] },
        { rootDir: '.', hookEvent: 'Stop', sessionId }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('none of'), `Expected skip reason, got: ${result}`)
    })

    it('Stop skips when no edits recorded at all', () => {
      const result = evaluateWhen(
        { toolsUsed: ['Edit'] },
        { rootDir: '.', hookEvent: 'Stop', sessionId: 'test-tu-no-edits' }
      )
      assert.notStrictEqual(result, true)
    })

    it('SessionStart always skips', () => {
      const result = evaluateWhen(
        { toolsUsed: ['Edit'] },
        { rootDir: '.', hookEvent: 'SessionStart', sessionId: null }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('not applicable'), `Expected not applicable reason, got: ${result}`)
    })
  })

  describe('evaluateWhen — sourceFilesEdited', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_sfe_'))
      origProveItDir = process.env.PROVE_IT_DIR
      process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
    })

    afterEach(() => {
      if (origProveItDir === undefined) {
        delete process.env.PROVE_IT_DIR
      } else {
        process.env.PROVE_IT_DIR = origProveItDir
      }
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('PreToolUse passes when tool is an edit tool and file matches sources', () => {
      const result = evaluateWhen(
        { sourceFilesEdited: true },
        {
          rootDir: tmpDir,
          hookEvent: 'PreToolUse',
          toolName: 'Edit',
          toolInput: { file_path: 'src/app.js' },
          sources: ['**/*.js'],
          fileEditingTools: BUILTIN_EDIT_TOOLS,
          sessionId: null
        }
      )
      assert.strictEqual(result, true)
    })

    it('PreToolUse skips when tool is not an edit tool', () => {
      const result = evaluateWhen(
        { sourceFilesEdited: true },
        {
          rootDir: tmpDir,
          hookEvent: 'PreToolUse',
          toolName: 'Read',
          toolInput: { file_path: 'src/app.js' },
          sources: ['**/*.js'],
          fileEditingTools: BUILTIN_EDIT_TOOLS,
          sessionId: null
        }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('no source files were edited'), `Expected skip reason, got: ${result}`)
    })

    it('PreToolUse skips when file is not a source file', () => {
      const result = evaluateWhen(
        { sourceFilesEdited: true },
        {
          rootDir: tmpDir,
          hookEvent: 'PreToolUse',
          toolName: 'Edit',
          toolInput: { file_path: 'README.md' },
          sources: ['**/*.js'],
          fileEditingTools: BUILTIN_EDIT_TOOLS,
          sessionId: null
        }
      )
      assert.notStrictEqual(result, true)
    })

    it('PreToolUse passes for custom fileEditingTools', () => {
      const result = evaluateWhen(
        { sourceFilesEdited: true },
        {
          rootDir: tmpDir,
          hookEvent: 'PreToolUse',
          toolName: 'XcodeEdit',
          toolInput: { file_path: 'src/app.swift' },
          sources: ['**/*.swift'],
          fileEditingTools: [...BUILTIN_EDIT_TOOLS, 'XcodeEdit'],
          sessionId: null
        }
      )
      assert.strictEqual(result, true)
    })

    it('Stop passes when session has file edits', () => {
      const sessionId = 'test-sfe-stop-pass'
      recordFileEdit(sessionId, 'Edit', 'src/app.js')
      const result = evaluateWhen(
        { sourceFilesEdited: true },
        { rootDir: '.', hookEvent: 'Stop', sessionId }
      )
      assert.strictEqual(result, true)
    })

    it('Stop skips when session has no file edits', () => {
      const result = evaluateWhen(
        { sourceFilesEdited: true },
        { rootDir: '.', hookEvent: 'Stop', sessionId: 'test-sfe-stop-empty' }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('no source files were edited'), `Expected skip reason, got: ${result}`)
    })

    it('Stop skips after turn tracking is reset', () => {
      const sessionId = 'test-sfe-stop-reset'
      recordFileEdit(sessionId, 'Edit', 'src/app.js')
      resetTurnTracking(sessionId)
      const result = evaluateWhen(
        { sourceFilesEdited: true },
        { rootDir: '.', hookEvent: 'Stop', sessionId }
      )
      assert.notStrictEqual(result, true)
    })

    it('SessionStart always skips', () => {
      const result = evaluateWhen(
        { sourceFilesEdited: true },
        { rootDir: '.', hookEvent: 'SessionStart', sessionId: null }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('not applicable'), `Expected not applicable reason, got: ${result}`)
    })
  })

  describe('evaluateWhen — prerequisite/trigger split', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = freshRepo((dir) => {
        fs.writeFileSync(path.join(dir, 'app.js'), 'initial\n')
      })
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('multiple prerequisites AND — all pass → true', () => {
      process.env.PROVE_IT_PTS_VAR = '1'
      try {
        fs.writeFileSync(path.join(tmpDir, '.config'), 'x')
        const result = evaluateWhen(
          { fileExists: '.config', envSet: 'PROVE_IT_PTS_VAR' },
          { rootDir: tmpDir }
        )
        assert.strictEqual(result, true)
      } finally {
        delete process.env.PROVE_IT_PTS_VAR
      }
    })

    it('multiple prerequisites AND — one fails → skip', () => {
      delete process.env.PROVE_IT_PTS_MISSING
      fs.writeFileSync(path.join(tmpDir, '.config'), 'x')
      const result = evaluateWhen(
        { fileExists: '.config', envSet: 'PROVE_IT_PTS_MISSING' },
        { rootDir: tmpDir }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('was not set'), `Expected prereq reason, got: ${result}`)
    })

    it('multiple triggers OR — one passes → true', () => {
      // Bootstrap refs
      churnSinceRef(tmpDir, sanitizeRefName('pts-check'), ['**/*.js'])
      grossChurnSince(tmpDir, sanitizeRefName('pts-check'))

      // Only gross churn meets threshold
      incrementGross(tmpDir, 600)

      const result = evaluateWhen(
        { linesChanged: 500, linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'pts-check'
      )
      assert.strictEqual(result, true)
    })

    it('multiple triggers OR — none pass → skip', () => {
      // Bootstrap refs
      churnSinceRef(tmpDir, sanitizeRefName('pts-check2'), ['**/*.js'])
      grossChurnSince(tmpDir, sanitizeRefName('pts-check2'))

      // Neither meets threshold
      incrementGross(tmpDir, 10)

      const result = evaluateWhen(
        { linesChanged: 500, linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'pts-check2'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('gross lines changed'), `Expected trigger reason, got: ${result}`)
    })

    it('prerequisite fails + trigger passes → skip (prereq gates)', () => {
      delete process.env.PROVE_IT_PTS_GATE
      // Set up a trigger that would pass
      grossChurnSince(tmpDir, sanitizeRefName('pts-gate'))
      incrementGross(tmpDir, 600)

      const result = evaluateWhen(
        { envSet: 'PROVE_IT_PTS_GATE', linesWritten: 500 },
        { rootDir: tmpDir, sources: ['**/*.js'] },
        'pts-gate'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('was not set'), `Expected prereq reason, got: ${result}`)
    })

    it('prerequisite passes + trigger passes → true', () => {
      process.env.PROVE_IT_PTS_PASS = '1'
      try {
        grossChurnSince(tmpDir, sanitizeRefName('pts-pass'))
        incrementGross(tmpDir, 600)

        const result = evaluateWhen(
          { envSet: 'PROVE_IT_PTS_PASS', linesWritten: 500 },
          { rootDir: tmpDir, sources: ['**/*.js'] },
          'pts-pass'
        )
        assert.strictEqual(result, true)
      } finally {
        delete process.env.PROVE_IT_PTS_PASS
      }
    })

    it('prerequisite passes + trigger fails → skip', () => {
      process.env.PROVE_IT_PTS_TRIG = '1'
      try {
        grossChurnSince(tmpDir, sanitizeRefName('pts-trig'))
        incrementGross(tmpDir, 10)

        const result = evaluateWhen(
          { envSet: 'PROVE_IT_PTS_TRIG', linesWritten: 500 },
          { rootDir: tmpDir, sources: ['**/*.js'] },
          'pts-trig'
        )
        assert.notStrictEqual(result, true)
        assert.ok(result.includes('gross lines changed'), `Expected trigger reason, got: ${result}`)
      } finally {
        delete process.env.PROVE_IT_PTS_TRIG
      }
    })

    it('prerequisites only (no triggers) → true when all pass', () => {
      process.env.PROVE_IT_PTS_ONLY = '1'
      try {
        fs.writeFileSync(path.join(tmpDir, '.config'), 'x')
        const result = evaluateWhen(
          { fileExists: '.config', envSet: 'PROVE_IT_PTS_ONLY' },
          { rootDir: tmpDir }
        )
        assert.strictEqual(result, true)
      } finally {
        delete process.env.PROVE_IT_PTS_ONLY
      }
    })

    it('PREREQUISITE_KEYS and TRIGGER_KEYS are exported', () => {
      assert.ok(Array.isArray(PREREQUISITE_KEYS))
      assert.ok(Array.isArray(TRIGGER_KEYS))
      assert.ok(PREREQUISITE_KEYS.includes('fileExists'))
      assert.ok(TRIGGER_KEYS.includes('linesChanged'))
      assert.ok(TRIGGER_KEYS.includes('sourceFilesEdited'))
    })
  })

  describe('BUILTIN_EDIT_TOOLS', () => {
    it('contains Edit, Write, NotebookEdit', () => {
      assert.deepStrictEqual(BUILTIN_EDIT_TOOLS, ['Edit', 'Write', 'NotebookEdit'])
    })
  })

  describe('defaultConfig', () => {
    it('returns enabled: false', () => {
      assert.strictEqual(defaultConfig().enabled, false)
    })

    it('returns empty hooks array', () => {
      assert.deepStrictEqual(defaultConfig().hooks, [])
    })

    it('returns no format key', () => {
      assert.strictEqual(defaultConfig().format, undefined)
    })
  })
})
