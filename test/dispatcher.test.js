const { describe, it } = require('node:test')
const assert = require('node:assert')
const { matchesHookEntry, evaluateWhen, defaultConfig } = require('../lib/dispatcher/claude')

describe('claude dispatcher', () => {
  describe('matchesHookEntry', () => {
    it('matches type and event', () => {
      const entry = { type: 'claude', event: 'Stop', checks: [] }
      assert.ok(matchesHookEntry(entry, 'Stop', {}))
    })

    it('rejects wrong type', () => {
      const entry = { type: 'git', event: 'Stop', checks: [] }
      assert.ok(!matchesHookEntry(entry, 'Stop', {}))
    })

    it('rejects wrong event', () => {
      const entry = { type: 'claude', event: 'PreToolUse', checks: [] }
      assert.ok(!matchesHookEntry(entry, 'Stop', {}))
    })

    it('matches tool name via matcher', () => {
      const entry = { type: 'claude', event: 'PreToolUse', matcher: 'Edit|Write', checks: [] }
      assert.ok(matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Edit' }))
    })

    it('rejects non-matching tool name', () => {
      const entry = { type: 'claude', event: 'PreToolUse', matcher: 'Edit|Write', checks: [] }
      assert.ok(!matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Read' }))
    })

    it('matches when no matcher specified', () => {
      const entry = { type: 'claude', event: 'PreToolUse', checks: [] }
      assert.ok(matchesHookEntry(entry, 'PreToolUse', { tool_name: 'Read' }))
    })

    it('matches triggers for Bash commands', () => {
      const entry = {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Bash',
        triggers: ['(^|\\s)git\\s+commit\\b'],
        checks: []
      }
      assert.ok(matchesHookEntry(entry, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' }
      }))
    })

    it('rejects non-matching triggers', () => {
      const entry = {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Bash',
        triggers: ['(^|\\s)git\\s+commit\\b'],
        checks: []
      }
      assert.ok(!matchesHookEntry(entry, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'git status' }
      }))
    })

    it('matches SessionStart source', () => {
      const entry = { type: 'claude', event: 'SessionStart', source: 'startup|resume', checks: [] }
      assert.ok(matchesHookEntry(entry, 'SessionStart', { source: 'startup' }))
    })

    it('rejects non-matching SessionStart source', () => {
      const entry = { type: 'claude', event: 'SessionStart', source: 'startup|resume', checks: [] }
      assert.ok(!matchesHookEntry(entry, 'SessionStart', { source: 'clear' }))
    })

    it('matches SessionStart with no source filter', () => {
      const entry = { type: 'claude', event: 'SessionStart', checks: [] }
      assert.ok(matchesHookEntry(entry, 'SessionStart', { source: 'anything' }))
    })
  })

  describe('evaluateWhen', () => {
    it('returns true when no conditions', () => {
      assert.ok(evaluateWhen(null, { rootDir: '.' }))
    })

    it('returns true when undefined', () => {
      assert.ok(evaluateWhen(undefined, { rootDir: '.' }))
    })

    it('checks fileExists — passes when file exists', () => {
      // package.json exists in the current directory
      assert.ok(evaluateWhen({ fileExists: 'package.json' }, { rootDir: process.cwd() }))
    })

    it('checks fileExists — fails when file missing', () => {
      assert.ok(!evaluateWhen({ fileExists: 'nonexistent-file-xyz.json' }, { rootDir: process.cwd() }))
    })

    it('checks envSet — passes when env var is set', () => {
      process.env.PROVE_IT_TEST_VAR = '1'
      try {
        assert.ok(evaluateWhen({ envSet: 'PROVE_IT_TEST_VAR' }, { rootDir: '.' }))
      } finally {
        delete process.env.PROVE_IT_TEST_VAR
      }
    })

    it('checks envSet — fails when env var is unset', () => {
      delete process.env.PROVE_IT_FAKE_ENV_VAR
      assert.ok(!evaluateWhen({ envSet: 'PROVE_IT_FAKE_ENV_VAR' }, { rootDir: '.' }))
    })

    it('checks envNotSet — passes when env var is unset', () => {
      delete process.env.PROVE_IT_FAKE_ENV_VAR2
      assert.ok(evaluateWhen({ envNotSet: 'PROVE_IT_FAKE_ENV_VAR2' }, { rootDir: '.' }))
    })

    it('checks envNotSet — fails when env var is set', () => {
      process.env.PROVE_IT_TEST_VAR2 = 'yes'
      try {
        assert.ok(!evaluateWhen({ envNotSet: 'PROVE_IT_TEST_VAR2' }, { rootDir: '.' }))
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
