const { describe, it } = require('node:test')
const assert = require('node:assert')
const { greet } = require('../src/greet')

describe('greet', () => {
  it('greets by name', () => {
    assert.strictEqual(greet('Alice'), 'Hello, Alice!')
  })

  it('returns default greeting for empty name', () => {
    assert.strictEqual(greet(''), 'Hello, world!')
  })

  it('returns default greeting for null', () => {
    assert.strictEqual(greet(null), 'Hello, world!')
  })

  it('returns default greeting for non-string', () => {
    assert.strictEqual(greet(42), 'Hello, world!')
  })
})
