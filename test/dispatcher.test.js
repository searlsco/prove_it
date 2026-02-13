const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { matchesHookEntry, evaluateWhen, computeWriteInfo, defaultConfig } = require('../lib/dispatcher/claude')
const { recordWrite, recordTaskRun } = require('../lib/session')

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
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_vp_'))
        spawnSync('git', ['init'], { cwd: tmpDir })
        spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'initial\n')
        spawnSync('git', ['add', '.'], { cwd: tmpDir })
        spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
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

  describe('evaluateWhen — linesWrittenSinceLastRun', () => {
    let tmpDir
    let origProveItDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_lwslr_'))
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

    it('returns reason when lines written is below threshold', () => {
      const sessionId = 'test-lwslr-1'
      recordWrite(sessionId, 100)
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('100'), `Expected written count in reason, got: ${result}`)
      assert.ok(result.includes('500'), `Expected threshold in reason, got: ${result}`)
      assert.ok(result.includes('lines written since last run'), `Expected human-readable message, got: ${result}`)
    })

    it('returns true when lines written meets threshold', () => {
      const sessionId = 'test-lwslr-2'
      recordWrite(sessionId, 500)
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.strictEqual(result, true)
    })

    it('returns true when lines written exceeds threshold', () => {
      const sessionId = 'test-lwslr-3'
      recordWrite(sessionId, 700)
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.strictEqual(result, true)
    })

    it('resets after task run recording', () => {
      const sessionId = 'test-lwslr-4'
      recordWrite(sessionId, 600)
      recordTaskRun(sessionId, 'my-check')
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('0'), `Expected 0 in reason, got: ${result}`)
      assert.ok(result.includes('500'), `Expected 500 in reason, got: ${result}`)
    })

    it('fires again after accumulating more lines post-reset', () => {
      const sessionId = 'test-lwslr-5'
      recordWrite(sessionId, 600)
      recordTaskRun(sessionId, 'my-check')
      recordWrite(sessionId, 500)
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.strictEqual(result, true)
    })

    it('returns reason when no session', () => {
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId: null },
        'my-check'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('lines written since last run'), `Expected reason, got: ${result}`)
    })

    it('resets budget on failure so agent can write tests (no deadlock)', () => {
      const sessionId = 'test-lwslr-no-deadlock'
      recordWrite(sessionId, 600)
      // Task fires (600 >= 500), fails — dispatcher records task run anyway
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.strictEqual(result, true)
      // Dispatcher records the run on failure (budget reset)
      recordTaskRun(sessionId, 'my-check')
      // Next write: counter reset, agent has a fresh budget to write tests
      const result2 = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.notStrictEqual(result2, true)
      // After writing 500+ more lines (hopefully tests), check fires again
      recordWrite(sessionId, 500)
      const result3 = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.strictEqual(result3, true)
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
          localCfgPath: path.join(tmpDir, '.claude', 'prove_it.local.json'),
          latestSourceMtime: getLatestMtime(tmpDir, ['**/*.js'])
        },
        'my-task'
      )
      assert.strictEqual(result, true)
    })

    it('skips when sources have not changed since last run', () => {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code\n')
      const { getLatestMtime, saveRunData } = require('../lib/testing')
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
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
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
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
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
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

    it('skips when latestSourceMtime is 0 (no source files)', () => {
      const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
      const result = evaluateWhen(
        { sourcesModifiedSinceLastRun: true },
        { rootDir: tmpDir, localCfgPath, latestSourceMtime: 0 },
        'my-task'
      )
      assert.notStrictEqual(result, true)
      assert.ok(result.includes('no source files were found'), `Expected reason, got: ${result}`)
    })
  })

  describe('computeWriteInfo', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_cwi_'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('counts lines for Write tool (new file)', () => {
      const input = {
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(tmpDir, 'new.js'),
          content: 'line1\nline2\nline3\n'
        }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 4)
    })

    it('counts net new lines for Write tool (existing file)', () => {
      const filePath = path.join(tmpDir, 'existing.js')
      fs.writeFileSync(filePath, 'old\n')
      const input = {
        tool_name: 'Write',
        tool_input: {
          file_path: filePath,
          content: 'new1\nnew2\nnew3\n'
        }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 2) // 4 - 2 = 2
    })

    it('clamps to zero for Write (shrinking file)', () => {
      const filePath = path.join(tmpDir, 'shrink.js')
      fs.writeFileSync(filePath, 'a\nb\nc\nd\ne\n')
      const input = {
        tool_name: 'Write',
        tool_input: {
          file_path: filePath,
          content: 'a\n'
        }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 0)
    })

    it('counts positive delta for Edit tool', () => {
      const input = {
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmpDir, 'file.js'),
          old_string: 'one line',
          new_string: 'line1\nline2\nline3'
        }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 2) // 3 - 1 = 2
    })

    it('counts single occurrence delta for Edit with replace_all', () => {
      const input = {
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmpDir, 'file.js'),
          old_string: 'x',
          new_string: 'a\nb\nc',
          replace_all: true
        }
      }
      // replace_all may apply to N occurrences but we only see the delta once
      // (intentional approximation — we don't know occurrence count)
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 2) // 3 - 1 = 2
    })

    it('clamps to zero for Edit (shrinking)', () => {
      const input = {
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmpDir, 'file.js'),
          old_string: 'a\nb\nc',
          new_string: 'a'
        }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 0)
    })

    it('counts lines for NotebookEdit insert', () => {
      const input = {
        tool_name: 'NotebookEdit',
        tool_input: {
          notebook_path: path.join(tmpDir, 'nb.ipynb'),
          edit_mode: 'insert',
          new_source: 'import numpy\nprint("hi")'
        }
      }
      const result = computeWriteInfo(input, ['**/*.ipynb'], tmpDir)
      assert.strictEqual(result.lines, 2)
    })

    it('returns 0 for NotebookEdit replace', () => {
      const input = {
        tool_name: 'NotebookEdit',
        tool_input: {
          notebook_path: path.join(tmpDir, 'nb.ipynb'),
          edit_mode: 'replace',
          new_source: 'stuff'
        }
      }
      const result = computeWriteInfo(input, ['**/*.ipynb'], tmpDir)
      assert.strictEqual(result.lines, 0)
    })

    it('returns 0 for non-source files', () => {
      const input = {
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(tmpDir, 'README.md'),
          content: 'lots\nof\nlines\n'
        }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 0)
    })

    it('returns 0 for Bash tool', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 0)
    })

    it('returns 0 for Read tool', () => {
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: path.join(tmpDir, 'file.js') }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 0)
    })

    it('returns 0 for files outside repo', () => {
      const input = {
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/outside/file.js',
          content: 'lines\n'
        }
      }
      const result = computeWriteInfo(input, ['**/*.js'], tmpDir)
      assert.strictEqual(result.lines, 0)
    })
  })

  describe('defaultConfig', () => {
    it('returns enabled: true', () => {
      assert.strictEqual(defaultConfig().enabled, true)
    })

    it('returns empty hooks array', () => {
      assert.deepStrictEqual(defaultConfig().hooks, [])
    })

    it('returns no format key', () => {
      assert.strictEqual(defaultConfig().format, undefined)
    })
  })
})
