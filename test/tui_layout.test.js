const { describe, it } = require('node:test')
const assert = require('node:assert')

const { calculateLayout, innerWidth, MIN_WIDTH, MIN_HEIGHT, SESSIONS_HEIGHT, DETAIL_HEIGHT } = require('../lib/tui/layout')

describe('tui/layout', () => {
  describe('calculateLayout', () => {
    it('returns tooSmall for tiny terminals', () => {
      const layout = calculateLayout(30, 10)
      assert.strictEqual(layout.tooSmall, true)
    })

    it('returns valid geometry for normal terminal', () => {
      const layout = calculateLayout(80, 40)
      assert.strictEqual(layout.tooSmall, false)
      assert.strictEqual(layout.width, 80)

      // Sessions panel
      assert.strictEqual(layout.sessions.topBorderRow, 1)
      assert.strictEqual(layout.sessions.contentStart, 2)
      assert.strictEqual(layout.sessions.contentHeight, SESSIONS_HEIGHT)

      // Entries panel starts after sessions
      assert.ok(layout.entries.dividerRow > layout.sessions.contentEnd)
      assert.strictEqual(layout.entries.contentStart, layout.entries.dividerRow + 1)

      // Detail panel starts after entries
      assert.ok(layout.detail.dividerRow > layout.entries.contentEnd)
      assert.strictEqual(layout.detail.contentStart, layout.detail.dividerRow + 1)
      assert.strictEqual(layout.detail.contentHeight, DETAIL_HEIGHT)

      // Bottom border and status bar
      assert.ok(layout.bottomBorderRow > layout.detail.contentEnd)
      assert.strictEqual(layout.statusBar.row, layout.bottomBorderRow + 1)
    })

    it('entries panel gets remaining space', () => {
      const small = calculateLayout(80, 25)
      const large = calculateLayout(80, 50)
      assert.ok(large.entries.contentHeight > small.entries.contentHeight)
    })

    it('entries panel has at least 2 rows', () => {
      const layout = calculateLayout(MIN_WIDTH, MIN_HEIGHT)
      assert.ok(layout.entries.contentHeight >= 2)
    })

    it('total rows fit within terminal height', () => {
      const layout = calculateLayout(80, 30)
      assert.ok(layout.statusBar.row <= 30, `Status bar at row ${layout.statusBar.row} exceeds 30`)
    })

    it('panels are contiguous with no gaps', () => {
      const layout = calculateLayout(80, 40)
      // Sessions content ends, then entries divider
      assert.strictEqual(layout.entries.dividerRow, layout.sessions.contentEnd + 1)
      // Entries content ends, then detail divider
      assert.strictEqual(layout.detail.dividerRow, layout.entries.contentEnd + 1)
      // Detail content ends, then bottom border
      assert.strictEqual(layout.bottomBorderRow, layout.detail.contentEnd + 1)
    })
  })

  describe('innerWidth', () => {
    it('returns width minus 4 for box borders', () => {
      const layout = calculateLayout(80, 40)
      assert.strictEqual(innerWidth(layout), 76)
    })
  })
})
