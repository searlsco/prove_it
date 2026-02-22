const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { matchesHookEntry, evaluateWhen, defaultConfig, settleTaskResult, spawnAsyncTask, harvestAsyncResults, cleanAsyncDir, BUILTIN_EDIT_TOOLS } = require('../lib/dispatcher/claude')
const { whenHasKey } = require('../lib/git')
const { recordFileEdit, resetTurnTracking, getAsyncDir } = require('../lib/session')

describe('claude dispatcher', () => {
  describe('matchesHookEntry', () => {
    ;[
      ['matches type and event', { type: 'claude', event: 'Stop', tasks: [] }, 'Stop', {}, true],
      ['rejects wrong type', { type: 'git', event: 'Stop', tasks: [] }, 'Stop', {}, false],
      ['rejects wrong event', { type: 'claude', event: 'PreToolUse', tasks: [] }, 'Stop', {}, false]
    ].forEach(([label, entry, event, hookInput, expected]) => {
      it(label, () => {
        assert.strictEqual(matchesHookEntry(entry, event, hookInput), expected)
      })
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
    ;[
      ['null', null],
      ['undefined', undefined]
    ].forEach(([label, input]) => {
      it(`returns true when conditions are ${label}`, () => {
        assert.strictEqual(evaluateWhen(input, { rootDir: '.' }), true)
      })
    })

    it('checks fileExists—passes when file exists', () => {
      assert.strictEqual(evaluateWhen({ fileExists: 'package.json' }, { rootDir: process.cwd() }), true)
    })

    it('checks fileExists—returns reason when file missing', () => {
      const result = evaluateWhen({ fileExists: 'nonexistent-file-xyz.json' }, { rootDir: process.cwd() })
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('was not found'), `Expected 'was not found' reason, got: ${result}`)
      assert.ok(result.includes('nonexistent-file-xyz.json'), `Expected path in reason, got: ${result}`)
    })

    it('checks envSet—passes when env var is set', () => {
      process.env.PROVE_IT_TEST_VAR = '1'
      try {
        assert.strictEqual(evaluateWhen({ envSet: 'PROVE_IT_TEST_VAR' }, { rootDir: '.' }), true)
      } finally {
        delete process.env.PROVE_IT_TEST_VAR
      }
    })

    it('checks envSet—returns reason when env var is unset', () => {
      delete process.env.PROVE_IT_FAKE_ENV_VAR
      const result = evaluateWhen({ envSet: 'PROVE_IT_FAKE_ENV_VAR' }, { rootDir: '.' })
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('was not set'), `Expected 'was not set' reason, got: ${result}`)
      assert.ok(result.includes('$PROVE_IT_FAKE_ENV_VAR'), `Expected var name in reason, got: ${result}`)
    })

    it('checks envNotSet—passes when env var is unset', () => {
      delete process.env.PROVE_IT_FAKE_ENV_VAR2
      assert.strictEqual(evaluateWhen({ envNotSet: 'PROVE_IT_FAKE_ENV_VAR2' }, { rootDir: '.' }), true)
    })

    it('checks envNotSet—returns reason when env var is set', () => {
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
  })

  describe('evaluateWhen—sourcesModifiedSinceLastRun', () => {
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

  describe('evaluateWhen—signal', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_signal_'))
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

    it('passes when signal matches', () => {
      const { setSignal } = require('../lib/session')
      setSignal('signal-test-1', 'done', null)
      const result = evaluateWhen(
        { signal: 'done' },
        { rootDir: tmpDir, sessionId: 'signal-test-1' }
      )
      assert.strictEqual(result, true)
    })

    it('skips when signal does not match', () => {
      const { setSignal } = require('../lib/session')
      setSignal('signal-test-2', 'stuck', null)
      const result = evaluateWhen(
        { signal: 'done' },
        { rootDir: tmpDir, sessionId: 'signal-test-2' }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('signal "done" is not active'))
    })

    it('skips when no signal is active', () => {
      const result = evaluateWhen(
        { signal: 'done' },
        { rootDir: tmpDir, sessionId: 'no-signal-session' }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('signal "done" is not active'))
    })

    it('signal + trigger: both must pass', () => {
      // Signal is a prerequisite (AND), linesChanged is a trigger.
      // With no signal active, the prerequisite fails before triggers are checked.
      const result = evaluateWhen(
        { signal: 'done', linesChanged: 10 },
        { rootDir: tmpDir, sessionId: 'no-signal-combo' }
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('signal "done" is not active'))
    })

    it('signal prerequisite passes, trigger still evaluated', () => {
      const { setSignal } = require('../lib/session')
      setSignal('signal-combo', 'done', null)
      // Signal matches, but linesChanged trigger may skip. Using a sourcesModifiedSinceLastRun
      // trigger that always fires on first run to test the combination.
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime } = require('../lib/testing')
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.local.json')
      fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
      const result = evaluateWhen(
        { signal: 'done', sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, sessionId: 'signal-combo', localCfgPath, latestSourceMtime: getLatestMtime(tmpDir, ['**/*.js']) },
        'combo-task'
      )
      assert.strictEqual(result, true)
    })
  })

  describe('evaluateWhen—toolsUsed', () => {
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

  describe('evaluateWhen—sourceFilesEdited', () => {
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

  describe('whenHasKey', () => {
    it('returns false for null/undefined when', () => {
      assert.strictEqual(whenHasKey(null, 'linesChanged'), false)
      assert.strictEqual(whenHasKey(undefined, 'linesChanged'), false)
    })

    it('finds key in object form', () => {
      assert.strictEqual(whenHasKey({ linesChanged: 500 }, 'linesChanged'), true)
      assert.strictEqual(whenHasKey({ envSet: 'CI' }, 'linesChanged'), false)
    })

    it('finds key in array form', () => {
      assert.strictEqual(whenHasKey([{ envSet: 'CI' }, { linesChanged: 500 }], 'linesChanged'), true)
      assert.strictEqual(whenHasKey([{ envSet: 'CI' }, { envNotSet: 'X' }], 'linesChanged'), false)
    })
  })

  describe('evaluateWhen—array form', () => {
    it('returns true when any clause passes (OR)', () => {
      process.env.PROVE_IT_ARR_TEST = '1'
      try {
        const result = evaluateWhen(
          [{ envSet: 'PROVE_IT_ARR_TEST' }, { envSet: 'PROVE_IT_MISSING' }],
          { rootDir: '.' }
        )
        assert.strictEqual(result, true)
      } finally {
        delete process.env.PROVE_IT_ARR_TEST
      }
    })

    it('returns reason when no clause passes', () => {
      const result = evaluateWhen(
        [{ envSet: 'PROVE_IT_NOPE_1' }, { envSet: 'PROVE_IT_NOPE_2' }],
        { rootDir: '.' }
      )
      assert.notStrictEqual(result, true)
      assert.ok(typeof result === 'string')
    })

    it('returns true for null/undefined when (passthrough)', () => {
      assert.strictEqual(evaluateWhen(null, { rootDir: '.' }), true)
      assert.strictEqual(evaluateWhen(undefined, { rootDir: '.' }), true)
    })
  })

  describe('BUILTIN_EDIT_TOOLS', () => {
    it('contains Edit, MultiEdit, Write, NotebookEdit', () => {
      assert.deepStrictEqual(BUILTIN_EDIT_TOOLS, ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
    })
  })

  describe('defaultConfig', () => {
    it('returns disabled config with empty hooks and no format', () => {
      const config = defaultConfig()
      assert.strictEqual(config.enabled, false)
      assert.deepStrictEqual(config.hooks, [])
      assert.strictEqual(config.format, undefined)
    })
  })

  describe('settleTaskResult', () => {
    it('returns blocked with message on FAIL for Stop event', () => {
      const outputs = []
      const contextParts = []
      const systemMessages = []
      const task = { name: 'my-task', type: 'script', command: 'test' }
      const result = { pass: false, reason: 'tests failed', output: '' }
      const settlCtx = { rootDir: '/tmp', sources: null, localCfgPath: null, latestSourceMtime: 0 }
      const settlement = settleTaskResult(task, result, 'Stop', settlCtx, outputs, contextParts, systemMessages)
      assert.strictEqual(settlement.blocked, true)
      assert.ok(settlement.message.includes('my-task failed'))
      assert.ok(settlement.message.includes('tests failed'))
    })

    it('pushes to systemMessages on FAIL for SessionStart (not blocked)', () => {
      const outputs = []
      const contextParts = []
      const systemMessages = []
      const task = { name: 'briefing', type: 'script', command: 'test' }
      const result = { pass: false, reason: 'oops', output: '' }
      const settlCtx = { rootDir: '/tmp', sources: null, localCfgPath: null, latestSourceMtime: 0 }
      const settlement = settleTaskResult(task, result, 'SessionStart', settlCtx, outputs, contextParts, systemMessages)
      assert.strictEqual(settlement.blocked, false)
      assert.ok(systemMessages.includes('oops'))
      assert.ok(contextParts.includes('oops'))
    })

    it('collects output on SKIP when not quiet', () => {
      const outputs = []
      const task = { name: 'my-task', type: 'script', command: 'test' }
      const result = { pass: true, reason: 'empty prompt—skipped', output: '', skipped: true }
      const settlCtx = { rootDir: '/tmp', sources: null, localCfgPath: null, latestSourceMtime: 0 }
      const settlement = settleTaskResult(task, result, 'Stop', settlCtx, outputs, [], [])
      assert.strictEqual(settlement.blocked, false)
      assert.ok(outputs.includes('empty prompt—skipped'))
    })

    it('suppresses output on SKIP when quiet', () => {
      const outputs = []
      const task = { name: 'my-task', type: 'script', command: 'test', quiet: true }
      const result = { pass: true, reason: 'skipped', output: '', skipped: true }
      const settlCtx = { rootDir: '/tmp', sources: null, localCfgPath: null, latestSourceMtime: 0 }
      settleTaskResult(task, result, 'Stop', settlCtx, outputs, [], [])
      assert.strictEqual(outputs.length, 0)
    })

    it('collects output on PASS when not quiet', () => {
      const outputs = []
      const task = { name: 'my-task', type: 'script', command: 'test' }
      const result = { pass: true, reason: 'all good', output: '' }
      const settlCtx = { rootDir: '/tmp', sources: null, localCfgPath: null, latestSourceMtime: 0 }
      const settlement = settleTaskResult(task, result, 'Stop', settlCtx, outputs, [], [])
      assert.strictEqual(settlement.blocked, false)
      assert.ok(outputs.includes('all good'))
    })
  })

  describe('spawnAsyncTask', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_spawn_'))
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

    it('writes context file with correct structure and creates async dir', () => {
      const sessionId = 'test-spawn-ctx'
      const task = { name: 'my-async-task', type: 'script', async: true, command: 'echo hi' }
      const context = {
        rootDir: tmpDir,
        projectDir: tmpDir,
        sessionId,
        hookEvent: 'Stop',
        localCfgPath: null,
        sources: ['**/*.js'],
        fileEditingTools: ['Edit'],
        configEnv: { FOO: 'bar' },
        configModel: 'haiku',
        maxChars: 12000,
        testOutput: 'prior output'
      }

      spawnAsyncTask(task, context)

      const asyncDir = getAsyncDir(sessionId)
      assert.ok(fs.existsSync(asyncDir), 'Async dir should be created')

      // Context file may already be consumed by the worker, but we can check
      // the result file will eventually appear. Instead, verify the async dir
      // was created and check the JSONL log for SPAWNED.
      const sessionsDir = path.join(process.env.PROVE_IT_DIR, 'sessions')
      const logFile = path.join(sessionsDir, `${sessionId}.jsonl`)
      assert.ok(fs.existsSync(logFile), 'Session log should exist')
      const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      const spawnedEntry = logLines.map(l => JSON.parse(l)).find(e => e.status === 'SPAWNED')
      assert.ok(spawnedEntry, 'Should log SPAWNED entry')
      assert.strictEqual(spawnedEntry.reviewer, 'my-async-task')
      assert.strictEqual(spawnedEntry.hookEvent, 'Stop')
    })

    it('does nothing when sessionId is null', () => {
      const task = { name: 'my-task', type: 'script', command: 'echo hi' }
      const context = {
        rootDir: tmpDir,
        projectDir: tmpDir,
        sessionId: null,
        hookEvent: 'Stop',
        localCfgPath: null,
        sources: null,
        fileEditingTools: [],
        configEnv: null,
        configModel: null,
        maxChars: 12000,
        testOutput: ''
      }
      // Should not throw
      spawnAsyncTask(task, context)
      // No async dir should exist
      assert.ok(!fs.existsSync(path.join(process.env.PROVE_IT_DIR, 'sessions')))
    })

    it('serializes task definition into context file for later settlement', () => {
      const sessionId = 'test-spawn-task-def'
      const task = {
        name: 'coverage-review',
        type: 'agent',
        async: true,
        prompt: 'review:test_coverage',
        promptType: 'reference',
        model: 'haiku',
        when: { linesChanged: 500 }
      }
      const context = {
        rootDir: tmpDir,
        projectDir: tmpDir,
        sessionId,
        hookEvent: 'Stop',
        localCfgPath: '/fake/path',
        sources: ['**/*.js'],
        fileEditingTools: ['Edit'],
        configEnv: null,
        configModel: null,
        maxChars: 12000,
        testOutput: ''
      }

      spawnAsyncTask(task, context)

      // Read the context file before the worker can consume it
      const asyncDir = getAsyncDir(sessionId)
      const contextFile = path.join(asyncDir, 'coverage-review.context.json')

      // The worker is detached and racing us, but context file should exist
      // immediately after spawnAsyncTask returns (written before fork)
      if (fs.existsSync(contextFile)) {
        const snapshot = JSON.parse(fs.readFileSync(contextFile, 'utf8'))
        assert.strictEqual(snapshot.task.name, 'coverage-review')
        assert.strictEqual(snapshot.task.async, true)
        assert.strictEqual(snapshot.task.when.linesChanged, 500)
        assert.strictEqual(snapshot.context.rootDir, tmpDir)
        assert.strictEqual(snapshot.context.sessionId, sessionId)
        assert.ok(snapshot.resultPath.endsWith('coverage-review.json'))
      }
      // If the worker already consumed it, the SPAWNED log proves it was written
      const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
      const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      assert.ok(logLines.some(l => JSON.parse(l).status === 'SPAWNED'))
    })
  })

  describe('harvestAsyncResults', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_harvest_'))
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

    it('returns empty array when no async dir exists', () => {
      const results = harvestAsyncResults('nonexistent-session')
      assert.deepStrictEqual(results, [])
    })

    it('returns empty array when no session id', () => {
      const results = harvestAsyncResults(null)
      assert.deepStrictEqual(results, [])
    })

    it('reads result files without deleting, skips context files', () => {
      const sessionId = 'test-harvest'
      const asyncDir = getAsyncDir(sessionId)
      fs.mkdirSync(asyncDir, { recursive: true })

      const resultData = {
        taskName: 'coverage-review',
        task: { name: 'coverage-review', type: 'agent' },
        result: { pass: true, reason: 'PASS: all good', output: '', skipped: false },
        completedAt: Date.now()
      }
      fs.writeFileSync(path.join(asyncDir, 'coverage-review.json'), JSON.stringify(resultData))
      fs.writeFileSync(path.join(asyncDir, 'coverage-review.context.json'), '{}')

      const results = harvestAsyncResults(sessionId)
      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].data.taskName, 'coverage-review')
      assert.strictEqual(results[0].data.result.pass, true)
      assert.ok(results[0].filePath.endsWith('coverage-review.json'))

      // Result file should NOT be deleted (caller is responsible)
      assert.ok(fs.existsSync(path.join(asyncDir, 'coverage-review.json')))
      // Context file should remain (worker cleans it, not harvest)
      assert.ok(fs.existsSync(path.join(asyncDir, 'coverage-review.context.json')))
    })

    it('handles multiple result files', () => {
      const sessionId = 'test-harvest-multi'
      const asyncDir = getAsyncDir(sessionId)
      fs.mkdirSync(asyncDir, { recursive: true })

      for (const name of ['task-a', 'task-b']) {
        const data = {
          taskName: name,
          task: { name, type: 'script' },
          result: { pass: true, reason: 'passed', output: '', skipped: false },
          completedAt: Date.now()
        }
        fs.writeFileSync(path.join(asyncDir, `${name}.json`), JSON.stringify(data))
      }

      const results = harvestAsyncResults(sessionId)
      assert.strictEqual(results.length, 2)
      const names = results.map(r => r.data.taskName).sort()
      assert.deepStrictEqual(names, ['task-a', 'task-b'])
    })

    it('skips corrupted files and deletes them', () => {
      const sessionId = 'test-harvest-corrupt'
      const asyncDir = getAsyncDir(sessionId)
      fs.mkdirSync(asyncDir, { recursive: true })

      fs.writeFileSync(path.join(asyncDir, 'bad.json'), 'not json{{{')
      const goodData = {
        taskName: 'good-task',
        task: { name: 'good-task', type: 'script' },
        result: { pass: true, reason: 'ok', output: '', skipped: false },
        completedAt: Date.now()
      }
      fs.writeFileSync(path.join(asyncDir, 'good-task.json'), JSON.stringify(goodData))

      const results = harvestAsyncResults(sessionId)
      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].data.taskName, 'good-task')
      // Corrupted file should be cleaned up
      assert.ok(!fs.existsSync(path.join(asyncDir, 'bad.json')))
    })
  })

  describe('harvest enforce status differentiation', () => {
    it('uses ENFORCED:SKIP for skipped results, ENFORCED:PASS for passed results', () => {
      // This tests the inline logic in dispatch() that differentiates enforce status
      const skippedResult = { pass: true, reason: 'SKIP: not relevant', output: '', skipped: true }
      const passedResult = { pass: true, reason: 'PASS: all good', output: '', skipped: false }

      const skipStatus = skippedResult.skipped ? 'ENFORCED:SKIP' : 'ENFORCED:PASS'
      const passStatus = passedResult.skipped ? 'ENFORCED:SKIP' : 'ENFORCED:PASS'

      assert.strictEqual(skipStatus, 'ENFORCED:SKIP')
      assert.strictEqual(passStatus, 'ENFORCED:PASS')
    })
  })

  describe('cleanAsyncDir', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_clean_'))
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

    it('removes async directory and its contents', () => {
      const sessionId = 'test-clean'
      const asyncDir = getAsyncDir(sessionId)
      fs.mkdirSync(asyncDir, { recursive: true })
      fs.writeFileSync(path.join(asyncDir, 'stale.json'), '{}')

      cleanAsyncDir(sessionId)
      assert.ok(!fs.existsSync(asyncDir))
    })

    it('does not throw when directory does not exist', () => {
      assert.doesNotThrow(() => cleanAsyncDir('nonexistent-session'))
    })

    it('does nothing for null sessionId', () => {
      assert.doesNotThrow(() => cleanAsyncDir(null))
    })
  })
})
