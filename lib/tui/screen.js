'use strict'

// ANSI escape sequences for terminal control

const ESC = '\x1b'

// Alternate screen buffer
const ALT_SCREEN_ON = `${ESC}[?1049h`
const ALT_SCREEN_OFF = `${ESC}[?1049l`

// Cursor visibility
const CURSOR_HIDE = `${ESC}[?25l`
const CURSOR_SHOW = `${ESC}[?25h`

// Clear
const CLEAR_SCREEN = `${ESC}[2J`

// Positioning
function moveTo (row, col) {
  return `${ESC}[${row};${col}H`
}

function clearLine () {
  return `${ESC}[2K`
}

// Box-drawing characters
const BOX = {
  topLeft: '\u250c',
  topRight: '\u2510',
  bottomLeft: '\u2514',
  bottomRight: '\u2518',
  horizontal: '\u2500',
  vertical: '\u2502',
  teeRight: '\u251c',
  teeLeft: '\u2524'
}

// Colors
const COLORS = {
  PASS: '\x1b[32m',
  FAIL: '\x1b[31m',
  SKIP: '\x1b[33m',
  CRASH: '\x1b[35m',
  EXEC: '\x1b[36m',
  RUNNING: '\x1b[36m',
  APPEAL: '\x1b[34m'
}
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const INVERSE = '\x1b[7m'
const RESET = '\x1b[0m'

function statusColor (status) {
  return COLORS[status] || ''
}

function stripAnsi (str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

/**
 * Draw a horizontal line using box chars.
 * If label is provided, embed it: ── Label ──
 */
function horizontalLine (width, label, focused) {
  if (!label) return BOX.horizontal.repeat(width)
  const prefix = `${BOX.horizontal} `
  const labelText = focused
    ? `${BOLD}${label}${RESET}`
    : label
  const plainLabel = stripAnsi(labelText)
  const suffix = ' ' + BOX.horizontal.repeat(Math.max(0, width - prefix.length - plainLabel.length - 1))
  return prefix + labelText + suffix
}

/**
 * Draw a top border: ┌── Label ──────────┐
 */
function topBorder (width, label, focused) {
  const inner = horizontalLine(width - 2, label, focused)
  return BOX.topLeft + inner + BOX.topRight
}

/**
 * Draw a divider: ├── Label ─────────────┤
 */
function divider (width, label, focused) {
  const inner = horizontalLine(width - 2, label, focused)
  return BOX.teeRight + inner + BOX.teeLeft
}

/**
 * Draw a bottom border: └──────────────────┘
 */
function bottomBorder (width) {
  return BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight
}

/**
 * Pad or truncate a string to exactly `width` visible characters.
 */
function fitText (text, width) {
  const plain = stripAnsi(text)
  if (plain.length >= width) {
    // Need to truncate - walk through accounting for ANSI codes
    let visibleCount = 0
    let result = ''
    // eslint-disable-next-line no-control-regex
    const parts = text.split(/(\x1b\[[0-9;]*[a-zA-Z])/)
    for (const part of parts) {
      // eslint-disable-next-line no-control-regex
      if (/^\x1b\[[0-9;]*[a-zA-Z]$/.test(part)) {
        result += part
      } else {
        const remaining = width - visibleCount
        if (part.length <= remaining) {
          result += part
          visibleCount += part.length
        } else {
          result += part.slice(0, remaining)
          visibleCount += remaining
          break
        }
      }
    }
    return result + RESET
  }
  return text + ' '.repeat(width - plain.length)
}

/**
 * Wrap text in box-drawing vertical bars: │ text │
 * Content is padded/truncated to fit exactly between the bars.
 */
function boxLine (text, width) {
  const innerWidth = width - 4 // 2 for "│ " and " │"
  return `${BOX.vertical} ${fitText(text, innerWidth)} ${BOX.vertical}`
}

/**
 * Enter alternate screen: switch buffer, hide cursor, clear.
 */
function enterAltScreen (stream) {
  stream.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR_SCREEN)
}

/**
 * Leave alternate screen: show cursor, restore buffer.
 */
function leaveAltScreen (stream) {
  stream.write(CURSOR_SHOW + ALT_SCREEN_OFF)
}

/**
 * Write a string at a specific row/col position.
 */
function writeAt (stream, row, col, text) {
  stream.write(moveTo(row, col) + text)
}

module.exports = {
  ALT_SCREEN_ON,
  ALT_SCREEN_OFF,
  CURSOR_HIDE,
  CURSOR_SHOW,
  CLEAR_SCREEN,
  moveTo,
  clearLine,
  BOX,
  COLORS,
  DIM,
  BOLD,
  INVERSE,
  RESET,
  statusColor,
  stripAnsi,
  horizontalLine,
  topBorder,
  divider,
  bottomBorder,
  fitText,
  boxLine,
  enterAltScreen,
  leaveAltScreen,
  writeAt
}
