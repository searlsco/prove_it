const { describe, it } = require('node:test')
const assert = require('node:assert')
const { matchesHookEntry, evaluateWhen, defaultConfig } = require('../lib/dispatcher/claude')

describe('claude dispatcher', () => {
  describe('matchesHookEntry', () => {
    it('matches type and event', () => {
      const entry = { type: 'claude', event: 'Stop', checks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'Stop', {}), true)
    })

    it('rejects wrong type', () => {
      const entry = { type: 'git', event: 'Stop', checks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'Stop', {}), false)
    })

    it('rejects wrong event', () => {
      const entry = { type: 'claude', event: 'PreToolUse', checks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'Stop', {}), false)
    })

    it('matches tool name via matcher', () => {
      const entry = { type: 'claude', event: 'PreToolUse', matcher: 'Edit|Write', checks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Edit' }), true)
    })

    it('rejects non-matching tool name', () => {
      const entry = { type: 'claude', event: 'PreToolUse', matcher: 'Edit|Write', checks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Read' }), false)
    })

    it('matches when no matcher specified', () => {
      const entry = { type: 'claude', event: 'PreToolUse', checks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Read' }), true)
    })

    it('matches triggers for Bash commands', () => {
      const entry = {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Bash',
        triggers: ['(^|\\s)git\\s+commit\\b'],
        checks: []
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
        checks: []
      }
      assert.strictEqual(matchesHookEntry(entry, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'git status' }
      }), false)
    })

    it('matches SessionStart source', () => {
      const entry = { type: 'claude', event: 'SessionStart', source: 'startup|resume', checks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'SessionStart', { source: 'startup' }), true)
    })

    it('rejects non-matching SessionStart source', () => {
      const entry = { type: 'claude', event: 'SessionStart', source: 'startup|resume', checks: [] }
      assert.strictEqual(matchesHookEntry(entry, 'SessionStart', { source: 'clear' }), false)
    })

    it('matches SessionStart with no source filter', () => {
      const entry = { type: 'claude', event: 'SessionStart', checks: [] }
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
  })

  describe('defaultConfig', () => {
    it('returns enabled: true', () => {
      assert.strictEqual(defaultConfig().enabled, true)
    })

    it('returns empty hooks array', () => {
      assert.deepStrictEqual(defaultConfig().hooks, [])
    })

    it('returns format with maxOutputChars', () => {
      assert.strictEqual(defaultConfig().format.maxOutputChars, 12000)
    })
  })
})
