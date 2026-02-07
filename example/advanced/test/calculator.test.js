const { describe, it } = require('node:test')
const assert = require('node:assert')
const { add, subtract, multiply, divide, modulo } = require('../src/calculator')

describe('calculator', () => {
  describe('add', () => {
    it('adds two positive numbers', () => {
      assert.strictEqual(add(2, 3), 5)
    })

    it('adds negative numbers', () => {
      assert.strictEqual(add(-1, -2), -3)
    })

    it('adds zero', () => {
      assert.strictEqual(add(5, 0), 5)
    })
  })

  describe('subtract', () => {
    it('subtracts two numbers', () => {
      assert.strictEqual(subtract(5, 3), 2)
    })

    it('handles negative result', () => {
      assert.strictEqual(subtract(3, 5), -2)
    })
  })

  describe('multiply', () => {
    it('multiplies two numbers', () => {
      assert.strictEqual(multiply(3, 4), 12)
    })

    it('multiplies by zero', () => {
      assert.strictEqual(multiply(5, 0), 0)
    })

    it('multiplies negative numbers', () => {
      assert.strictEqual(multiply(-2, -3), 6)
    })
  })

  describe('divide', () => {
    it('divides two numbers', () => {
      assert.strictEqual(divide(10, 2), 5)
    })

    it('handles decimal result', () => {
      assert.strictEqual(divide(7, 2), 3.5)
    })

    it('throws on division by zero', () => {
      assert.throws(() => divide(5, 0), { message: 'Division by zero' })
    })
  })

  describe('modulo', () => {
    it('returns remainder', () => {
      assert.strictEqual(modulo(7, 3), 1)
    })

    it('returns zero for even division', () => {
      assert.strictEqual(modulo(6, 3), 0)
    })

    it('throws on modulo by zero', () => {
      assert.throws(() => modulo(5, 0), { message: 'Modulo by zero' })
    })
  })
})
