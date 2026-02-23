const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert')

const { createSessionsPanel } = require('../lib/tui/panels/sessions')
const { createEntriesPanel } = require('../lib/tui/panels/entries')
const { createDetailPanel } = require('../lib/tui/panels/detail')
const { stripAnsi } = require('../lib/tui/screen')

// Suppress colors for test assertions
process.env.NO_COLOR = '1'

describe('tui/panels', () => {
  describe('sessions panel', () => {
    let panel

    beforeEach(() => {
      panel = createSessionsPanel()
    })

    it('starts with empty sessions and cursor at 0', () => {
      assert.strictEqual(panel.sessions.length, 0)
      assert.strictEqual(panel.cursor, 0)
    })

    it('setSessions updates the list', () => {
      panel.setSessions([
        { id: 'abc123', project: '/foo', started: '2025-01-01T00:00:00Z', entries: 5 },
        { id: 'def456', project: '/bar', started: '2025-01-02T00:00:00Z', entries: 3 }
      ])
      assert.strictEqual(panel.sessions.length, 2)
    })

    it('navigate up and down', () => {
      panel.setSessions([
        { id: 'a', project: '/a', started: null, entries: 0 },
        { id: 'b', project: '/b', started: null, entries: 0 },
        { id: 'c', project: '/c', started: null, entries: 0 }
      ])
      assert.strictEqual(panel.cursor, 0)

      panel.moveDown()
      assert.strictEqual(panel.cursor, 1)

      panel.moveDown()
      assert.strictEqual(panel.cursor, 2)

      panel.moveDown() // at bottom, should not go past
      assert.strictEqual(panel.cursor, 2)

      panel.moveUp()
      assert.strictEqual(panel.cursor, 1)

      panel.moveUp()
      assert.strictEqual(panel.cursor, 0)

      panel.moveUp() // at top, should not go past
      assert.strictEqual(panel.cursor, 0)
    })

    it('selectedSession returns the session at cursor', () => {
      panel.setSessions([
        { id: 'a', project: '/a', started: null, entries: 1 },
        { id: 'b', project: '/b', started: null, entries: 2 }
      ])
      assert.strictEqual(panel.selectedSession().id, 'a')
      panel.moveDown()
      assert.strictEqual(panel.selectedSession().id, 'b')
    })

    it('selectedSession returns null when empty', () => {
      assert.strictEqual(panel.selectedSession(), null)
    })

    it('render returns correct number of lines', () => {
      panel.setSessions([
        { id: 'a', project: '/foo/bar', started: '2025-01-01T00:00:00Z', entries: 5 }
      ])
      const lines = panel.render(4, 76, true)
      assert.strictEqual(lines.length, 4)
      const firstPlain = stripAnsi(lines[0])
      assert.ok(firstPlain.includes('a'), 'Should include session ID')
    })

    it('render shows "(no sessions)" when empty', () => {
      const lines = panel.render(4, 76, true)
      const plain = stripAnsi(lines[0])
      assert.ok(plain.includes('no sessions'))
    })

    it('clamps cursor when sessions shrink', () => {
      panel.setSessions([
        { id: 'a', project: '/a', started: null, entries: 0 },
        { id: 'b', project: '/b', started: null, entries: 0 }
      ])
      panel.moveDown() // cursor = 1
      panel.setSessions([{ id: 'a', project: '/a', started: null, entries: 0 }])
      assert.strictEqual(panel.cursor, 0)
    })
  })

  describe('entries panel', () => {
    let panel

    beforeEach(() => {
      panel = createEntriesPanel()
    })

    it('starts with empty entries', () => {
      assert.strictEqual(panel.entries.length, 0)
      assert.strictEqual(panel.cursor, 0)
    })

    it('setEntries loads entries', () => {
      panel.setEntries([
        { at: 1, reviewer: 'a', status: 'PASS', reason: 'ok' },
        { at: 2, reviewer: 'b', status: 'FAIL', reason: 'bad' }
      ])
      assert.strictEqual(panel.entries.length, 2)
    })

    it('addEntry appends and auto-scrolls', () => {
      panel.setEntries([
        { at: 1, reviewer: 'a', status: 'PASS', reason: 'ok' }
      ])
      panel.addEntry({ at: 2, reviewer: 'b', status: 'FAIL', reason: 'bad' })
      assert.strictEqual(panel.entries.length, 2)
    })

    it('navigate up and down', () => {
      panel.setEntries([
        { at: 1, reviewer: 'a', status: 'PASS' },
        { at: 2, reviewer: 'b', status: 'FAIL' },
        { at: 3, reviewer: 'c', status: 'SKIP' }
      ])
      panel.moveDown()
      assert.strictEqual(panel.cursor, 1)
      panel.moveDown()
      assert.strictEqual(panel.cursor, 2)
      panel.moveDown()
      assert.strictEqual(panel.cursor, 2) // clamped
    })

    it('selectedEntry returns the entry at cursor', () => {
      panel.setEntries([
        { at: 1, reviewer: 'a', status: 'PASS' },
        { at: 2, reviewer: 'b', status: 'FAIL' }
      ])
      assert.strictEqual(panel.selectedEntry().reviewer, 'a')
      panel.moveDown()
      assert.strictEqual(panel.selectedEntry().reviewer, 'b')
    })

    it('cycleFilter cycles through statuses', () => {
      assert.strictEqual(panel.filter, 'ALL')
      panel.cycleFilter()
      assert.strictEqual(panel.filter, 'PASS')
      panel.cycleFilter()
      assert.strictEqual(panel.filter, 'FAIL')
      panel.cycleFilter()
      assert.strictEqual(panel.filter, 'SKIP')
      panel.cycleFilter()
      assert.strictEqual(panel.filter, 'CRASH')
      panel.cycleFilter()
      assert.strictEqual(panel.filter, 'ALL')
    })

    it('filter reduces visible entries', () => {
      panel.setEntries([
        { at: 1, reviewer: 'a', status: 'PASS', reason: 'ok' },
        { at: 2, reviewer: 'b', status: 'FAIL', reason: 'bad' },
        { at: 3, reviewer: 'c', status: 'PASS', reason: 'ok2' }
      ])
      panel.cycleFilter() // PASS
      assert.strictEqual(panel.entries.length, 2)
      panel.cycleFilter() // FAIL
      assert.strictEqual(panel.entries.length, 1)
      assert.strictEqual(panel.entries[0].reviewer, 'b')
    })

    it('search filters by term', () => {
      panel.setEntries([
        { at: 1, reviewer: 'fast-tests', status: 'PASS', reason: 'all tests passed' },
        { at: 2, reviewer: 'lock-config', status: 'FAIL', reason: 'config locked' },
        { at: 3, reviewer: 'fast-tests', status: 'SKIP', reason: 'cached' }
      ])
      panel.enterSearch()
      panel.appendSearchChar('l')
      panel.appendSearchChar('o')
      panel.appendSearchChar('c')
      panel.appendSearchChar('k')
      panel.confirmSearch()
      assert.strictEqual(panel.searchTerm, 'lock')
      assert.strictEqual(panel.entries.length, 1)
      assert.strictEqual(panel.entries[0].reviewer, 'lock-config')
    })

    it('clearSearch resets filter', () => {
      panel.setEntries([
        { at: 1, reviewer: 'alpha', status: 'PASS' },
        { at: 2, reviewer: 'beta', status: 'FAIL' }
      ])
      panel.enterSearch()
      panel.appendSearchChar('b')
      panel.appendSearchChar('e')
      panel.appendSearchChar('t')
      panel.appendSearchChar('a')
      panel.confirmSearch()
      assert.strictEqual(panel.entries.length, 1)
      panel.clearSearch()
      assert.strictEqual(panel.entries.length, 2)
    })

    it('backspaceSearch removes last char', () => {
      panel.enterSearch()
      panel.appendSearchChar('a')
      panel.appendSearchChar('b')
      panel.backspaceSearch()
      assert.strictEqual(panel.searchInput, 'a')
    })

    it('render returns correct number of lines', () => {
      panel.setEntries([
        { at: Date.now(), reviewer: 'test', status: 'PASS', reason: 'ok' }
      ])
      const lines = panel.render(10, 76, true)
      assert.strictEqual(lines.length, 10)
    })

    it('render shows "(no entries)" when empty', () => {
      const lines = panel.render(5, 76, true)
      const plain = stripAnsi(lines[0])
      assert.ok(plain.includes('no entries'))
    })

    it('label includes filter and search info', () => {
      assert.strictEqual(panel.label(), 'Log')
      panel.cycleFilter() // PASS
      assert.strictEqual(panel.label(), 'Log | filter: PASS')
      panel.enterSearch()
      panel.appendSearchChar('t')
      panel.appendSearchChar('e')
      panel.appendSearchChar('s')
      panel.appendSearchChar('t')
      panel.confirmSearch()
      assert.strictEqual(panel.label(), 'Log | filter: PASS | search: "test"')
    })
  })

  describe('detail panel', () => {
    let panel

    beforeEach(() => {
      panel = createDetailPanel()
    })

    it('starts with no entry', () => {
      assert.strictEqual(panel.entry, null)
    })

    it('setEntry loads entry and resets scroll', () => {
      panel.setEntry({
        at: Date.now(),
        reviewer: 'test',
        status: 'PASS',
        reason: 'ok',
        verbose: { command: 'npm test', output: 'passed', exitCode: 0 }
      })
      assert.ok(panel.entry !== null)
      assert.strictEqual(panel.scrollOffset, 0)
      assert.ok(panel.totalLines > 0)
    })

    it('clear removes entry', () => {
      panel.setEntry({ at: Date.now(), reviewer: 'test', status: 'PASS' })
      panel.clear()
      assert.strictEqual(panel.entry, null)
      assert.strictEqual(panel.totalLines, 0)
    })

    it('scrollDown and scrollUp', () => {
      panel.setEntry({
        at: Date.now(),
        reviewer: 'test',
        status: 'PASS',
        verbose: {
          command: 'npm test',
          output: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10',
          exitCode: 0
        }
      })
      const visibleRows = 4
      panel.scrollDown(visibleRows)
      assert.strictEqual(panel.scrollOffset, 1)
      panel.scrollUp()
      assert.strictEqual(panel.scrollOffset, 0)
      panel.scrollUp() // at top
      assert.strictEqual(panel.scrollOffset, 0)
    })

    it('render returns correct number of lines', () => {
      panel.setEntry({
        at: Date.now(),
        reviewer: 'test',
        status: 'PASS',
        verbose: { command: 'npm test', output: 'ok', exitCode: 0 }
      })
      const lines = panel.render(6, 76, true)
      assert.strictEqual(lines.length, 6)
    })

    it('render shows placeholder when no entry', () => {
      const lines = panel.render(6, 76, false)
      const plain = stripAnsi(lines[0])
      assert.ok(plain.includes('select an entry'))
    })
  })
})
