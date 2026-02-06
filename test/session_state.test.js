const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  logReview,
  loadSessionState,
  saveSessionState,
  getLatestSnapshot,
  generateDiffsSince
} = require('../lib/shared')

/**
 * Tests for session_id-dependent state functions.
 *
 * session_id comes from hook JSON input (input.session_id) and is passed
 * as a parameter to all session functions. No env vars involved.
 */
describe('session state functions', () => {
  let tmpDir
  let origProveItDir
  let origHome
  const SESSION_ID = 'test-session-abc123'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_session_'))
    origProveItDir = process.env.PROVE_IT_DIR
    origHome = process.env.HOME

    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
    process.env.HOME = tmpDir
  })

  afterEach(() => {
    if (origProveItDir === undefined) {
      delete process.env.PROVE_IT_DIR
    } else {
      process.env.PROVE_IT_DIR = origProveItDir
    }
    process.env.HOME = origHome

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('saveSessionState / loadSessionState', () => {
    it('round-trips a string value', () => {
      saveSessionState(SESSION_ID, 'lastCommit', 'abc123')
      const result = loadSessionState(SESSION_ID, 'lastCommit')
      assert.strictEqual(result, 'abc123')
    })

    it('round-trips an object value', () => {
      const value = { files: ['a.js', 'b.js'], count: 2 }
      saveSessionState(SESSION_ID, 'editedFiles', value)
      const result = loadSessionState(SESSION_ID, 'editedFiles')
      assert.deepStrictEqual(result, value)
    })

    it('returns null for missing key', () => {
      saveSessionState(SESSION_ID, 'exists', true)
      assert.strictEqual(loadSessionState(SESSION_ID, 'doesNotExist'), null)
    })

    it('overwrites previous value for same key', () => {
      saveSessionState(SESSION_ID, 'counter', 1)
      saveSessionState(SESSION_ID, 'counter', 2)
      assert.strictEqual(loadSessionState(SESSION_ID, 'counter'), 2)
    })

    it('preserves separate keys independently', () => {
      saveSessionState(SESSION_ID, 'key1', 'val1')
      saveSessionState(SESSION_ID, 'key2', 'val2')
      assert.strictEqual(loadSessionState(SESSION_ID, 'key1'), 'val1')
      assert.strictEqual(loadSessionState(SESSION_ID, 'key2'), 'val2')
    })

    it('writes to the correct file path', () => {
      saveSessionState(SESSION_ID, 'test', true)
      const stateFile = path.join(tmpDir, 'prove_it', 'sessions', `${SESSION_ID}.json`)
      assert.ok(fs.existsSync(stateFile), `State file should exist at ${stateFile}`)
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      assert.strictEqual(data.test, true)
    })

    it('returns null when sessionId is null', () => {
      saveSessionState(null, 'key', 'value') // should no-op
      assert.strictEqual(loadSessionState(null, 'key'), null)
    })
  })

  describe('logReview', () => {
    it('creates a JSONL file named after the session', () => {
      logReview(SESSION_ID, '/project', 'done', 'pass', 'Tests passed')
      const logFile = path.join(tmpDir, 'prove_it', 'sessions', `${SESSION_ID}.jsonl`)
      assert.ok(fs.existsSync(logFile), `Log file should exist at ${logFile}`)
    })

    it('writes valid JSONL with expected fields', () => {
      logReview(SESSION_ID, '/project', 'stop', 'fail', '2 tests failed')
      const logFile = path.join(tmpDir, 'prove_it', 'sessions', `${SESSION_ID}.jsonl`)
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      assert.strictEqual(lines.length, 1)

      const entry = JSON.parse(lines[0])
      assert.strictEqual(entry.reviewer, 'stop')
      assert.strictEqual(entry.status, 'fail')
      assert.strictEqual(entry.reason, '2 tests failed')
      assert.strictEqual(entry.projectDir, '/project')
      assert.strictEqual(entry.sessionId, SESSION_ID)
      assert.ok(typeof entry.at === 'number', 'at should be a timestamp')
    })

    it('appends multiple entries to the same file', () => {
      logReview(SESSION_ID, '/project', 'done', 'pass', 'OK')
      logReview(SESSION_ID, '/project', 'stop', 'skip', 'No changes')
      logReview(SESSION_ID, '/project', 'done', 'fail', 'Lint failed')

      const logFile = path.join(tmpDir, 'prove_it', 'sessions', `${SESSION_ID}.jsonl`)
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      assert.strictEqual(lines.length, 3)

      const entries = lines.map((l) => JSON.parse(l))
      assert.strictEqual(entries[0].status, 'pass')
      assert.strictEqual(entries[1].status, 'skip')
      assert.strictEqual(entries[2].status, 'fail')
    })

    it('skips logging when sessionId is null', () => {
      logReview(null, '/project', 'done', 'pass', 'OK')
      const logFile = path.join(tmpDir, 'prove_it', 'sessions', 'unknown.jsonl')
      assert.ok(!fs.existsSync(logFile), 'Should not create unknown.jsonl')
    })
  })

  describe('getLatestSnapshot', () => {
    it('returns null when sessionId is null', () => {
      assert.strictEqual(getLatestSnapshot(null, '/project'), null)
    })

    it('returns null when JSONL file does not exist', () => {
      assert.strictEqual(getLatestSnapshot(SESSION_ID, '/nonexistent'), null)
    })

    it('reads the most recent file-history-snapshot', () => {
      // Create the JSONL file that Claude Code would write
      const encoded = '/project'.replace(/[^a-zA-Z0-9-]/g, '-')
      const jsonlDir = path.join(tmpDir, '.claude', 'projects', encoded)
      fs.mkdirSync(jsonlDir, { recursive: true })

      const snapshot1 = {
        messageId: 'msg-001',
        trackedFileBackups: {
          '/project/a.js': { version: 1, backupFileName: 'a.js.bak' }
        }
      }
      const snapshot2 = {
        messageId: 'msg-002',
        trackedFileBackups: {
          '/project/a.js': { version: 2, backupFileName: 'a.js.bak' },
          '/project/b.js': { version: 1, backupFileName: 'b.js.bak' }
        }
      }

      const jsonlPath = path.join(jsonlDir, `${SESSION_ID}.jsonl`)
      fs.writeFileSync(jsonlPath, [
        JSON.stringify({ type: 'file-history-snapshot', snapshot: snapshot1 }),
        JSON.stringify({ type: 'other-event', data: 'ignored' }),
        JSON.stringify({ type: 'file-history-snapshot', snapshot: snapshot2 })
      ].join('\n') + '\n')

      const result = getLatestSnapshot(SESSION_ID, '/project')
      assert.deepStrictEqual(result, snapshot2)
      assert.strictEqual(result.messageId, 'msg-002')
      assert.strictEqual(Object.keys(result.trackedFileBackups).length, 2)
    })
  })

  describe('generateDiffsSince', () => {
    it('returns empty array when sessionId is null', () => {
      assert.deepStrictEqual(generateDiffsSince(null, '/project', null, 10000), [])
    })

    it('generates diffs between backup and current file', () => {
      const projectDir = path.join(tmpDir, 'project')
      fs.mkdirSync(projectDir, { recursive: true })

      // Create the current file
      fs.writeFileSync(path.join(projectDir, 'hello.js'), 'console.log("hello world");\n')

      // Create the backup (old version) in file-history
      const fileHistoryDir = path.join(tmpDir, '.claude', 'file-history', SESSION_ID)
      fs.mkdirSync(fileHistoryDir, { recursive: true })
      fs.writeFileSync(path.join(fileHistoryDir, 'hello.js.bak'), 'console.log("hello");\n')

      // Create the JSONL snapshot that references the backup
      const encoded = projectDir.replace(/[^a-zA-Z0-9-]/g, '-')
      const jsonlDir = path.join(tmpDir, '.claude', 'projects', encoded)
      fs.mkdirSync(jsonlDir, { recursive: true })

      const snapshot = {
        messageId: 'msg-001',
        trackedFileBackups: {
          [path.join(projectDir, 'hello.js')]: { version: 1, backupFileName: 'hello.js.bak' }
        }
      }

      fs.writeFileSync(
        path.join(jsonlDir, `${SESSION_ID}.jsonl`),
        JSON.stringify({ type: 'file-history-snapshot', snapshot }) + '\n'
      )

      const diffs = generateDiffsSince(SESSION_ID, projectDir, null, 10000)
      assert.strictEqual(diffs.length, 1)
      assert.strictEqual(diffs[0].file, path.join(projectDir, 'hello.js'))
      assert.ok(diffs[0].diff.includes('hello world'), 'Diff should show the new content')
    })
  })
})
