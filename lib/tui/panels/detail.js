'use strict'

const { formatVerbose, formatEntry } = require('../../monitor')
const { DIM, RESET } = require('../screen')

/**
 * Detail panel — shows verbose info for the selected entry.
 */
function createDetailPanel () {
  let entry = null
  let lines = [] // pre-rendered lines
  let scrollOffset = 0

  function rebuild () {
    lines = []
    if (!entry) return

    // Summary line
    lines.push(formatEntry(entry))
    lines.push('')

    // Verbose data
    const verbose = formatVerbose(entry)
    if (verbose.length > 0) {
      // Strip the indent that formatVerbose adds (10 spaces)
      for (const vl of verbose) {
        lines.push(vl.replace(/^ {10}/, ''))
      }
    } else {
      lines.push(`${DIM}(no verbose data)${RESET}`)
    }
  }

  return {
    get entry () { return entry },
    get scrollOffset () { return scrollOffset },
    get totalLines () { return lines.length },

    setEntry (e) {
      entry = e
      scrollOffset = 0
      rebuild()
    },

    clear () {
      entry = null
      lines = []
      scrollOffset = 0
    },

    scrollUp () {
      if (scrollOffset > 0) scrollOffset--
    },

    scrollDown (visibleRows) {
      if (scrollOffset < lines.length - visibleRows) scrollOffset++
    },

    /**
     * Render visible rows.
     */
    render (visibleRows, innerWidth, focused) {
      if (!entry) {
        const msg = `${DIM}(select an entry to view details)${RESET}`
        const result = [msg]
        while (result.length < visibleRows) result.push('')
        return result
      }

      const visible = lines.slice(scrollOffset, scrollOffset + visibleRows)
      while (visible.length < visibleRows) visible.push('')
      return visible
    }
  }
}

module.exports = { createDetailPanel }
