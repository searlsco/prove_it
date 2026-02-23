'use strict'

const { formatTime } = require('../../monitor')
const { BOLD, DIM, RESET, INVERSE, stripAnsi } = require('../screen')

/**
 * Sessions panel — shows list of sessions with cursor.
 */
function createSessionsPanel () {
  let sessions = [] // Array of { id, project, started, entries }
  let cursor = 0

  return {
    get sessions () { return sessions },
    get cursor () { return cursor },

    setSessions (list) {
      sessions = list
      if (cursor >= sessions.length) cursor = Math.max(0, sessions.length - 1)
    },

    moveUp () {
      if (cursor > 0) cursor--
    },

    moveDown () {
      if (cursor < sessions.length - 1) cursor++
    },

    selectedSession () {
      return sessions[cursor] || null
    },

    /**
     * Render visible rows for the panel.
     *
     * @param {number} visibleRows - Number of content rows available
     * @param {number} innerWidth - Character width for content
     * @param {boolean} focused - Whether this panel has focus
     * @returns {string[]} Array of formatted lines
     */
    render (visibleRows, innerWidth, focused) {
      if (sessions.length === 0) {
        const msg = `${DIM}(no sessions)${RESET}`
        const lines = [msg]
        while (lines.length < visibleRows) lines.push('')
        return lines
      }

      // Determine visible window around cursor
      const start = Math.max(0, cursor - visibleRows + 1)
      const end = Math.min(sessions.length, start + visibleRows)

      const lines = []
      for (let i = start; i < end; i++) {
        const s = sessions[i]
        const isSelected = i === cursor
        const pointer = isSelected ? '>' : ' '
        const shortId = s.id.slice(0, 8)
        const time = s.started ? formatTime(new Date(s.started).getTime()) : '     '
        const count = `${s.entries} entries`

        // Truncate project path to fit
        const fixedLen = 2 + 8 + 2 + 5 + 2 + count.length // "  " + id + "  " + time + "  " + count
        const projectMaxLen = Math.max(8, innerWidth - fixedLen)
        let project = s.project
        if (project.length > projectMaxLen) {
          project = '\u2026' + project.slice(-(projectMaxLen - 1))
        }

        let line = `${pointer} ${shortId}  ${project}`
        // Pad to push time + count to the right
        const plainSoFar = stripAnsi(line)
        const rightPart = `${time}  ${count}`
        const gap = innerWidth - plainSoFar.length - rightPart.length
        if (gap > 0) {
          line += ' '.repeat(gap) + `${DIM}${rightPart}${RESET}`
        } else {
          line += `  ${DIM}${rightPart}${RESET}`
        }

        if (isSelected && focused) {
          line = `${INVERSE}${line}${RESET}`
        } else if (isSelected) {
          line = `${BOLD}${line}${RESET}`
        }

        lines.push(line)
      }

      while (lines.length < visibleRows) lines.push('')
      return lines
    }
  }
}

module.exports = { createSessionsPanel }
