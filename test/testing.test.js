const { describe, it } = require('node:test')
const assert = require('node:assert')

const { KNOWN_TEST_COMMANDS, isTestCommand } = require('../lib/testing')

describe('KNOWN_TEST_COMMANDS', () => {
  it('is a non-empty array of strings', () => {
    assert.ok(Array.isArray(KNOWN_TEST_COMMANDS))
    assert.ok(KNOWN_TEST_COMMANDS.length > 20, 'Should have 20+ built-in patterns')
    for (const cmd of KNOWN_TEST_COMMANDS) {
      assert.strictEqual(typeof cmd, 'string')
    }
  })

  it('includes common test runners', () => {
    const expected = ['npm test', 'pytest', 'go test', 'cargo test', 'jest', './script/test']
    for (const cmd of expected) {
      assert.ok(
        KNOWN_TEST_COMMANDS.some(k => k.includes(cmd.replace('./', ''))),
        `Should include a pattern for: ${cmd}`
      )
    }
  })
})

describe('isTestCommand', () => {
  const matchCases = [
    ['npm test', 'npm test'],
    ['npm test with extra args', 'npm test -- --watch'],
    ['npx jest', 'npx jest'],
    ['npx jest with path', 'npx jest src/foo.test.js'],
    ['pytest', 'pytest'],
    ['pytest with args', 'pytest -v test/'],
    ['python -m pytest', 'python -m pytest'],
    ['go test', 'go test ./...'],
    ['cargo test', 'cargo test'],
    ['./script/test', './script/test'],
    ['script/test without dot-slash', 'script/test'],
    ['bundle exec rspec', 'bundle exec rspec'],
    ['xcodebuild test', 'xcodebuild test'],
    ['with leading env var', 'CI=1 npm test'],
    ['with multiple env vars', 'CI=1 VERBOSE=1 pytest'],
    ['flutter test', 'flutter test'],
    ['mix test', 'mix test']
  ]

  matchCases.forEach(([label, command]) => {
    it(`matches ${label}`, () => {
      assert.strictEqual(isTestCommand(command), true)
    })
  })

  const noMatchCases = [
    ['git commit', 'git commit -m "test"'],
    ['echo test', 'echo test'],
    ['ls test dir', 'ls test/'],
    ['cat test file', 'cat test/foo.js'],
    ['npm install', 'npm install'],
    ['node script', 'node test.js']
  ]

  noMatchCases.forEach(([label, command]) => {
    it(`does not match ${label}`, () => {
      assert.strictEqual(isTestCommand(command), false)
    })
  })

  it('matches user-configured extra commands', () => {
    assert.strictEqual(isTestCommand('my-custom-test-runner', ['my-custom-test-runner']), true)
    assert.strictEqual(isTestCommand('my-custom-test-runner --verbose', ['my-custom-test-runner']), true)
  })

  it('does not match when extra commands are empty', () => {
    assert.strictEqual(isTestCommand('my-custom-test-runner', []), false)
  })
})
