const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  shellEscape,
  loadJson,
  writeJson,
  ensureDir,
  ensureTrailingNewline,
  sanitizeTaskName,
  truncateChars,
  tryRun
} = require('../lib/io')

describe('io', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('shellEscape', () => {
    it('wraps string in single quotes', () => {
      assert.strictEqual(shellEscape('hello'), "'hello'")
    })

    it('escapes single quotes in the string', () => {
      assert.strictEqual(shellEscape("it's"), "'it'\\''s'")
    })

    it('converts non-string to string', () => {
      assert.strictEqual(shellEscape(42), '42')
    })
  })

  describe('loadJson', () => {
    it('loads valid JSON file', () => {
      const p = path.join(tmpDir, 'test.json')
      fs.writeFileSync(p, '{"key": "value"}')
      assert.deepStrictEqual(loadJson(p), { key: 'value' })
    })

    it('returns null for nonexistent file', () => {
      assert.strictEqual(loadJson(path.join(tmpDir, 'nope.json')), null)
    })

    it('returns null for invalid JSON', () => {
      const p = path.join(tmpDir, 'bad.json')
      fs.writeFileSync(p, 'not json')
      assert.strictEqual(loadJson(p), null)
    })
  })

  describe('writeJson', () => {
    it('writes JSON with pretty-print and trailing newline', () => {
      const p = path.join(tmpDir, 'out.json')
      writeJson(p, { a: 1 })
      const content = fs.readFileSync(p, 'utf8')
      assert.ok(content.endsWith('\n'))
      assert.deepStrictEqual(JSON.parse(content), { a: 1 })
    })

    it('creates parent directories', () => {
      const p = path.join(tmpDir, 'deep', 'nested', 'out.json')
      writeJson(p, { b: 2 })
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { b: 2 })
    })
  })

  describe('ensureDir', () => {
    it('creates directory recursively', () => {
      const dir = path.join(tmpDir, 'a', 'b', 'c')
      ensureDir(dir)
      assert.ok(fs.existsSync(dir))
    })

    it('does not throw if directory exists', () => {
      ensureDir(tmpDir)
    })
  })

  describe('ensureTrailingNewline', () => {
    it('adds newline if missing', () => {
      assert.strictEqual(ensureTrailingNewline('hello'), 'hello\n')
    })

    it('does not double newline', () => {
      assert.strictEqual(ensureTrailingNewline('hello\n'), 'hello\n')
    })

    it('returns empty string as-is', () => {
      assert.strictEqual(ensureTrailingNewline(''), '')
    })

    it('returns non-string as-is', () => {
      assert.strictEqual(ensureTrailingNewline(null), null)
    })
  })

  describe('sanitizeTaskName', () => {
    it('passes through simple names', () => {
      assert.strictEqual(sanitizeTaskName('fast-tests'), 'fast-tests')
    })

    it('replaces special characters with underscore', () => {
      assert.strictEqual(sanitizeTaskName('../etc'), '.._etc')
    })

    it('replaces spaces', () => {
      assert.strictEqual(sanitizeTaskName('my task'), 'my_task')
    })

    it('prefixes dot-only names', () => {
      assert.strictEqual(sanitizeTaskName('.'), '_.')
      assert.strictEqual(sanitizeTaskName('..'), '_..')
    })

    it('defaults to unknown for falsy input', () => {
      assert.strictEqual(sanitizeTaskName(null), 'unknown')
      assert.strictEqual(sanitizeTaskName(''), 'unknown')
    })
  })

  describe('truncateChars', () => {
    it('returns string unchanged if within limit', () => {
      assert.strictEqual(truncateChars('abc', 5), 'abc')
    })

    it('truncates from the start (keeps tail)', () => {
      assert.strictEqual(truncateChars('abcdef', 3), 'def')
    })
  })

  describe('tryRun', () => {
    it('runs a command and returns result', () => {
      const r = tryRun('echo hello')
      assert.strictEqual(r.code, 0)
      assert.ok(r.stdout.includes('hello'))
    })

    it('returns non-zero exit code for failing commands', () => {
      const r = tryRun('exit 42')
      assert.strictEqual(r.code, 42)
    })
  })
})
