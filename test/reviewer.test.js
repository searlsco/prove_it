const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { parseVerdict, parseJsonlOutput, runReviewer } = require('../lib/shared')

const FIXTURES_DIR = path.join(__dirname, 'fixtures')

describe('parseVerdict', () => {
  describe('PASS responses', () => {
    it("parses 'PASS'", () => {
      const result = parseVerdict('PASS')
      assert.strictEqual(result.pass, true)
    })

    it("parses 'PASS' with trailing whitespace", () => {
      const result = parseVerdict('PASS\n\n')
      assert.strictEqual(result.pass, true)
    })

    it("parses 'PASS' with leading whitespace", () => {
      const result = parseVerdict('  PASS')
      assert.strictEqual(result.pass, true)
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

    it("parses 'FAIL' on its own line with reason on next line", () => {
      const result = parseVerdict('FAIL\nno tests added')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'no tests added')
    })

    it("parses 'FAIL' alone as failure with default reason", () => {
      const result = parseVerdict('FAIL')
      assert.strictEqual(result.pass, false)
      assert.strictEqual(result.reason, 'No reason provided')
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

describe('parseJsonlOutput', () => {
  it('extracts agent_message from codex JSONL', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t-001"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"Thinking..."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PASS"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100}}'
    ].join('\n')

    assert.strictEqual(parseJsonlOutput(jsonl), 'PASS')
  })

  it('extracts FAIL message from codex JSONL', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t-001"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"FAIL: no tests"}}',
      '{"type":"turn.completed","usage":{}}'
    ].join('\n')

    assert.strictEqual(parseJsonlOutput(jsonl), 'FAIL: no tests')
  })

  it('returns last agent_message when multiple exist', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"thinking out loud"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PASS"}}'
    ].join('\n')

    assert.strictEqual(parseJsonlOutput(jsonl), 'PASS')
  })

  it('returns null when no agent_message found', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t-001"}',
      '{"type":"turn.completed","usage":{}}'
    ].join('\n')

    assert.strictEqual(parseJsonlOutput(jsonl), null)
  })

  it('skips non-JSON lines gracefully', () => {
    const jsonl = [
      'not json at all',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PASS"}}',
      '2026-02-06 ERROR something'
    ].join('\n')

    assert.strictEqual(parseJsonlOutput(jsonl), 'PASS')
  })

  it('returns null for empty input', () => {
    assert.strictEqual(parseJsonlOutput(''), null)
  })
})

describe('runReviewer with fixture shims', () => {
  const tmpDir = path.join(require('os').tmpdir(), 'prove_it_reviewer_shim_' + Date.now())
  const fraudePath = path.join(FIXTURES_DIR, 'fraude')
  const faudexPath = path.join(FIXTURES_DIR, 'faudex')

  function setup () {
    fs.mkdirSync(tmpDir, { recursive: true })
  }

  function cleanup () {
    delete process.env.FRAUDE_RESPONSE
    delete process.env.FAUDEX_RESPONSE
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  describe('fraude (text mode)', () => {
    it('returns PASS via text mode', () => {
      setup()
      process.env.FRAUDE_RESPONSE = 'PASS'
      const review = runReviewer(tmpDir, {
        command: `${fraudePath} -p`,
        outputMode: 'text'
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      cleanup()
    })

    it('returns FAIL with reason via text mode', () => {
      setup()
      process.env.FRAUDE_RESPONSE = 'FAIL: no tests for new function'
      const review = runReviewer(tmpDir, {
        command: `${fraudePath} -p`,
        outputMode: 'text'
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, false)
      assert.strictEqual(review.reason, 'no tests for new function')
      cleanup()
    })
  })

  describe('faudex (jsonl mode)', () => {
    it('returns PASS via jsonl mode', () => {
      setup()
      process.env.FAUDEX_RESPONSE = 'PASS'
      const review = runReviewer(tmpDir, {
        command: `${faudexPath} exec --sandbox read-only --json`,
        outputMode: 'jsonl'
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      cleanup()
    })

    it('returns FAIL with reason via jsonl mode', () => {
      setup()
      process.env.FAUDEX_RESPONSE = 'FAIL: missing coverage for auth.js'
      const review = runReviewer(tmpDir, {
        command: `${faudexPath} exec --json`,
        outputMode: 'jsonl'
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, false)
      assert.strictEqual(review.reason, 'missing coverage for auth.js')
      cleanup()
    })
  })

  describe('binary availability', () => {
    it('returns available: false when binary not found', () => {
      setup()
      const review = runReviewer(tmpDir, {
        command: 'nonexistent_binary_xyz',
        outputMode: 'text'
      }, 'test')

      assert.strictEqual(review.available, false)
      assert.strictEqual(review.binary, 'nonexistent_binary_xyz')
      cleanup()
    })
  })

  describe('defaults', () => {
    it('uses fraude as default when configured, proving default plumbing works', () => {
      setup()
      process.env.FRAUDE_RESPONSE = 'PASS'
      // Prove that if the default command were fraude, text mode works end-to-end
      const review = runReviewer(tmpDir, {
        command: `${fraudePath} -p`
      }, 'test')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      cleanup()
    })
  })
})
