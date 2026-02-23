const { describe, it } = require('node:test')
const assert = require('node:assert')

const { parseKey } = require('../lib/tui/input')

describe('tui/input', () => {
  describe('parseKey', () => {
    it('parses Ctrl+C', () => {
      assert.strictEqual(parseKey(Buffer.from([3])), 'ctrl-c')
    })

    it('parses arrow keys', () => {
      assert.strictEqual(parseKey('\x1b[A'), 'up')
      assert.strictEqual(parseKey('\x1b[B'), 'down')
      assert.strictEqual(parseKey('\x1b[C'), 'right')
      assert.strictEqual(parseKey('\x1b[D'), 'left')
    })

    it('parses Shift+Tab', () => {
      assert.strictEqual(parseKey('\x1b[Z'), 'shift-tab')
    })

    it('parses bare Escape', () => {
      assert.strictEqual(parseKey('\x1b'), 'escape')
    })

    it('parses Tab', () => {
      assert.strictEqual(parseKey(Buffer.from([9])), 'tab')
    })

    it('parses Enter (CR and LF)', () => {
      assert.strictEqual(parseKey(Buffer.from([13])), 'enter')
      assert.strictEqual(parseKey(Buffer.from([10])), 'enter')
    })

    it('parses Backspace', () => {
      assert.strictEqual(parseKey(Buffer.from([127])), 'backspace')
    })

    it('parses printable characters', () => {
      assert.strictEqual(parseKey('q'), 'q')
      assert.strictEqual(parseKey('f'), 'f')
      assert.strictEqual(parseKey('/'), '/')
      assert.strictEqual(parseKey('?'), '?')
      assert.strictEqual(parseKey('j'), 'j')
      assert.strictEqual(parseKey('k'), 'k')
    })

    it('returns unknown for unrecognized sequences', () => {
      assert.strictEqual(parseKey('\x1b[999~'), 'unknown')
    })
  })
})
