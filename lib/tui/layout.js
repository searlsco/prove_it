'use strict'

/**
 * Layout calculator for the 3-panel TUI.
 *
 * The layout divides the terminal into:
 *   1. Sessions panel (top) — fixed height
 *   2. Entries panel (middle) — flexible, takes remaining space
 *   3. Detail panel (bottom) — fixed height
 *   4. Status bar (bottom line)
 *
 * All values are 1-based row numbers (ANSI terminal convention).
 */

const MIN_WIDTH = 40
const MIN_HEIGHT = 15

const SESSIONS_HEIGHT = 4 // rows for session content (excluding borders)
const DETAIL_HEIGHT = 6 // rows for detail content (excluding borders)
const STATUS_BAR_HEIGHT = 1

/**
 * Calculate panel geometry for given terminal dimensions.
 *
 * @param {number} cols - Terminal width
 * @param {number} rows - Terminal height
 * @returns {{ width, sessions, entries, detail, statusBar, tooSmall }}
 */
function calculateLayout (cols, rows) {
  const width = Math.max(cols, MIN_WIDTH)
  const height = Math.max(rows, MIN_HEIGHT)

  if (cols < MIN_WIDTH || rows < MIN_HEIGHT) {
    return { width, tooSmall: true }
  }

  // Row budget:
  //   1 row: sessions top border
  //   SESSIONS_HEIGHT rows: sessions content
  //   1 row: entries divider (also sessions bottom)
  //   N rows: entries content
  //   1 row: detail divider (also entries bottom)
  //   DETAIL_HEIGHT rows: detail content
  //   1 row: bottom border
  //   STATUS_BAR_HEIGHT row: status bar

  const fixedRows = 1 + SESSIONS_HEIGHT + 1 + 1 + DETAIL_HEIGHT + 1 + STATUS_BAR_HEIGHT
  const entriesHeight = Math.max(2, height - fixedRows)

  // Calculate row positions (1-based)
  const sessionsTop = 1 // top border row
  const sessionsContentStart = 2
  const sessionsContentEnd = sessionsContentStart + SESSIONS_HEIGHT - 1

  const entriesDivider = sessionsContentEnd + 1
  const entriesContentStart = entriesDivider + 1
  const entriesContentEnd = entriesContentStart + entriesHeight - 1

  const detailDivider = entriesContentEnd + 1
  const detailContentStart = detailDivider + 1
  const detailContentEnd = detailContentStart + DETAIL_HEIGHT - 1

  const bottomBorderRow = detailContentEnd + 1
  const statusBarRow = bottomBorderRow + 1

  return {
    width,
    tooSmall: false,
    sessions: {
      topBorderRow: sessionsTop,
      contentStart: sessionsContentStart,
      contentEnd: sessionsContentEnd,
      contentHeight: SESSIONS_HEIGHT
    },
    entries: {
      dividerRow: entriesDivider,
      contentStart: entriesContentStart,
      contentEnd: entriesContentEnd,
      contentHeight: entriesHeight
    },
    detail: {
      dividerRow: detailDivider,
      contentStart: detailContentStart,
      contentEnd: detailContentEnd,
      contentHeight: DETAIL_HEIGHT
    },
    bottomBorderRow,
    statusBar: {
      row: statusBarRow
    }
  }
}

/**
 * Inner content width (between the vertical bars).
 */
function innerWidth (layout) {
  return layout.width - 4
}

module.exports = {
  calculateLayout,
  innerWidth,
  MIN_WIDTH,
  MIN_HEIGHT,
  SESSIONS_HEIGHT,
  DETAIL_HEIGHT
}
