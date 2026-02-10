const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { matchesHookEntry, evaluateWhen, defaultConfig } = require('../lib/dispatcher/claude')

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
