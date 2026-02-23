'use strict'

const { formatTime, formatDuration, normalizeHookTag, stripAnsi } = require('../../monitor')
const { DIM, RESET, INVERSE, BOLD, statusColor } = require('../screen')

const FILTER_CYCLE = ['ALL', 'PASS', 'FAIL', 'SKIP', 'CRASH']

/**
 * Entries panel — shows log entries with cursor, filtering, and search.
 */
function createEntriesPanel () {
  let allEntries = [] // raw entries
  let filtered = [] // entries after filter + search
  let cursor = 0
  let filterIndex = 0 // index into FILTER_CYCLE
  let searchTerm = ''
  let searchMode = false
  let searchInput = ''

  function applyFilter () {
    const status = FILTER_CYCLE[filterIndex]
    let result = allEntries
    if (status !== 'ALL') {
      result = result.filter(e => e.status === status)
    }
    if (searchTerm) {
      const lower = searchTerm.toLowerCase()
      result = result.filter(e => {
        const haystack = `${e.reviewer || ''} ${e.reason || ''} ${e.status || ''}`.toLowerCase()
        return haystack.includes(lower)
      })
    }
    filtered = result
    if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1)
  }

  return {
    get entries () { return filtered },
    get allEntries () { return allEntries },
    get cursor () { return cursor },
    get filter () { return FILTER_CYCLE[filterIndex] },
    get searchMode () { return searchMode },
    get searchInput () { return searchInput },
    get searchTerm () { return searchTerm },

    setEntries (list) {
      allEntries = list
      applyFilter()
    },

    addEntry (entry) {
      allEntries.push(entry)
      applyFilter()
      // Auto-scroll to bottom when new entry arrives and cursor was at end
      if (cursor === filtered.length - 2 || filtered.length === 1) {
        cursor = filtered.length - 1
      }
    },

    moveUp () {
      if (cursor > 0) cursor--
    },

    moveDown () {
      if (cursor < filtered.length - 1) cursor++
    },

    cycleFilter () {
      filterIndex = (filterIndex + 1) % FILTER_CYCLE.length
      applyFilter()
    },

    enterSearch () {
      searchMode = true
      searchInput = searchTerm
    },

    exitSearch () {
      searchMode = false
      searchInput = ''
    },

    confirmSearch () {
      searchTerm = searchInput
      searchMode = false
      searchInput = ''
      applyFilter()
    },

    clearSearch () {
      searchTerm = ''
      searchMode = false
      searchInput = ''
      applyFilter()
    },

    appendSearchChar (ch) {
      if (searchMode) searchInput += ch
    },

    backspaceSearch () {
      if (searchMode && searchInput.length > 0) {
        searchInput = searchInput.slice(0, -1)
      }
    },

    selectedEntry () {
      return filtered[cursor] || null
    },

    /**
     * Render visible rows.
     */
    render (visibleRows, innerWidth, focused) {
      if (filtered.length === 0) {
        const msg = searchTerm
          ? `${DIM}(no matches for "${searchTerm}")${RESET}`
          : `${DIM}(no entries)${RESET}`
        const lines = [msg]
        while (lines.length < visibleRows) lines.push('')
        return lines
      }

      // Visible window around cursor
      const start = Math.max(0, cursor - visibleRows + 1)
      const end = Math.min(filtered.length, start + visibleRows)

      const lines = []
      for (let i = start; i < end; i++) {
        const entry = filtered[i]
        const isSelected = i === cursor
        const pointer = isSelected ? '>' : ' '

        const time = formatTime(entry.at)
        const rawStatus = (entry.status || '???')
        const displayStatus = rawStatus === 'RUNNING' ? 'EXEC' : rawStatus
        const reviewer = entry.reviewer || 'unknown'
        const duration = entry.durationMs != null ? formatDuration(entry.durationMs) : ''
        const hookTag = entry.hookEvent ? normalizeHookTag(entry.hookEvent) : ''

        const color = statusColor(displayStatus)
        const coloredStatus = color ? `${color}${displayStatus.padEnd(6)}${RESET}` : displayStatus.padEnd(6)

        let line = `${pointer} ${DIM}${time}${RESET}  ${coloredStatus} ${reviewer}`
        if (duration) line += `  ${DIM}${duration}${RESET}`

        const reason = (entry.reason || '').split('\n')[0]
        if (reason) {
          // Truncate reason to fit
          const plainSoFar = stripAnsi(line)
          const available = innerWidth - plainSoFar.length - 2 - (hookTag ? hookTag.length + 2 : 0)
          if (available > 3 && reason.length > available) {
            line += `  ${reason.slice(0, available - 1)}\u2026`
          } else if (available > 0) {
            line += `  ${reason}`
          }
        }

        if (hookTag) {
          const plainLen = stripAnsi(line).length
          const gap = innerWidth - plainLen - hookTag.length
          if (gap >= 2) {
            line += ' '.repeat(gap) + `${DIM}${hookTag}${RESET}`
          } else {
            line += `  ${DIM}${hookTag}${RESET}`
          }
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
    },

    /**
     * Label for the panel header, including filter and search state.
     */
    label () {
      const parts = ['Log']
      if (FILTER_CYCLE[filterIndex] !== 'ALL') {
        parts.push(`filter: ${FILTER_CYCLE[filterIndex]}`)
      }
      if (searchTerm) {
        parts.push(`search: "${searchTerm}"`)
      }
      return parts.join(' | ')
    }
  }
}

module.exports = { createEntriesPanel, FILTER_CYCLE }
