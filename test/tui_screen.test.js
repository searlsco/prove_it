const { describe, it } = require('node:test')
const assert = require('node:assert')

const {
  moveTo, BOX, DIM, BOLD, RESET,
  statusColor, stripAnsi, horizontalLine, topBorder, divider, bottomBorder,
  fitText, boxLine, enterAltScreen, leaveAltScreen,
  ALT_SCREEN_ON, ALT_SCREEN_OFF, CURSOR_HIDE, CURSOR_SHOW, CLEAR_SCREEN
} = require('../lib/tui/screen')

describe('tui/screen', () => {
  describe('moveTo', () => {
    it('generates correct ANSI escape', () => {
      assert.strictEqual(moveTo(5, 10), '\x1b[5;10H')
    })
  })

  describe('statusColor', () => {
    it('returns green for PASS', () => {
      assert.strictEqual(statusColor('PASS'), '\x1b[32m')
    })

    it('returns red for FAIL', () => {
      assert.strictEqual(statusColor('FAIL'), '\x1b[31m')
    })

    it('returns empty string for unknown status', () => {
      assert.strictEqual(statusColor('UNKNOWN'), '')
    })
  })

  describe('stripAnsi', () => {
    it('removes ANSI color codes', () => {
      assert.strictEqual(stripAnsi('\x1b[32mPASS\x1b[0m'), 'PASS')
    })

    it('passes through plain text', () => {
      assert.strictEqual(stripAnsi('hello'), 'hello')
    })

    it('removes multiple codes', () => {
      assert.strictEqual(stripAnsi(`${DIM}dim${RESET} ${BOLD}bold${RESET}`), 'dim bold')
    })
  })

  describe('horizontalLine', () => {
    it('draws a line of specified width', () => {
      const line = horizontalLine(10)
      assert.strictEqual(line, BOX.horizontal.repeat(10))
    })

    it('embeds a label', () => {
      const line = horizontalLine(20, 'Test')
      const plain = stripAnsi(line)
      assert.ok(plain.includes('Test'))
      assert.strictEqual(plain.length, 20)
    })

    it('uses bold for focused label', () => {
      const line = horizontalLine(20, 'Test', true)
      assert.ok(line.includes(BOLD))
    })
  })

  describe('topBorder', () => {
    it('starts with top-left corner and ends with top-right', () => {
      const border = topBorder(20, 'Sessions')
      const plain = stripAnsi(border)
      assert.strictEqual(plain[0], BOX.topLeft)
      assert.strictEqual(plain[plain.length - 1], BOX.topRight)
    })

    it('has exact width', () => {
      const border = topBorder(40, 'Sessions')
      const plain = stripAnsi(border)
      assert.strictEqual(plain.length, 40)
    })
  })

  describe('divider', () => {
    it('starts with tee-right and ends with tee-left', () => {
      const d = divider(20, 'Log')
      const plain = stripAnsi(d)
      assert.strictEqual(plain[0], BOX.teeRight)
      assert.strictEqual(plain[plain.length - 1], BOX.teeLeft)
    })

    it('has exact width', () => {
      const d = divider(40, 'Log')
      const plain = stripAnsi(d)
      assert.strictEqual(plain.length, 40)
    })
  })

  describe('bottomBorder', () => {
    it('has exact width', () => {
      const b = bottomBorder(40)
      assert.strictEqual(b.length, 40)
      assert.strictEqual(b[0], BOX.bottomLeft)
      assert.strictEqual(b[b.length - 1], BOX.bottomRight)
    })
  })

  describe('fitText', () => {
    it('pads short text with spaces', () => {
      const result = fitText('hi', 10)
      assert.strictEqual(result.length, 10)
      assert.strictEqual(result, 'hi        ')
    })

    it('truncates long text', () => {
      const result = fitText('a very long string', 8)
      const plain = stripAnsi(result)
      assert.strictEqual(plain.length, 8)
    })

    it('handles ANSI codes in text', () => {
      const colored = `${'\x1b[32m'}PASS${RESET} text`
      const result = fitText(colored, 10)
      const plain = stripAnsi(result)
      assert.strictEqual(plain.length, 10)
    })

    it('returns exact width for exact-length text', () => {
      const result = fitText('exact', 5)
      const plain = stripAnsi(result)
      assert.strictEqual(plain.length, 5)
    })
  })

  describe('boxLine', () => {
    it('wraps text between vertical bars', () => {
      const line = boxLine('hello', 20)
      const plain = stripAnsi(line)
      assert.strictEqual(plain[0], BOX.vertical)
      assert.strictEqual(plain[plain.length - 1], BOX.vertical)
      assert.ok(plain.includes('hello'))
    })

    it('has exact width', () => {
      const line = boxLine('test', 30)
      const plain = stripAnsi(line)
      assert.strictEqual(plain.length, 30)
    })
  })

  describe('enterAltScreen / leaveAltScreen', () => {
    it('writes correct sequences', () => {
      let output = ''
      const stream = { write: (s) => { output += s } }
      enterAltScreen(stream)
      assert.ok(output.includes(ALT_SCREEN_ON))
      assert.ok(output.includes(CURSOR_HIDE))
      assert.ok(output.includes(CLEAR_SCREEN))

      output = ''
      leaveAltScreen(stream)
      assert.ok(output.includes(CURSOR_SHOW))
      assert.ok(output.includes(ALT_SCREEN_OFF))
    })
  })
})
