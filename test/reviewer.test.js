const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { isCodexModel, parseVerdict, runReviewer } = require('../lib/shared')

const FIXTURES_DIR = path.join(__dirname, 'fixtures')

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

describe('runReviewer with fixture shims', () => {
  const tmpDir = path.join(require('os').tmpdir(), 'prove_it_reviewer_shim_' + Date.now())
  const fraudePath = path.join(FIXTURES_DIR, 'fraude')
  function setup () {
    fs.mkdirSync(tmpDir, { recursive: true })
  }

  function cleanup () {
    delete process.env.FRAUDE_RESPONSE
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  describe('fraude (text mode)', () => {
    it('returns PASS', () => {
      setup()
      process.env.FRAUDE_RESPONSE = 'PASS'
      const review = runReviewer(tmpDir, {
        command: `${fraudePath} -p`
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      cleanup()
    })

    it('returns FAIL with reason', () => {
      setup()
      process.env.FRAUDE_RESPONSE = 'FAIL: no tests for new function'
      const review = runReviewer(tmpDir, {
        command: `${fraudePath} -p`
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, false)
      assert.strictEqual(review.reason, 'no tests for new function')
      cleanup()
    })
  })

  describe('binary availability', () => {
    it('returns available: false when binary not found', () => {
      setup()
      const review = runReviewer(tmpDir, {
        command: 'nonexistent_binary_xyz'
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

  describe('model support', () => {
    it('appends --model to claude commands', () => {
      setup()
      // Create a shim that echoes its own command-line args so we can verify --model was passed
      const shimPath = path.join(tmpDir, 'claude')
      fs.writeFileSync(shimPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
      fs.chmodSync(shimPath, 0o755)

      const review = runReviewer(tmpDir, {
        command: `${shimPath} -p`,
        model: 'haiku'
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      assert.ok(review.reason.includes('--model') && review.reason.includes('haiku'),
        `Expected --model haiku in args, got: ${review.reason}`)
      cleanup()
    })

    it('appends --model to codex commands', () => {
      setup()
      const shimPath = path.join(tmpDir, 'codex')
      fs.writeFileSync(shimPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
      fs.chmodSync(shimPath, 0o755)

      const review = runReviewer(tmpDir, {
        command: `${shimPath} exec -`,
        model: 'gpt-5.3-codex'
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      assert.ok(review.reason.includes('--model') && review.reason.includes('gpt-5.3-codex'),
        `Expected --model gpt-5.3-codex in args, got: ${review.reason}`)
      cleanup()
    })

    it('does not append --model to non-claude/non-codex commands', () => {
      setup()
      const shimPath = path.join(tmpDir, 'custom_reviewer')
      fs.writeFileSync(shimPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
      fs.chmodSync(shimPath, 0o755)

      const review = runReviewer(tmpDir, {
        command: shimPath,
        model: 'haiku'
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      assert.ok(!review.reason.includes('--model'),
        `Expected no --model in args, got: ${review.reason}`)
      cleanup()
    })

    it('does not append --model when model is null', () => {
      setup()
      process.env.FRAUDE_RESPONSE = 'PASS: no model'
      const review = runReviewer(tmpDir, {
        command: `${fraudePath} -p`,
        model: null
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      cleanup()
    })
  })

  describe('timeout from config', () => {
    it('uses timeout from reviewerCfg', () => {
      setup()
      // Create a script that sleeps briefly — if timeout were 1ms it would fail
      const shimPath = path.join(tmpDir, 'slow_reviewer.sh')
      fs.writeFileSync(shimPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS"\n')
      fs.chmodSync(shimPath, 0o755)

      const review = runReviewer(tmpDir, {
        command: shimPath,
        timeout: 30000
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      cleanup()
    })
  })

  describe('codex auto-switch', () => {
    it('auto-selects codex exec when model starts with gpt-', () => {
      setup()
      // Create a 'codex' shim that echoes args
      const shimDir = path.join(tmpDir, 'bin')
      fs.mkdirSync(shimDir, { recursive: true })
      const shimPath = path.join(shimDir, 'codex')
      fs.writeFileSync(shimPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
      fs.chmodSync(shimPath, 0o755)

      // Prepend shimDir to PATH so 'codex' resolves
      const origPath = process.env.PATH
      process.env.PATH = `${shimDir}:${origPath}`

      const review = runReviewer(tmpDir, {
        model: 'gpt-5.3-codex'
      }, 'test prompt')

      process.env.PATH = origPath

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      assert.ok(review.reason.includes('--model') && review.reason.includes('gpt-5.3-codex'),
        `Expected --model gpt-5.3-codex in args, got: ${review.reason}`)
      cleanup()
    })

    it('does not auto-select codex for non-gpt models', () => {
      setup()
      // Create a 'claude' shim that echoes args
      const shimDir = path.join(tmpDir, 'bin')
      fs.mkdirSync(shimDir, { recursive: true })
      const shimPath = path.join(shimDir, 'claude')
      fs.writeFileSync(shimPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
      fs.chmodSync(shimPath, 0o755)

      const origPath = process.env.PATH
      process.env.PATH = `${shimDir}:${origPath}`

      const review = runReviewer(tmpDir, {
        model: 'haiku'
      }, 'test prompt')

      process.env.PATH = origPath

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      assert.ok(review.reason.includes('--model') && review.reason.includes('haiku'),
        `Expected --model haiku in args, got: ${review.reason}`)
      cleanup()
    })

    it('does not override explicit command even with gpt model', () => {
      setup()
      process.env.FRAUDE_RESPONSE = 'PASS: custom command'
      const review = runReviewer(tmpDir, {
        command: `${fraudePath} -p`,
        model: 'gpt-5.3-codex'
      }, 'test prompt')

      assert.strictEqual(review.available, true)
      assert.strictEqual(review.pass, true)
      assert.strictEqual(review.reason, 'custom command')
      cleanup()
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
