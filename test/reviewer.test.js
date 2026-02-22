const { describe, it } = require('node:test')
const assert = require('node:assert')

const { isCodexModel, parseVerdict } = require('../lib/shared')

describe('parseVerdict', () => {
  describe('PASS responses', () => {
    const bareCases = [
      ['bare PASS', 'PASS'],
      ['PASS with trailing whitespace', 'PASS\n\n'],
      ['PASS with leading whitespace', '  PASS']
    ]

    bareCases.forEach(([label, input]) => {
      it(`parses ${label} with fallback rationale`, () => {
        const result = parseVerdict(input)
        assert.strictEqual(result.pass, true)
        assert.strictEqual(result.reason, '<<Reviewer provided no rationale>>')
      })
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

    it('PASS has no body field', () => {
      const result = parseVerdict('PASS: looks good\n\nSome extra text')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.body, undefined)
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

    it('captures multi-line body after FAIL verdict', () => {
      const input = 'FAIL: missing tests\n\n### Summary\nDetailed analysis here.\n\n### Issues\n1. No tests for foo'
      const result = parseVerdict(input)
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'missing tests')
      assert.ok(result.body.includes('### Summary'))
      assert.ok(result.body.includes('Detailed analysis here.'))
      assert.ok(result.body.includes('### Issues'))
    })

    it('returns null body when FAIL has verdict line only', () => {
      const result = parseVerdict('FAIL: no tests')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'no tests')
      assert.strictEqual(result.body, null)
    })

    it('captures body after FAIL even with preamble lines', () => {
      const input = 'Let me check.\nFAIL: bad code\n\n### Summary\nThe code is bad.'
      const result = parseVerdict(input)
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'bad code')
      assert.ok(result.body.includes('### Summary'))
      assert.ok(!result.body.includes('Let me check'))
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

    it('SKIP has no body field', () => {
      const result = parseVerdict('SKIP: unrelated\n\nSome extra text')
      assert.strictEqual(result.body, undefined)
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

  const nullishCases = [
    ['null', null],
    ['undefined', undefined]
  ]

  nullishCases.forEach(([label, value]) => {
    it(`returns false for ${label}`, () => {
      assert.strictEqual(isCodexModel(value), false)
    })
  })
})
