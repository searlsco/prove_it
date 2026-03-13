const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { passDecision, failDecision, emitPreToolUse, emitPostToolUse, emitPostToolUseFailure, emitStop, emitSessionStart } = require('../lib/dispatcher/protocol')

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

    it('returns approve for PostToolUse', () => {
      assert.strictEqual(passDecision('PostToolUse'), 'approve')
    })
  })

  describe('failDecision', () => {
    it('returns block for Stop', () => {
      assert.strictEqual(failDecision('Stop'), 'block')
    })

    it('returns deny for PreToolUse', () => {
      assert.strictEqual(failDecision('PreToolUse'), 'deny')
    })

    it('returns block for PostToolUse', () => {
      assert.strictEqual(failDecision('PostToolUse'), 'block')
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

    it('includes additionalContext in hookSpecificOutput when provided', () => {
      emitPreToolUse('deny', 'reason', { additionalContext: 'context for claude' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.hookSpecificOutput.additionalContext, 'context for claude')
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny')
      assert.strictEqual(output.systemMessage, undefined)
    })

    it('includes systemMessage at top level when provided', () => {
      emitPreToolUse('deny', 'reason', { systemMessage: 'user-visible msg' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.systemMessage, 'user-visible msg')
      assert.strictEqual(output.hookSpecificOutput.additionalContext, undefined)
    })

    it('supports both additionalContext and systemMessage together', () => {
      emitPreToolUse('deny', 'reason', { additionalContext: 'ctx', systemMessage: 'msg' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.hookSpecificOutput.additionalContext, 'ctx')
      assert.strictEqual(output.systemMessage, 'msg')
    })

    it('omits both fields when opts is empty', () => {
      emitPreToolUse('allow', 'ok')
      const output = JSON.parse(captured)
      assert.strictEqual(output.hookSpecificOutput.additionalContext, undefined)
      assert.strictEqual(output.systemMessage, undefined)
    })
  })

  describe('emitSessionStart', () => {
    let captured
    const origWrite = process.stdout.write

    beforeEach(() => {
      captured = ''
      process.stdout.write = (chunk) => { captured += chunk }
    })

    afterEach(() => {
      process.stdout.write = origWrite
    })

    it('wraps additionalContext in hookSpecificOutput', () => {
      emitSessionStart({ additionalContext: 'briefing text' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'SessionStart')
      assert.strictEqual(output.hookSpecificOutput.additionalContext, 'briefing text')
      assert.strictEqual(output.additionalContext, undefined,
        'additionalContext must not appear at top level')
    })

    it('includes systemMessage at top level', () => {
      emitSessionStart({ systemMessage: 'warning msg' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.systemMessage, 'warning msg')
    })

    it('supports both additionalContext and systemMessage', () => {
      emitSessionStart({ additionalContext: 'ctx', systemMessage: 'msg' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.hookSpecificOutput.additionalContext, 'ctx')
      assert.strictEqual(output.systemMessage, 'msg')
    })

    it('emits nothing when both fields are empty', () => {
      emitSessionStart({})
      assert.strictEqual(captured, '')
    })
  })

  describe('emitPostToolUse', () => {
    let captured
    const origWrite = process.stdout.write

    beforeEach(() => {
      captured = ''
      process.stdout.write = (chunk) => { captured += chunk }
    })

    afterEach(() => {
      process.stdout.write = origWrite
    })

    it('includes hookEventName PostToolUse', () => {
      emitPostToolUse({ additionalContext: 'test passed' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PostToolUse')
      assert.strictEqual(output.hookSpecificOutput.additionalContext, 'test passed')
    })

    it('includes decision and reason when provided', () => {
      emitPostToolUse({ decision: 'approve', reason: 'all good' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.decision, 'approve')
      assert.strictEqual(output.reason, 'all good')
    })

    it('omits fields when empty', () => {
      emitPostToolUse({})
      const output = JSON.parse(captured)
      assert.strictEqual(output.decision, undefined)
      assert.strictEqual(output.hookSpecificOutput.additionalContext, undefined)
    })
  })

  describe('emitPostToolUseFailure', () => {
    let captured
    const origWrite = process.stdout.write

    beforeEach(() => {
      captured = ''
      process.stdout.write = (chunk) => { captured += chunk }
    })

    afterEach(() => {
      process.stdout.write = origWrite
    })

    it('includes hookEventName PostToolUseFailure', () => {
      emitPostToolUseFailure({ additionalContext: 'test failed' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PostToolUseFailure')
      assert.strictEqual(output.hookSpecificOutput.additionalContext, 'test failed')
    })

    it('has no decision control', () => {
      emitPostToolUseFailure({ additionalContext: 'error info' })
      const output = JSON.parse(captured)
      assert.strictEqual(output.decision, undefined)
      assert.strictEqual(output.reason, undefined)
    })

    it('omits additionalContext when not provided', () => {
      emitPostToolUseFailure({})
      const output = JSON.parse(captured)
      assert.strictEqual(output.hookSpecificOutput.additionalContext, undefined)
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
