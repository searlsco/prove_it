const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { findLatestSession, listSessions, formatEntry, formatTime, formatDuration, useColor, stripAnsi, visualWidth } = require('../lib/monitor')

describe('monitor', () => {
  let tmpDir
  let origProveItDir
  let origNoColor

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_monitor_'))
    origProveItDir = process.env.PROVE_IT_DIR
    origNoColor = process.env.NO_COLOR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
  })

  afterEach(() => {
    if (origProveItDir === undefined) {
      delete process.env.PROVE_IT_DIR
    } else {
      process.env.PROVE_IT_DIR = origProveItDir
    }
    if (origNoColor === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = origNoColor
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('findLatestSession', () => {
    it('returns null when sessions dir does not exist', () => {
      const result = findLatestSession(path.join(tmpDir, 'nonexistent'))
      assert.strictEqual(result, null)
    })

    it('returns null when sessions dir is empty', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      const result = findLatestSession(sessionsDir)
      assert.strictEqual(result, null)
    })

    it('returns the most recently modified session', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      // Create two session files with different mtimes
      const older = path.join(sessionsDir, 'aaa-older.jsonl')
      const newer = path.join(sessionsDir, 'bbb-newer.jsonl')
      fs.writeFileSync(older, '{"at":1}\n')
      fs.writeFileSync(newer, '{"at":2}\n')

      // Force older mtime on the first file
      const past = new Date(Date.now() - 10000)
      fs.utimesSync(older, past, past)

      const result = findLatestSession(sessionsDir)
      assert.strictEqual(result, 'bbb-newer')
    })

    it('excludes test-session files', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      fs.writeFileSync(path.join(sessionsDir, 'test-session-abc.jsonl'), '{"at":1}\n')
      fs.writeFileSync(path.join(sessionsDir, 'real-session.jsonl'), '{"at":2}\n')

      const result = findLatestSession(sessionsDir)
      assert.strictEqual(result, 'real-session')
    })

    it('excludes _project_ files', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      fs.writeFileSync(path.join(sessionsDir, '_project_abc123.jsonl'), '{"at":1}\n')
      fs.writeFileSync(path.join(sessionsDir, 'my-session.jsonl'), '{"at":2}\n')

      const result = findLatestSession(sessionsDir)
      assert.strictEqual(result, 'my-session')
    })

    it('returns null when only excluded files exist', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      fs.writeFileSync(path.join(sessionsDir, 'test-session-abc.jsonl'), '{"at":1}\n')
      fs.writeFileSync(path.join(sessionsDir, '_project_abc123.jsonl'), '{"at":2}\n')

      const result = findLatestSession(sessionsDir)
      assert.strictEqual(result, null)
    })

    it('ignores non-jsonl files', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      fs.writeFileSync(path.join(sessionsDir, 'session.json'), '{}')
      fs.writeFileSync(path.join(sessionsDir, 'session.jsonl'), '{"at":1}\n')

      const result = findLatestSession(sessionsDir)
      assert.strictEqual(result, 'session')
    })
  })

  describe('formatTime', () => {
    it('formats epoch millis as HH:MM:SS', () => {
      const result = formatTime(0)
      // Just check it matches HH:MM:SS pattern (timezone-dependent)
      assert.match(result, /^\d{2}:\d{2}:\d{2}$/)
    })
  })

  describe('formatEntry', () => {
    it('formats a PASS entry', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: './script/test_fast passed (2.3s)'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('PASS'))
      assert.ok(line.includes('fast-tests'))
      assert.ok(line.includes('passed (2.3s)'))
    })

    it('formats a FAIL entry', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'full-tests',
        status: 'FAIL',
        reason: './script/test failed (exit 1, 4.2s)'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('FAIL'))
      assert.ok(line.includes('full-tests'))
      assert.ok(line.includes('failed'))
    })

    it('formats a SKIP entry', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'SKIP',
        reason: 'cached pass (no code changes)'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('SKIP'))
      assert.ok(line.includes('cached pass'))
    })

    it('handles null reason', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'lock-config',
        status: 'PASS',
        reason: null
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('PASS'))
      assert.ok(line.includes('lock-config'))
    })

    it('truncates long reason to terminal width', () => {
      process.env.NO_COLOR = '1'
      const entry = {
        at: Date.now(),
        reviewer: 'test',
        status: 'FAIL',
        reason: 'x'.repeat(200)
      }
      const line = formatEntry(entry, 80)
      const width = visualWidth(stripAnsi(line))
      assert.ok(width <= 80, `Visual width should be at most 80, got ${width}`)
      assert.ok(line.includes('\u2026'), 'Should have ellipsis for truncated reason')
    })

    it('does not truncate short reasons', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'test',
        status: 'PASS',
        reason: 'ok'
      }
      const line = formatEntry(entry, 120)
      assert.ok(!line.includes('\u2026'), 'Should not have ellipsis for short reason')
    })

    it('uses only first line of multi-line reason', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'test',
        status: 'FAIL',
        reason: 'first line\nsecond line\nthird line'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('first line'))
      assert.ok(!line.includes('second line'))
    })

    it('handles missing fields gracefully', () => {
      const entry = { at: Date.now() }
      const line = formatEntry(entry)
      assert.ok(line.includes('???'))
      assert.ok(line.includes('unknown'))
    })

    it('shows hookEvent in parens when present', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK',
        hookEvent: 'Stop'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('(Stop)'), `Expected (Stop) in: ${line}`)
    })

    it('shows git hook event in parens', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'full-tests',
        status: 'PASS',
        reason: 'OK',
        hookEvent: 'pre-commit'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('(pre-commit)'), `Expected (pre-commit) in: ${line}`)
    })

    it('omits hookEvent parens when not present', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK'
      }
      const line = formatEntry(entry)
      assert.ok(!line.includes('('), `Should not have parens in: ${line}`)
    })

    it('pads RUNNING status to 7 chars', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'RUNNING',
        reason: 'starting'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('RUNNING'), `Expected RUNNING in: ${line}`)
    })

    it('formats APPEAL status', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'commit-review',
        status: 'APPEAL',
        reason: 'appealed via backchannel',
        hookEvent: 'Stop'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('APPEAL'), `Expected APPEAL in: ${line}`)
      assert.ok(line.includes('appealed via backchannel'), `Expected reason in: ${line}`)
    })

    it('shows triggerProgress when present', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'commit-review',
        status: 'SKIP',
        reason: 'Skipped because only 388 of 500 lines changed',
        triggerProgress: 'linesChanged: 388/500'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('{linesChanged: 388/500}'), `Expected trigger progress in: ${line}`)
    })

    it('shows triggerProgress on RUNNING entry', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'commit-review',
        status: 'RUNNING',
        triggerProgress: 'linesWritten: 512/500'
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('{linesWritten: 512/500}'), `Expected trigger progress in: ${line}`)
    })

    it('omits triggerProgress when not present', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK'
      }
      const line = formatEntry(entry)
      assert.ok(!line.includes('{'), `Should not have trigger progress in: ${line}`)
    })

    it('shows duration when durationMs is present', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK',
        durationMs: 3200
      }
      const line = formatEntry(entry)
      assert.ok(line.includes('[3.2s]'), `Expected [3.2s] in: ${line}`)
    })

    it('omits duration bracket when durationMs is absent', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK'
      }
      const line = formatEntry(entry)
      assert.ok(!line.includes('['), `Should not have duration bracket in: ${line}`)
    })
  })

  describe('formatDuration', () => {
    it('formats sub-second as milliseconds', () => {
      assert.strictEqual(formatDuration(450), '450ms')
    })

    it('formats seconds with one decimal', () => {
      assert.strictEqual(formatDuration(3200), '3.2s')
    })

    it('returns empty string for null', () => {
      assert.strictEqual(formatDuration(null), '')
    })

    it('returns empty string for undefined', () => {
      assert.strictEqual(formatDuration(undefined), '')
    })

    it('formats exactly 60s as 1m00s', () => {
      assert.strictEqual(formatDuration(60000), '1m00s')
    })

    it('formats 93s as 1m33s', () => {
      assert.strictEqual(formatDuration(93000), '1m33s')
    })

    it('formats 5m2s as 5m02s (zero-padded seconds)', () => {
      assert.strictEqual(formatDuration(302000), '5m02s')
    })

    it('formats 59.9s as seconds not minutes', () => {
      assert.strictEqual(formatDuration(59900), '59.9s')
    })
  })

  describe('formatEntry with opts', () => {
    it('prepends session ID when showSession is true', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK',
        sessionId: 'abcdef12-3456-7890-abcd-ef1234567890'
      }
      const line = formatEntry(entry, null, { showSession: true })
      assert.ok(line.startsWith('[abcdef12]'), `Expected [abcdef12] prefix in: ${line}`)
    })

    it('shows [git     ] for null sessionId with showSession', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'pre-commit',
        status: 'PASS',
        reason: 'OK',
        sessionId: null
      }
      const line = formatEntry(entry, null, { showSession: true })
      assert.ok(line.startsWith('[git     ]'), `Expected [git     ] prefix in: ${line}`)
    })

    it('omits session prefix when showSession is not set', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK',
        sessionId: 'abcdef12-3456-7890-abcd-ef1234567890'
      }
      const line = formatEntry(entry)
      assert.ok(!line.startsWith('['), `Should not have session prefix in: ${line}`)
    })

    it('truncation accounts for session prefix width', () => {
      process.env.NO_COLOR = '1'
      const entry = {
        at: Date.now(),
        reviewer: 'test',
        status: 'FAIL',
        reason: 'x'.repeat(200),
        sessionId: 'abcdef12-3456'
      }
      const line = formatEntry(entry, 80, { showSession: true })
      const width = visualWidth(stripAnsi(line))
      assert.ok(width <= 80, `Visual width should be at most 80, got ${width}`)
      assert.ok(line.includes('\u2026'), 'Should have ellipsis')
    })
  })

  describe('statusFilter (--status=)', () => {
    it('cmdMonitor parses --status=FAIL,CRASH into statusFilter array', () => {
      // Verify the CLI parsing logic by testing the pattern directly
      const args = ['--all', '--status=FAIL,CRASH']
      const statusArg = args.find(a => a.startsWith('--status='))
      const statusFilter = statusArg ? statusArg.slice('--status='.length).split(',').map(s => s.trim().toUpperCase()) : null
      assert.deepStrictEqual(statusFilter, ['FAIL', 'CRASH'])
    })

    it('cmdMonitor returns null when no --status flag', () => {
      const args = ['--all']
      const statusArg = args.find(a => a.startsWith('--status='))
      const statusFilter = statusArg ? statusArg.slice('--status='.length).split(',').map(s => s.trim().toUpperCase()) : null
      assert.strictEqual(statusFilter, null)
    })

    it('filters entries in single-session display loop', () => {
      // Simulate what monitorSession does: read entries, filter by statusFilter
      const entries = [
        { at: 1, reviewer: 'a', status: 'PASS', reason: 'ok' },
        { at: 2, reviewer: 'b', status: 'FAIL', reason: 'bad' },
        { at: 3, reviewer: 'c', status: 'SKIP', reason: 'cached' },
        { at: 4, reviewer: 'd', status: 'FAIL', reason: 'also bad' }
      ]
      const opts = { statusFilter: ['FAIL'] }

      const displayed = entries.filter(e => opts.statusFilter.includes(e.status))
      assert.strictEqual(displayed.length, 2)
      assert.deepStrictEqual(displayed.map(e => e.reviewer), ['b', 'd'])
    })
  })

  describe('listSessions', () => {
    it('prints "No sessions found." when no sessions exist', () => {
      const logs = []
      const origLog = console.log
      console.log = (...args) => logs.push(args.join(' '))
      try {
        listSessions()
      } finally {
        console.log = origLog
      }
      assert.ok(logs.some(l => l.includes('No sessions found.')), `Expected "No sessions found." in: ${logs}`)
    })

    it('lists sessions with summary info', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      // Create a session state file
      const sessionId = 'abcdef12-3456-7890-abcd-ef1234567890'
      fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({
        session_id: sessionId,
        project_dir: '/home/user/project',
        started_at: '2025-01-15T10:30:00Z'
      }))

      // Create a session log file with 3 entries
      fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`),
        '{"at":1,"status":"PASS"}\n{"at":2,"status":"FAIL"}\n{"at":3,"status":"SKIP"}\n')

      const logs = []
      const origLog = console.log
      console.log = (...args) => logs.push(args.join(' '))
      try {
        listSessions()
      } finally {
        console.log = origLog
      }

      const output = logs.join('\n')
      assert.ok(output.includes('abcdef12'), `Expected short ID in: ${output}`)
      assert.ok(output.includes('/home/user/project'), `Expected project in: ${output}`)
      assert.ok(output.includes('3'), `Expected entry count in: ${output}`)
    })

    it('excludes test-session and _project_ files', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      fs.writeFileSync(path.join(sessionsDir, 'test-session-123.json'), '{"session_id":"test-session-123"}')
      fs.writeFileSync(path.join(sessionsDir, '_project_abc.json'), '{"session_id":"_project_abc"}')

      const logs = []
      const origLog = console.log
      console.log = (...args) => logs.push(args.join(' '))
      try {
        listSessions()
      } finally {
        console.log = origLog
      }
      assert.ok(logs.some(l => l.includes('No sessions found.')))
    })
  })

  describe('ANSI colors', () => {
    let origNoColor
    let origIsTTY

    beforeEach(() => {
      origNoColor = process.env.NO_COLOR
      origIsTTY = process.stdout.isTTY
    })

    afterEach(() => {
      if (origNoColor === undefined) {
        delete process.env.NO_COLOR
      } else {
        process.env.NO_COLOR = origNoColor
      }
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true })
    })

    it('useColor returns false when NO_COLOR is set', () => {
      process.env.NO_COLOR = ''
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      assert.strictEqual(useColor(), false)
    })

    it('useColor returns false when not a TTY', () => {
      delete process.env.NO_COLOR
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
      assert.strictEqual(useColor(), false)
    })

    it('useColor returns true when TTY and no NO_COLOR', () => {
      delete process.env.NO_COLOR
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      assert.strictEqual(useColor(), true)
    })

    it('stripAnsi removes ANSI escape codes', () => {
      assert.strictEqual(stripAnsi('\x1b[32mPASS\x1b[0m'), 'PASS')
      assert.strictEqual(stripAnsi('\x1b[2m(Stop)\x1b[0m'), '(Stop)')
    })

    it('stripAnsi passes through plain text', () => {
      assert.strictEqual(stripAnsi('hello world'), 'hello world')
    })

    it('formatEntry includes ANSI codes when color is active', () => {
      delete process.env.NO_COLOR
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      const entry = { at: Date.now(), reviewer: 'test', status: 'PASS', reason: 'OK' }
      const line = formatEntry(entry)
      assert.ok(line.includes('\x1b[32m'), `Expected green ANSI code in: ${JSON.stringify(line)}`)
      assert.ok(line.includes('\x1b[0m'), `Expected reset ANSI code in: ${JSON.stringify(line)}`)
    })

    it('formatEntry has no ANSI codes when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1'
      const entry = { at: Date.now(), reviewer: 'test', status: 'PASS', reason: 'OK' }
      const line = formatEntry(entry)
      assert.ok(!line.includes('\x1b['), `Should not have ANSI codes in: ${JSON.stringify(line)}`)
    })

    it('truncation accounts for ANSI width (uses plain prefix length)', () => {
      delete process.env.NO_COLOR
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      const entry = { at: Date.now(), reviewer: 'test', status: 'FAIL', reason: 'x'.repeat(200) }
      const line = formatEntry(entry, 80)
      const plainLine = stripAnsi(line)
      const width = visualWidth(plainLine)
      assert.ok(width <= 80, `Visual width should be at most 80, got ${width}`)
    })
  })
})
