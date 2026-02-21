const { describe, it } = require('node:test')
const assert = require('node:assert')

const { isCodexModel, parseVerdict } = require('../lib/shared')

describe('parseVerdict', () => {
  describe('PASS responses', () => {
    it("parses 'PASS' with fallback rationale", () => {
      const result = parseVerdict('PASS')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, '<<Reviewer provided no rationale>>')
    })

    it("parses 'PASS' with trailing whitespace", () => {
      const result = parseVerdict('PASS\n\n')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, '<<Reviewer provided no rationale>>')
    })

    it("parses 'PASS' with leading whitespace", () => {
      const result = parseVerdict('  PASS')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, '<<Reviewer provided no rationale>>')
    })

    it("parses 'PASS: reasoning'", () => {
      const result = parseVerdict('PASS: all changed lines have corresponding test assertions')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'all changed lines have corresponding test assertions')
    })

    it("parses 'PASS:no space'", () => {
      const result = parseVerdict('PASS:no space')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'no space')
    })
  })

  describe('FAIL responses', () => {
    it("parses 'FAIL: reason'", () => {
      const result = parseVerdict('FAIL: no tests for new function')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'no tests for new function')
    })

    it("parses 'FAIL:reason' (no space)", () => {
      const result = parseVerdict('FAIL:missing tests')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'missing tests')
    })

    it("parses bare 'FAIL' with fallback rationale", () => {
      const result = parseVerdict('FAIL')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, '<<Reviewer provided no rationale>>')
    })
  })

  describe('verdict after preamble', () => {
    it('finds PASS after conversational preamble', () => {
      const result = parseVerdict('Perfect. Now I can review the changes.\nPASS: all tests cover new behavior')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'all tests cover new behavior')
    })

    it('finds FAIL after conversational preamble', () => {
      const result = parseVerdict('Let me check the diff.\nFAIL: no tests for new function')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'no tests for new function')
    })

    it('finds verdict after multiple preamble lines', () => {
      const result = parseVerdict('Perfect. There are several changes.\nLet me investigate.\n\nPASS: looks good')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'looks good')
    })
  })

  describe('SKIP responses', () => {
    it("parses bare 'SKIP' with fallback rationale", () => {
      const result = parseVerdict('SKIP')
      assert.strictEqual(result.skip, true)
      assert.strictEqual(result.reason, '<<Reviewer provided no rationale>>')
    })

    it("parses 'SKIP: mid-refactor'", () => {
      const result = parseVerdict('SKIP: mid-refactor')
      assert.strictEqual(result.skip, true)
      assert.strictEqual(result.reason, 'mid-refactor')
    })

    it('finds SKIP after preamble text', () => {
      const result = parseVerdict('Let me review the changes.\nSKIP: changes are unrelated to test coverage')
      assert.strictEqual(result.skip, true)
      assert.strictEqual(result.reason, 'changes are unrelated to test coverage')
    })

    it('SKIP has no pass field', () => {
      const result = parseVerdict('SKIP: reason')
      assert.strictEqual(result.pass, undefined)
    })
  })

  describe('unexpected responses', () => {
    it('returns error for unexpected output', () => {
      const result = parseVerdict('I think the code looks good')
      assert.ok(result.error)
      assert.ok(result.error.includes('Unexpected reviewer output'))
    })

    it('returns error for null output', () => {
      const result = parseVerdict(null)
      assert.ok(result.error)
    })

    it('returns error for empty string', () => {
      const result = parseVerdict('')
      assert.ok(result.error)
    })
  })
})

describe('isCodexModel', () => {
  it('returns true for gpt- prefixed models', () => {
    assert.strictEqual(isCodexModel('gpt-5.3-codex'), true)
    assert.strictEqual(isCodexModel('gpt-4o'), true)
  })

  it('is case-insensitive', () => {
    assert.strictEqual(isCodexModel('GPT-5.3-codex'), true)
  })

  it('returns false for non-gpt models', () => {
    assert.strictEqual(isCodexModel('haiku'), false)
    assert.strictEqual(isCodexModel('sonnet'), false)
    assert.strictEqual(isCodexModel('claude-3-opus'), false)
  })

  it('returns false for null/undefined', () => {
    assert.strictEqual(isCodexModel(null), false)
    assert.strictEqual(isCodexModel(undefined), false)
  })
})
