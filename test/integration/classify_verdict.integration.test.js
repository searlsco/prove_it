const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { classifyVerdict } = require('../../lib/shared')

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures')
const classifierFixture = path.join(FIXTURES_DIR, 'claude-classifier')

describe('classifyVerdict with fixture shim (captured haiku responses)', () => {
  let tmpDir
  let origPath

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), 'prove_it_classify_' + Date.now())
    fs.mkdirSync(tmpDir, { recursive: true })
    // Symlink the fixture as 'claude' and prepend to PATH so classifyVerdict finds it
    fs.symlinkSync(classifierFixture, path.join(tmpDir, 'claude'))
    origPath = process.env.PATH
    process.env.PATH = tmpDir + ':' + origPath
  })

  afterEach(() => {
    process.env.PATH = origPath
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('classifies verbose approval as PASS', () => {
    const r = classifyVerdict(
      'I\'ve reviewed all the changes carefully.\n\n' +
      'The new parseConfig function handles edge cases well — empty input throws,\n' +
      'malformed JSON throws with a descriptive message, and valid input returns\n' +
      'the expected structure. The test coverage is thorough with 8 test cases\n' +
      'covering the happy path and all error branches.\n\n' +
      'No issues found. The code is ready to merge.'
    )
    assert.strictEqual(r.verdict, 'PASS')
  })

  it('classifies verbose rejection as FAIL', () => {
    const r = classifyVerdict(
      'After reviewing the changes, I found several problems:\n\n' +
      '1. The new validateEmail function doesn\'t handle unicode domains\n' +
      '2. There\'s no test for the empty-string case\n' +
      '3. The error message on line 42 references the wrong variable name\n\n' +
      'These need to be addressed before merging.'
    )
    assert.strictEqual(r.verdict, 'FAIL')
  })

  it('classifies incomplete review as SKIP', () => {
    const r = classifyVerdict(
      'I was unable to fully review these changes because the test suite\n' +
      'requires a database connection that isn\'t available in this environment.\n' +
      'I can confirm the code compiles and the linter passes, but I cannot verify\n' +
      'the behavioral claims without running the integration tests.'
    )
    assert.strictEqual(r.verdict, 'SKIP')
  })

  it('returns error when review is cut off mid-sentence', () => {
    const r = classifyVerdict(
      'Looking at the diff, I can see changes to three files:\n\n' +
      '1. lib/config.js — the new validation logic looks correct\n' +
      '2. lib/init.js — I\'m concerned about the'
    )
    assert.ok(r.error, `Expected error for incomplete review, got: ${JSON.stringify(r)}`)
    assert.ok(r.error.includes('verdict unclear'), `Expected 'verdict unclear' error, got: ${r.error}`)
  })
})
