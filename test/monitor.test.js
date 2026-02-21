const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { findLatestSession, listSessions, findProjectLogFiles, projectHash, formatEntry, formatVerbose, formatTime, formatDuration, useColor, stripAnsi, visualWidth } = require('../lib/monitor')

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

    it('excludes test-session and _project_ files, returning null when only those exist', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      fs.writeFileSync(path.join(sessionsDir, 'test-session-abc.jsonl'), '{"at":1}\n')
      fs.writeFileSync(path.join(sessionsDir, '_project_abc123.jsonl'), '{"at":2}\n')
      fs.writeFileSync(path.join(sessionsDir, 'real-session.jsonl'), '{"at":3}\n')

      // real-session is the only non-excluded file
      const result = findLatestSession(sessionsDir)
      assert.strictEqual(result, 'real-session')

      // Remove the real session, only excluded files remain
      fs.unlinkSync(path.join(sessionsDir, 'real-session.jsonl'))
      const resultExcludedOnly = findLatestSession(sessionsDir)
      assert.strictEqual(resultExcludedOnly, null)
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
    ;[
      ['PASS', 'fast-tests', './script/test_fast passed (2.3s)', ['PASS', 'fast-tests', 'passed (2.3s)']],
      ['FAIL', 'full-tests', './script/test failed (exit 1, 4.2s)', ['FAIL', 'full-tests', 'failed']],
      ['SKIP', 'fast-tests', 'cached pass (no code changes)', ['SKIP', 'cached pass']],
      ['PASS with null reason', 'lock-config', null, ['PASS', 'lock-config']]
    ].forEach(([label, reviewer, reason, expectedSubstrings]) => {
      it(`formats a ${label} entry`, () => {
        const entry = { at: Date.now(), reviewer, status: label.split(' ')[0], reason }
        const line = formatEntry(entry)
        expectedSubstrings.forEach(sub => {
          assert.ok(line.includes(sub), `Expected "${sub}" in: ${line}`)
        })
      })
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

    it('includes or omits hookEvent in parens based on presence', () => {
      const base = { at: Date.now(), reviewer: 'fast-tests', status: 'PASS', reason: 'OK' }

      const withStop = formatEntry({ ...base, hookEvent: 'Stop' })
      assert.ok(withStop.includes('(Stop)'), `Expected (Stop) in: ${withStop}`)

      const withPreCommit = formatEntry({ ...base, hookEvent: 'pre-commit' })
      assert.ok(withPreCommit.includes('(pre-commit)'), `Expected (pre-commit) in: ${withPreCommit}`)

      const without = formatEntry(base)
      assert.ok(!without.includes('('), `Should not have parens in: ${without}`)
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

    it('includes or omits triggerProgress based on presence', () => {
      const withProgress = formatEntry({
        at: Date.now(),
        reviewer: 'commit-review',
        status: 'SKIP',
        reason: 'Skipped because only 388 of 500 lines changed',
        triggerProgress: 'linesChanged: 388/500'
      })
      assert.ok(withProgress.includes('{linesChanged: 388/500}'), `Expected trigger progress in: ${withProgress}`)

      const withRunning = formatEntry({
        at: Date.now(),
        reviewer: 'commit-review',
        status: 'RUNNING',
        triggerProgress: 'linesWritten: 512/500'
      })
      assert.ok(withRunning.includes('{linesWritten: 512/500}'), `Expected trigger progress in: ${withRunning}`)

      const without = formatEntry({
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK'
      })
      assert.ok(!without.includes('{'), `Should not have trigger progress in: ${without}`)
    })

    it('includes or omits duration bracket based on durationMs presence', () => {
      const withDuration = formatEntry({
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK',
        durationMs: 3200
      })
      assert.ok(withDuration.includes('[3.2s]'), `Expected [3.2s] in: ${withDuration}`)

      const without = formatEntry({
        at: Date.now(),
        reviewer: 'fast-tests',
        status: 'PASS',
        reason: 'OK'
      })
      assert.ok(!without.includes('['), `Should not have duration bracket in: ${without}`)
    })
  })

  describe('formatDuration', () => {
    ;[
      [450, '450ms'],
      [3200, '3.2s'],
      [null, ''],
      [undefined, ''],
      [60000, '1m00s'],
      [93000, '1m33s'],
      [302000, '5m02s'],
      [59900, '59.9s']
    ].forEach(([input, expected]) => {
      it(`formats ${input} as "${expected}"`, () => {
        assert.strictEqual(formatDuration(input), expected)
      })
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

  describe('formatVerbose', () => {
    beforeEach(() => {
      process.env.NO_COLOR = '1'
    })

    it('returns empty array when entry has no verbose data', () => {
      const entry = { at: Date.now(), reviewer: 'test', status: 'PASS', reason: 'ok' }
      assert.deepStrictEqual(formatVerbose(entry), [])
    })

    it('renders agent verbose data with prompt and response boxes', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'commit-review',
        status: 'PASS',
        reason: 'looks good',
        verbose: {
          prompt: 'Review these changes',
          response: 'PASS: All good',
          model: 'haiku',
          backchannel: false
        }
      }
      const lines = formatVerbose(entry)
      assert.ok(lines.length > 0, 'Should have verbose output')

      const joined = lines.join('\n')
      assert.ok(joined.includes('prompt'), 'Should have prompt label')
      assert.ok(joined.includes('haiku'), 'Should include model name')
      assert.ok(joined.includes('Review these changes'), 'Should include prompt content')
      assert.ok(joined.includes('response'), 'Should have response label')
      assert.ok(joined.includes('PASS: All good'), 'Should include response content')
    })

    it('renders script verbose data with command and output boxes', () => {
      const entry = {
        at: Date.now(),
        reviewer: 'run-tests',
        status: 'PASS',
        reason: 'passed',
        verbose: {
          command: './script/test_fast',
          output: 'standard: no errors\n42 tests passed',
          exitCode: 0
        }
      }
      const lines = formatVerbose(entry)
      assert.ok(lines.length > 0, 'Should have verbose output')

      const joined = lines.join('\n')
      assert.ok(joined.includes('command'), 'Should have command label')
      assert.ok(joined.includes('./script/test_fast'), 'Should include command')
      assert.ok(joined.includes('output'), 'Should have output label')
      assert.ok(joined.includes('exit 0'), 'Should include exit code')
      assert.ok(joined.includes('42 tests passed'), 'Should include output content')
    })

    it('renders multi-line prompt content', () => {
      const entry = {
        at: Date.now(),
        verbose: {
          prompt: 'line one\nline two\nline three',
          response: 'PASS: ok',
          model: null,
          backchannel: false
        }
      }
      const lines = formatVerbose(entry)
      const joined = lines.join('\n')
      assert.ok(joined.includes('line one'), 'Should have first line')
      assert.ok(joined.includes('line two'), 'Should have second line')
      assert.ok(joined.includes('line three'), 'Should have third line')
    })

    it('shows backchannel indicator when active', () => {
      const entry = {
        at: Date.now(),
        verbose: {
          prompt: 'Review',
          response: 'PASS: ok',
          model: 'haiku',
          backchannel: true
        }
      }
      const lines = formatVerbose(entry)
      const joined = lines.join('\n')
      assert.ok(joined.includes('backchannel'), 'Should indicate backchannel is active')
    })

    it('omits model suffix when model is null', () => {
      const entry = {
        at: Date.now(),
        verbose: {
          prompt: 'Review',
          response: 'PASS: ok',
          model: null,
          backchannel: false
        }
      }
      const lines = formatVerbose(entry)
      const promptLine = lines.find(l => l.includes('prompt'))
      assert.ok(promptLine, 'Should have prompt label')
      assert.ok(!promptLine.includes('model:'), 'Should not have model suffix when null')
    })

    it('omits response box when response is null', () => {
      const entry = {
        at: Date.now(),
        verbose: {
          prompt: 'Review',
          response: null,
          model: 'haiku',
          backchannel: false
        }
      }
      const lines = formatVerbose(entry)
      const joined = lines.join('\n')
      assert.ok(joined.includes('prompt'), 'Should have prompt box')
      assert.ok(!joined.includes('response'), 'Should not have response box when null')
    })
  })

  describe('projectHash', () => {
    it('returns a 12-char hex string', () => {
      const hash = projectHash('/some/project/dir')
      assert.match(hash, /^[0-9a-f]{12}$/)
    })

    it('is deterministic', () => {
      assert.strictEqual(projectHash('/foo/bar'), projectHash('/foo/bar'))
    })

    it('differs for different directories', () => {
      assert.notStrictEqual(projectHash('/foo/bar'), projectHash('/foo/baz'))
    })
  })

  describe('findProjectLogFiles', () => {
    it('finds project aggregate log and matching session logs', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      const projectDir = '/home/user/myproject'
      const hash = projectHash(projectDir)

      // Create project aggregate log
      fs.writeFileSync(path.join(sessionsDir, `_project_${hash}.jsonl`), '{"at":1}\n')

      // Create a matching session
      const sid = 'matching-session-1234'
      fs.writeFileSync(path.join(sessionsDir, `${sid}.json`), JSON.stringify({
        project_dir: projectDir,
        started_at: '2025-01-01T00:00:00Z'
      }))
      fs.writeFileSync(path.join(sessionsDir, `${sid}.jsonl`), '{"at":2}\n')

      // Create a non-matching session
      const otherSid = 'other-session-5678'
      fs.writeFileSync(path.join(sessionsDir, `${otherSid}.json`), JSON.stringify({
        project_dir: '/different/project',
        started_at: '2025-01-01T00:00:00Z'
      }))
      fs.writeFileSync(path.join(sessionsDir, `${otherSid}.jsonl`), '{"at":3}\n')

      const files = findProjectLogFiles(sessionsDir, projectDir)
      assert.strictEqual(files.length, 2)
      assert.ok(files.some(f => f.includes(`_project_${hash}.jsonl`)))
      assert.ok(files.some(f => f.includes(`${sid}.jsonl`)))
      assert.ok(!files.some(f => f.includes(`${otherSid}.jsonl`)))
    })

    it('returns empty when no matching files exist', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      const files = findProjectLogFiles(sessionsDir, '/nonexistent/project')
      assert.strictEqual(files.length, 0)
    })

    it('returns empty when sessions dir does not exist', () => {
      const files = findProjectLogFiles(path.join(tmpDir, 'nonexistent'), '/some/project')
      assert.strictEqual(files.length, 0)
    })

    it('finds project log when given a relative path', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      // Simulate what session.js does: hash the absolute project dir.
      // Use fs.realpathSync to resolve symlinks (e.g. /tmp → /private/tmp on macOS)
      // so the hash matches what path.resolve produces from a chdir'd CWD.
      const realTmpDir = fs.realpathSync(tmpDir)
      const absoluteDir = path.join(realTmpDir, 'myproject')
      const hash = projectHash(absoluteDir)
      fs.writeFileSync(path.join(sessionsDir, `_project_${hash}.jsonl`), '{"at":1}\n')

      // Look up using a relative path that resolves to the same absolute path
      const origCwd = process.cwd()
      process.chdir(realTmpDir)
      try {
        const files = findProjectLogFiles(sessionsDir, './myproject')
        assert.strictEqual(files.length, 1, 'Should find project log via relative path')
        assert.ok(files[0].includes(`_project_${hash}.jsonl`))
      } finally {
        process.chdir(origCwd)
      }
    })
  })

  describe('listSessions with project filter', () => {
    it('filters sessions by project directory', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      // Session in target project
      const sid1 = 'session-project-a'
      fs.writeFileSync(path.join(sessionsDir, `${sid1}.json`), JSON.stringify({
        project_dir: '/home/user/projectA',
        started_at: '2025-01-15T10:00:00Z'
      }))
      fs.writeFileSync(path.join(sessionsDir, `${sid1}.jsonl`), '{"at":1}\n')

      // Session in different project
      const sid2 = 'session-project-b'
      fs.writeFileSync(path.join(sessionsDir, `${sid2}.json`), JSON.stringify({
        project_dir: '/home/user/projectB',
        started_at: '2025-01-15T11:00:00Z'
      }))
      fs.writeFileSync(path.join(sessionsDir, `${sid2}.jsonl`), '{"at":2}\n')

      const logs = []
      const origLog = console.log
      console.log = (...args) => logs.push(args.join(' '))
      try {
        listSessions('/home/user/projectA')
      } finally {
        console.log = origLog
      }

      const output = logs.join('\n')
      assert.ok(output.includes('/home/user/projectA'), 'Should show projectA')
      assert.ok(!output.includes('/home/user/projectB'), 'Should not show projectB')
    })

    it('shows "No sessions found." when no sessions match project', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      const sid = 'session-other'
      fs.writeFileSync(path.join(sessionsDir, `${sid}.json`), JSON.stringify({
        project_dir: '/home/user/other',
        started_at: '2025-01-15T10:00:00Z'
      }))
      fs.writeFileSync(path.join(sessionsDir, `${sid}.jsonl`), '{"at":1}\n')

      const logs = []
      const origLog = console.log
      console.log = (...args) => logs.push(args.join(' '))
      try {
        listSessions('/home/user/nonexistent')
      } finally {
        console.log = origLog
      }

      assert.ok(logs.some(l => l.includes('No sessions found.')))
    })

    it('lists all sessions when no project filter', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })

      const sid1 = 'session-all-a'
      fs.writeFileSync(path.join(sessionsDir, `${sid1}.json`), JSON.stringify({
        project_dir: '/home/user/projectA',
        started_at: '2025-01-15T10:00:00Z'
      }))
      fs.writeFileSync(path.join(sessionsDir, `${sid1}.jsonl`), '{"at":1}\n')

      const sid2 = 'session-all-b'
      fs.writeFileSync(path.join(sessionsDir, `${sid2}.json`), JSON.stringify({
        project_dir: '/home/user/projectB',
        started_at: '2025-01-15T11:00:00Z'
      }))
      fs.writeFileSync(path.join(sessionsDir, `${sid2}.jsonl`), '{"at":2}\n')

      const logs = []
      const origLog = console.log
      console.log = (...args) => logs.push(args.join(' '))
      try {
        listSessions()
      } finally {
        console.log = origLog
      }

      const output = logs.join('\n')
      assert.ok(output.includes('/home/user/projectA'), 'Should show projectA')
      assert.ok(output.includes('/home/user/projectB'), 'Should show projectB')
    })
  })

  describe('CLI flag parsing (--project, --verbose)', () => {
    it('parses --project alone as CWD', () => {
      const args = ['--project']
      const projectArg = args.find(a => a === '--project' || a.startsWith('--project='))
      let project = null
      if (projectArg === '--project') {
        project = '/mock/cwd'
      } else if (projectArg && projectArg.startsWith('--project=')) {
        project = projectArg.slice('--project='.length)
      }
      assert.strictEqual(project, '/mock/cwd')
    })

    it('parses --project=/foo/bar as specified path', () => {
      const args = ['--project=/foo/bar']
      const projectArg = args.find(a => a === '--project' || a.startsWith('--project='))
      let project = null
      if (projectArg === '--project') {
        project = '/mock/cwd'
      } else if (projectArg && projectArg.startsWith('--project=')) {
        project = projectArg.slice('--project='.length)
      }
      assert.strictEqual(project, '/foo/bar')
    })

    it('returns null when no --project flag', () => {
      const args = ['--all']
      const projectArg = args.find(a => a === '--project' || a.startsWith('--project='))
      let project = null
      if (projectArg === '--project') {
        project = '/mock/cwd'
      } else if (projectArg && projectArg.startsWith('--project=')) {
        project = projectArg.slice('--project='.length)
      }
      assert.strictEqual(project, null)
    })

    it('parses --verbose flag', () => {
      const args = ['--all', '--verbose']
      const verbose = args.includes('--verbose')
      assert.strictEqual(verbose, true)
    })

    it('returns false when no --verbose flag', () => {
      const args = ['--all']
      const verbose = args.includes('--verbose')
      assert.strictEqual(verbose, false)
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

    it('stripAnsi removes ANSI escape codes and passes through plain text', () => {
      assert.strictEqual(stripAnsi('\x1b[32mPASS\x1b[0m'), 'PASS')
      assert.strictEqual(stripAnsi('\x1b[2m(Stop)\x1b[0m'), '(Stop)')
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
