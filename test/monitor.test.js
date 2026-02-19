const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { findLatestSession, formatEntry, formatTime, formatDuration } = require('../lib/monitor')

describe('monitor', () => {
  let tmpDir
  let origProveItDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_monitor_'))
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
  })

  afterEach(() => {
    if (origProveItDir === undefined) {
      delete process.env.PROVE_IT_DIR
    } else {
      process.env.PROVE_IT_DIR = origProveItDir
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
      const entry = {
        at: Date.now(),
        reviewer: 'test',
        status: 'FAIL',
        reason: 'x'.repeat(200)
      }
      const line = formatEntry(entry, 80)
      assert.ok(line.length <= 80, `Line should be at most 80 chars, got ${line.length}`)
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
  })
})
