const { describe, it } = require('node:test')
const assert = require('node:assert')
const { passDecision, failDecision } = require('../lib/dispatcher/protocol')

describe('protocol', () => {
  describe('passDecision', () => {
    it('returns approve for Stop', () => {
      assert.strictEqual(passDecision('Stop'), 'approve')
    })

    it('returns allow for PreToolUse', () => {
      assert.strictEqual(passDecision('PreToolUse'), 'allow')
    })

    it('returns allow for SessionStart', () => {
      assert.strictEqual(passDecision('SessionStart'), 'allow')
    })

    it('returns allow for unknown events', () => {
      assert.strictEqual(passDecision('Whatever'), 'allow')
    })
  })

  describe('failDecision', () => {
    it('returns block for Stop', () => {
      assert.strictEqual(failDecision('Stop'), 'block')
    })

    it('returns deny for PreToolUse', () => {
      assert.strictEqual(failDecision('PreToolUse'), 'deny')
    })

    it('returns deny for unknown events', () => {
      assert.strictEqual(failDecision('Whatever'), 'deny')
    })
  })

  describe('valid permissionDecision values', () => {
    const VALID_PERMISSION_DECISIONS = ['allow', 'deny', 'ask']

    it("rejects 'block' as a permissionDecision value", () => {
      assert.strictEqual(
        VALID_PERMISSION_DECISIONS.includes('block'),
        false,
        "'block' must not be in the valid set — Claude Code ignores it"
      )
    })

    it("rejects 'approve' as a permissionDecision value", () => {
      assert.strictEqual(
        VALID_PERMISSION_DECISIONS.includes('approve'),
        false,
        "'approve' must not be in the valid set — use 'allow' instead"
      )
    })
  })
})
