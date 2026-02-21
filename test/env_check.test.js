const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { parseEnvOutput } = require('../lib/checks/env')
const { writeEnvFile } = require('../lib/dispatcher/claude')

describe('parseEnvOutput', () => {
  ;[
    ['empty string', ''],
    ['whitespace-only', '  \n  '],
    ['null', null]
  ].forEach(([label, input]) => {
    it(`returns empty vars for ${label}`, () => {
      const { vars, parseError } = parseEnvOutput(input)
      assert.deepStrictEqual(vars, {})
      assert.strictEqual(parseError, null)
    })
  })

  describe('JSON format', () => {
    it('parses valid JSON object', () => {
      const { vars, parseError } = parseEnvOutput('{"FOO": "bar", "BAZ": "qux"}')
      assert.deepStrictEqual(vars, { FOO: 'bar', BAZ: 'qux' })
      assert.strictEqual(parseError, null)
    })

    it('errors on non-string values', () => {
      const { vars, parseError } = parseEnvOutput('{"FOO": 42}')
      assert.deepStrictEqual(vars, {})
      assert.ok(parseError.includes('must be a string'))
    })

    it('errors on JSON array', () => {
      const { vars, parseError } = parseEnvOutput('["FOO"]')
      assert.deepStrictEqual(vars, {})
      assert.ok(parseError.includes('must be an object'))
    })

    it('errors on invalid JSON starting with {', () => {
      const { vars, parseError } = parseEnvOutput('{not json}')
      assert.deepStrictEqual(vars, {})
      assert.ok(parseError.includes('Failed to parse JSON'))
    })

    it('parses empty JSON object', () => {
      const { vars, parseError } = parseEnvOutput('{}')
      assert.deepStrictEqual(vars, {})
      assert.strictEqual(parseError, null)
    })
  })

  describe('.env format', () => {
    it('parses simple KEY=value lines', () => {
      const { vars, parseError } = parseEnvOutput('FOO=bar\nBAZ=qux')
      assert.deepStrictEqual(vars, { FOO: 'bar', BAZ: 'qux' })
      assert.strictEqual(parseError, null)
    })

    ;[
      ['double-quoted', 'FOO="hello world"'],
      ['single-quoted', "FOO='hello world'"]
    ].forEach(([label, input]) => {
      it(`parses ${label} values`, () => {
        const { vars, parseError } = parseEnvOutput(input)
        assert.deepStrictEqual(vars, { FOO: 'hello world' })
        assert.strictEqual(parseError, null)
      })
    })

    it('skips comment lines', () => {
      const { vars, parseError } = parseEnvOutput('# comment\nFOO=bar')
      assert.deepStrictEqual(vars, { FOO: 'bar' })
      assert.strictEqual(parseError, null)
    })

    it('skips blank lines', () => {
      const { vars, parseError } = parseEnvOutput('FOO=bar\n\nBAZ=qux\n')
      assert.deepStrictEqual(vars, { FOO: 'bar', BAZ: 'qux' })
      assert.strictEqual(parseError, null)
    })

    it('handles values with equals signs', () => {
      const { vars, parseError } = parseEnvOutput('URL=https://example.com?a=1&b=2')
      assert.deepStrictEqual(vars, { URL: 'https://example.com?a=1&b=2' })
      assert.strictEqual(parseError, null)
    })

    it('handles empty values', () => {
      const { vars, parseError } = parseEnvOutput('EMPTY=')
      assert.deepStrictEqual(vars, { EMPTY: '' })
      assert.strictEqual(parseError, null)
    })

    it('errors on line without equals', () => {
      const { vars, parseError } = parseEnvOutput('NO_EQUALS')
      assert.deepStrictEqual(vars, {})
      assert.ok(parseError.includes('no "=" found'))
    })

    it('errors on invalid variable name', () => {
      const { vars, parseError } = parseEnvOutput('123BAD=value')
      assert.deepStrictEqual(vars, {})
      assert.ok(parseError.includes('invalid variable name'))
    })
  })

  describe('export format', () => {
    ;[
      ['export KEY=value lines', 'export FOO=bar\nexport BAZ=qux', { FOO: 'bar', BAZ: 'qux' }],
      ['export with quoted values', 'export FOO="hello world"', { FOO: 'hello world' }],
      ['mixed export and plain formats', 'export FOO=bar\nBAZ=qux', { FOO: 'bar', BAZ: 'qux' }]
    ].forEach(([label, input, expected]) => {
      it(`parses ${label}`, () => {
        const { vars, parseError } = parseEnvOutput(input)
        assert.deepStrictEqual(vars, expected)
        assert.strictEqual(parseError, null)
      })
    })
  })
})

describe('writeEnvFile', () => {
  let tmpDir
  let savedEnv

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_wef_'))
    savedEnv = process.env.CLAUDE_ENV_FILE
  })

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.CLAUDE_ENV_FILE = savedEnv
    } else {
      delete process.env.CLAUDE_ENV_FILE
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes vars to CLAUDE_ENV_FILE', () => {
    const envFile = path.join(tmpDir, 'env')
    process.env.CLAUDE_ENV_FILE = envFile

    writeEnvFile({ FOO: 'bar', BAZ: 'qux' })

    const content = fs.readFileSync(envFile, 'utf8')
    assert.ok(content.includes('FOO=bar'))
    assert.ok(content.includes('BAZ=qux'))
  })

  it('appends to existing file', () => {
    const envFile = path.join(tmpDir, 'env')
    fs.writeFileSync(envFile, 'EXISTING=yes\n')
    process.env.CLAUDE_ENV_FILE = envFile

    writeEnvFile({ NEW: 'val' })

    const content = fs.readFileSync(envFile, 'utf8')
    assert.ok(content.includes('EXISTING=yes'))
    assert.ok(content.includes('NEW=val'))
  })

  it('escapes values with newlines', () => {
    const envFile = path.join(tmpDir, 'env')
    process.env.CLAUDE_ENV_FILE = envFile

    writeEnvFile({ MULTI: 'line1\nline2' })

    const content = fs.readFileSync(envFile, 'utf8')
    assert.ok(content.includes('MULTI="line1\\nline2"'),
      `Should escape newline in quoted value, got: ${content}`)
    // The file itself should only have 2 lines (the var + trailing newline)
    assert.strictEqual(content.trim().split('\n').length, 1,
      'Newline in value should not create extra lines in file')
  })

  it('escapes values with quotes and backslashes', () => {
    const envFile = path.join(tmpDir, 'env')
    process.env.CLAUDE_ENV_FILE = envFile

    writeEnvFile({ QUOTED: 'say "hello"', SLASHED: 'back\\slash' })

    const content = fs.readFileSync(envFile, 'utf8')
    assert.ok(content.includes('QUOTED="say \\"hello\\""'),
      `Should escape double quotes, got: ${content}`)
    assert.ok(content.includes('SLASHED="back\\\\slash"'),
      `Should escape backslashes, got: ${content}`)
  })

  it('does not quote simple values', () => {
    const envFile = path.join(tmpDir, 'env')
    process.env.CLAUDE_ENV_FILE = envFile

    writeEnvFile({ SIMPLE: 'hello' })

    const content = fs.readFileSync(envFile, 'utf8')
    assert.ok(content.includes('SIMPLE=hello'))
    assert.ok(!content.includes('"hello"'),
      'Simple values should not be quoted')
  })

  it('does not throw when CLAUDE_ENV_FILE is unset', () => {
    delete process.env.CLAUDE_ENV_FILE

    // Should log to stderr but not throw
    assert.doesNotThrow(() => writeEnvFile({ A: '1' }))
  })
})
