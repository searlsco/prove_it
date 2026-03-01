const { describe, it } = require('node:test')
const assert = require('node:assert')

const { isCodexModel, parseVerdict, parseJsonOutput, extractReviewText, NUDGE_PROMPT } = require('../lib/shared')

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

    it('parses PASS without colon', () => {
      const result = parseVerdict('PASS everything looks good')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'everything looks good')
    })

    it('PASS has no body field when inline reason present', () => {
      const result = parseVerdict('PASS: looks good\n\nSome extra text')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'looks good')
      assert.strictEqual(result.body, undefined)
    })

    it('folds body into reason when PASS has no inline reason', () => {
      const input = 'PASS\n\n#### Summary\nAll changes have corresponding tests.\n\n#### Coverage\nFull coverage.'
      const result = parseVerdict(input)
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('Summary'))
      assert.ok(result.reason.includes('All changes have corresponding tests'))
      assert.ok(result.reason.includes('Coverage'))
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

    it('parses FAIL without colon', () => {
      const result = parseVerdict('FAIL missing tests\n\n### Details\nNo coverage.')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'missing tests')
      assert.ok(result.body.includes('### Details'))
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

    it('folds body into reason when FAIL has no inline reason', () => {
      const input = 'FAIL\n\n#### Summary\nThis changeset has issues.\n\n#### Issues\n1. Missing tests'
      const result = parseVerdict(input)
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('Summary'))
      assert.ok(result.reason.includes('This changeset has issues'))
      assert.strictEqual(result.body, null)
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

    it('parses SKIP without colon', () => {
      const result = parseVerdict('SKIP unrelated changes')
      assert.strictEqual(result.skip, true)
      assert.strictEqual(result.reason, 'unrelated changes')
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

  describe('markdown-formatted verdicts', () => {
    it('parses **FAIL** (bold)', () => {
      const result = parseVerdict('**FAIL**\n\nThe code has issues.')
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('The code has issues'))
      assert.strictEqual(result.body, null)
    })

    it('parses **PASS**: reason (bold with colon)', () => {
      const result = parseVerdict('**PASS**: all tests cover new behavior')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'all tests cover new behavior')
    })

    it('parses *FAIL*: reason (italic)', () => {
      const result = parseVerdict('*FAIL*: missing tests')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'missing tests')
    })

    it('parses **SKIP**: reason', () => {
      const result = parseVerdict('**SKIP**: unrelated changes')
      assert.strictEqual(result.skip, true)
      assert.strictEqual(result.reason, 'unrelated changes')
    })

    it('parses # FAIL as markdown heading', () => {
      const result = parseVerdict('# FAIL\n\nDetails here.')
      assert.strictEqual(result.pass, false)
    })

    it('parses ## PASS: reason as heading', () => {
      const result = parseVerdict('## PASS: looks good')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'looks good')
    })

    it('finds **FAIL** after preamble', () => {
      const result = parseVerdict('Based on my review:\n\n**FAIL**\n\nIssues found.')
      assert.strictEqual(result.pass, false)
    })

    it('parses ***FAIL***: reason (bold italic)', () => {
      const result = parseVerdict('***FAIL***: no coverage')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'no coverage')
    })

    it('parses __PASS__: reason (underscore bold)', () => {
      const result = parseVerdict('__PASS__: tests are adequate')
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.reason, 'tests are adequate')
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

describe('parseJsonOutput', () => {
  it('parses valid JSON with result and session_id', () => {
    const json = JSON.stringify({ result: 'PASS: looks good', session_id: 'abc-123', subtype: 'success' })
    const parsed = parseJsonOutput(json)
    assert.strictEqual(parsed.result, 'PASS: looks good')
    assert.strictEqual(parsed.sessionId, 'abc-123')
    assert.strictEqual(parsed.subtype, 'success')
  })

  it('parses error_max_turns JSON', () => {
    const json = JSON.stringify({ result: '', session_id: 'sess-456', subtype: 'error_max_turns' })
    const parsed = parseJsonOutput(json)
    assert.strictEqual(parsed.subtype, 'error_max_turns')
    assert.strictEqual(parsed.sessionId, 'sess-456')
  })

  it('returns null for malformed JSON', () => {
    assert.strictEqual(parseJsonOutput('not json at all'), null)
    assert.strictEqual(parseJsonOutput('{truncated'), null)
  })

  it('handles missing fields gracefully', () => {
    const json = JSON.stringify({})
    const parsed = parseJsonOutput(json)
    assert.strictEqual(parsed.result, '')
    assert.strictEqual(parsed.sessionId, null)
    assert.strictEqual(parsed.subtype, null)
  })
})

describe('extractReviewText', () => {
  it('returns raw text when jsonMode is false', () => {
    const result = { stdout: '  PASS: looks good  ', stderr: '' }
    assert.strictEqual(extractReviewText(result, false), 'PASS: looks good')
  })

  it('falls back to stderr when stdout is empty in non-json mode', () => {
    const result = { stdout: '', stderr: 'FAIL: bad code' }
    assert.strictEqual(extractReviewText(result, false), 'FAIL: bad code')
  })

  it('extracts result from success JSON', () => {
    const json = JSON.stringify({ result: 'PASS: all tests pass', subtype: 'success' })
    const result = { stdout: json, stderr: '' }
    assert.strictEqual(extractReviewText(result, true), 'PASS: all tests pass')
  })

  it('falls back to raw text on malformed JSON', () => {
    const result = { stdout: 'PASS: raw fallback', stderr: '' }
    assert.strictEqual(extractReviewText(result, true), 'PASS: raw fallback')
  })

  it('falls back to raw text when JSON has no result and no subtype', () => {
    const json = JSON.stringify({ something_else: 'data' })
    const result = { stdout: json, stderr: '' }
    // Falls through to raw text since result is empty and subtype is null
    assert.strictEqual(extractReviewText(result, true), json)
  })
})

describe('NUDGE_PROMPT', () => {
  it('is a non-empty string', () => {
    assert.ok(typeof NUDGE_PROMPT === 'string')
    assert.ok(NUDGE_PROMPT.length > 0)
  })

  it('mentions PASS, FAIL, and SKIP', () => {
    assert.ok(NUDGE_PROMPT.includes('PASS'))
    assert.ok(NUDGE_PROMPT.includes('FAIL'))
    assert.ok(NUDGE_PROMPT.includes('SKIP'))
  })
})
