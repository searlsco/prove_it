const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { passDecision, failDecision, emitPreToolUse, emitStop } = require('../lib/dispatcher/protocol')

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

  describe('emitPreToolUse', () => {
    let captured
    const origWrite = process.stdout.write

    beforeEach(() => {
      captured = ''
      process.stdout.write = (chunk) => { captured += chunk }
    })

    afterEach(() => {
      process.stdout.write = origWrite
    })

    it('includes systemMessage when provided', () => {
      emitPreToolUse('deny', 'reason', 'user-visible msg')
      const output = JSON.parse(captured)
      assert.strictEqual(output.systemMessage, 'user-visible msg')
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny')
    })

    it('omits systemMessage when not provided', () => {
      emitPreToolUse('allow', 'ok')
      const output = JSON.parse(captured)
      assert.strictEqual(output.systemMessage, undefined)
    })
  })

  describe('emitStop', () => {
    let captured
    const origWrite = process.stdout.write

    beforeEach(() => {
      captured = ''
      process.stdout.write = (chunk) => { captured += chunk }
    })

    afterEach(() => {
      process.stdout.write = origWrite
    })

    it('includes systemMessage when provided', () => {
      emitStop('block', 'reason', 'user-visible msg')
      const output = JSON.parse(captured)
      assert.strictEqual(output.systemMessage, 'user-visible msg')
      assert.strictEqual(output.decision, 'block')
    })

    it('omits systemMessage when not provided', () => {
      emitStop('approve', 'ok')
      const output = JSON.parse(captured)
      assert.strictEqual(output.systemMessage, undefined)
    })
  })
})
