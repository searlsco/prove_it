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

    it('checks fileExists — fails when file missing', () => {
      assert.strictEqual(evaluateWhen({ fileExists: 'nonexistent-file-xyz.json' }, { rootDir: process.cwd() }), false)
    })

    it('checks envSet — passes when env var is set', () => {
      process.env.PROVE_IT_TEST_VAR = '1'
      try {
        assert.strictEqual(evaluateWhen({ envSet: 'PROVE_IT_TEST_VAR' }, { rootDir: '.' }), true)
      } finally {
        delete process.env.PROVE_IT_TEST_VAR
      }
    })

    it('checks envSet — fails when env var is unset', () => {
      delete process.env.PROVE_IT_FAKE_ENV_VAR
      assert.strictEqual(evaluateWhen({ envSet: 'PROVE_IT_FAKE_ENV_VAR' }, { rootDir: '.' }), false)
    })

    it('checks envNotSet — passes when env var is unset', () => {
      delete process.env.PROVE_IT_FAKE_ENV_VAR2
      assert.strictEqual(evaluateWhen({ envNotSet: 'PROVE_IT_FAKE_ENV_VAR2' }, { rootDir: '.' }), true)
    })

    it('checks envNotSet — fails when env var is set', () => {
      process.env.PROVE_IT_TEST_VAR2 = 'yes'
      try {
        assert.strictEqual(evaluateWhen({ envNotSet: 'PROVE_IT_TEST_VAR2' }, { rootDir: '.' }), false)
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

      it('fails when variable resolves to empty (no staged changes)', () => {
        const result = evaluateWhen(
          { variablesPresent: ['staged_diff'] },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
        )
        assert.strictEqual(result, false)
      })

      it('fails for session_diff when sessionId is null', () => {
        const result = evaluateWhen(
          { variablesPresent: ['session_diff'] },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
        )
        assert.strictEqual(result, false)
      })

      it('fails for unknown variable name', () => {
        const result = evaluateWhen(
          { variablesPresent: ['nonexistent_var'] },
          { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null }
        )
        assert.strictEqual(result, false)
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

    it('returns false when lines written is below threshold', () => {
      const sessionId = 'test-lwslr-1'
      recordWrite(sessionId, 100)
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.strictEqual(result, false)
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
      assert.strictEqual(result, false)
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

    it('returns false when no session', () => {
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId: null },
        'my-check'
      )
      assert.strictEqual(result, false)
    })

    it('keeps firing when task run is NOT recorded (simulates fail-no-reset)', () => {
      const sessionId = 'test-lwslr-no-reset'
      recordWrite(sessionId, 600)
      // Task fires (600 >= 500), fails — recordTaskRun NOT called
      // Next check: still 600 >= 500, fires again
      const result = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.strictEqual(result, true)
      // Simulate more writes without recording — still fires
      recordWrite(sessionId, 100)
      const result2 = evaluateWhen(
        { linesWrittenSinceLastRun: 500 },
        { rootDir: '.', sessionId },
        'my-check'
      )
      assert.strictEqual(result2, true)
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
