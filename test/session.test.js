const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  logReview,
  projectLogName,
  loadSessionState,
  saveSessionState,
  getLatestSnapshot,
  generateDiffsSince
} = require('../lib/session')
const { recordSessionBaseline } = require('../lib/dispatcher/claude')

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
      assert.strictEqual(fs.existsSync(stateFile), true, `State file should exist at ${stateFile}`)
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      assert.strictEqual(data.test, true)
    })

    it('returns null when sessionId is null', () => {
      saveSessionState(null, 'key', 'value')
      assert.strictEqual(loadSessionState(null, 'key'), null)
    })

    it('supports multiple keys in the same state file', () => {
      saveSessionState('test-multikey', 'key_a', 'value_a')
      saveSessionState('test-multikey', 'key_b', 'value_b')

      assert.strictEqual(loadSessionState('test-multikey', 'key_a'), 'value_a')
      assert.strictEqual(loadSessionState('test-multikey', 'key_b'), 'value_b')
    })

    it('returns null for a key that does not exist in state file', () => {
      saveSessionState('test-missing-key', 'existing_key', 'some_value')
      assert.strictEqual(loadSessionState('test-missing-key', 'nonexistent_key'), null)
    })

    it('isolates state between sessions (the core property)', () => {
      saveSessionState('session-A', 'last_review_snapshot', 'msg-from-A')
      saveSessionState('session-B', 'last_review_snapshot', 'msg-from-B')

      assert.strictEqual(loadSessionState('session-A', 'last_review_snapshot'), 'msg-from-A')
      assert.strictEqual(loadSessionState('session-B', 'last_review_snapshot'), 'msg-from-B')
    })

    it('does not write to prove_it.local.json', () => {
      const projectTmp = path.join(os.tmpdir(), 'prove_it_local_check_' + Date.now())
      fs.mkdirSync(path.join(projectTmp, '.claude'), { recursive: true })
      const localCfgPath = path.join(projectTmp, '.claude', 'prove_it.local.json')

      saveSessionState('test-no-local', 'last_review_snapshot', 'msg-xyz')

      assert.strictEqual(fs.existsSync(localCfgPath), false,
        'saveSessionState should not create prove_it.local.json')
      assert.strictEqual(loadSessionState('test-no-local', 'last_review_snapshot'), 'msg-xyz')

      fs.rmSync(projectTmp, { recursive: true, force: true })
    })
  })

  describe('logReview', () => {
    it('creates a JSONL file named after the session', () => {
      logReview(SESSION_ID, '/project', 'done', 'pass', 'Tests passed')
      const logFile = path.join(tmpDir, 'prove_it', 'sessions', `${SESSION_ID}.jsonl`)
      assert.strictEqual(fs.existsSync(logFile), true, `Log file should exist at ${logFile}`)
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
      assert.strictEqual(typeof entry.at, 'number', 'at should be a timestamp')
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

    it('writes to project-level file when sessionId is null', () => {
      logReview(null, '/project', 'done', 'pass', 'OK')
      const expectedFile = path.join(tmpDir, 'prove_it', 'sessions', projectLogName('/project'))
      assert.strictEqual(fs.existsSync(expectedFile), true,
        `Project-level log file should exist at ${expectedFile}`)
      const entry = JSON.parse(fs.readFileSync(expectedFile, 'utf8').trim())
      assert.strictEqual(entry.sessionId, null)
      assert.strictEqual(entry.projectDir, '/project')
      assert.strictEqual(entry.status, 'pass')
    })

    it('uses _ prefix for project-level log files', () => {
      const name = projectLogName('/some/project')
      assert.ok(name.startsWith('_project_'),
        `Project log name should start with _project_, got: ${name}`)
      assert.ok(name.endsWith('.jsonl'),
        `Project log name should end with .jsonl, got: ${name}`)
    })

    it('produces deterministic project log names', () => {
      assert.strictEqual(projectLogName('/project'), projectLogName('/project'))
      assert.notStrictEqual(projectLogName('/project-a'), projectLogName('/project-b'))
    })

    it('logs FAIL with reason', () => {
      logReview('test-session-456', '/another/project', 'coverage', 'FAIL', 'Missing tests for new function')
      const logFile = path.join(tmpDir, 'prove_it', 'sessions', 'test-session-456.jsonl')
      assert.strictEqual(fs.existsSync(logFile), true, 'Log file should be created')
      const lastEntry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').pop())
      assert.strictEqual(lastEntry.reviewer, 'coverage')
      assert.strictEqual(lastEntry.status, 'FAIL')
      assert.strictEqual(lastEntry.reason, 'Missing tests for new function')
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

      fs.writeFileSync(path.join(projectDir, 'hello.js'), 'console.log("hello world");\n')

      const fileHistoryDir = path.join(tmpDir, '.claude', 'file-history', SESSION_ID)
      fs.mkdirSync(fileHistoryDir, { recursive: true })
      fs.writeFileSync(path.join(fileHistoryDir, 'hello.js.bak'), 'console.log("hello");\n')

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
      assert.strictEqual(diffs[0].diff.includes('hello world'), true, 'Diff should show the new content')
    })
  })

  describe('generateUnifiedDiff', () => {
    const { generateUnifiedDiff } = require('../lib/session')

    it('returns null when content is identical', () => {
      assert.strictEqual(generateUnifiedDiff('file.js', 'hello\n', 'hello\n'), null)
    })

    it('shows a single-line change', () => {
      const diff = generateUnifiedDiff('file.js', 'hello\n', 'world\n')
      assert.strictEqual(diff.includes('--- a/file.js'), true)
      assert.strictEqual(diff.includes('+++ b/file.js'), true)
      assert.strictEqual(diff.includes('-hello'), true)
      assert.strictEqual(diff.includes('+world'), true)
    })

    it('shows added lines', () => {
      const diff = generateUnifiedDiff('file.js', 'a\nb\n', 'a\nb\nc\n')
      assert.strictEqual(diff.includes('+c'), true)
      assert.strictEqual(diff.includes('-c'), false)
    })

    it('shows removed lines', () => {
      const diff = generateUnifiedDiff('file.js', 'a\nb\nc\n', 'a\nb\n')
      assert.strictEqual(diff.includes('-c'), true)
      assert.strictEqual(diff.includes('+c'), false)
    })

    it('handles empty old content (new file)', () => {
      const diff = generateUnifiedDiff('new.js', '', 'line1\nline2\n')
      assert.strictEqual(diff.includes('+line1'), true)
      assert.strictEqual(diff.includes('+line2'), true)
    })

    it('handles empty new content (deleted file)', () => {
      const diff = generateUnifiedDiff('old.js', 'line1\nline2\n', '')
      assert.strictEqual(diff.includes('-line1'), true)
      assert.strictEqual(diff.includes('-line2'), true)
    })

    it('includes context lines around changes', () => {
      const old = 'a\nb\nc\nd\ne\n'
      const nu = 'a\nb\nX\nd\ne\n'
      const diff = generateUnifiedDiff('file.js', old, nu)

      assert.strictEqual(
        diff.includes(' a') || diff.includes(' b'),
        true,
        'Should include context before change'
      )
      assert.strictEqual(diff.includes('-c'), true)
      assert.strictEqual(diff.includes('+X'), true)
    })

    it('handles multiple hunks', () => {
      const old = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n'
      const nu = '1\nX\n3\n4\n5\n6\n7\n8\nY\n10\n'
      const diff = generateUnifiedDiff('file.js', old, nu)
      assert.strictEqual(diff.includes('-2'), true)
      assert.strictEqual(diff.includes('+X'), true)
      assert.strictEqual(diff.includes('-9'), true)
      assert.strictEqual(diff.includes('+Y'), true)
    })

    it('hunk headers include line counts', () => {
      const diff = generateUnifiedDiff('file.js', 'a\nb\nc\n', 'a\nb\nX\n')
      assert.ok(diff, 'Should produce a diff')
      const hunkHeader = diff.split('\n').find((l) => l.startsWith('@@'))
      assert.ok(hunkHeader, 'Should have a hunk header')
      assert.match(hunkHeader, /@@ -\d+,\d+ \+\d+,\d+ @@/, 'Hunk header should include counts')
    })

    it('line numbers diverge on add', () => {
      const old = 'a\nb\nc\n'
      const nu = 'a\nb\nINSERTED\nc\n'
      const diff = generateUnifiedDiff('file.js', old, nu)

      assert.ok(diff, 'Should produce a diff')
      assert.strictEqual(diff.includes('+INSERTED'), true, 'Should show added line')
    })

    it('line numbers diverge on delete', () => {
      const old = 'a\nb\nc\nd\n'
      const nu = 'a\nb\nd\n'
      const diff = generateUnifiedDiff('file.js', old, nu)

      assert.ok(diff, 'Should produce a diff')
      assert.strictEqual(diff.includes('-c'), true, 'Should show removed line')
    })
  })

  describe('session_id passed as parameter via subprocess', () => {
    const { spawnSync } = require('child_process')

    it('session functions write to correct files when given session_id', () => {
      const probeScript = path.join(tmpDir, 'session_probe.js')
      const proveItDir = path.join(tmpDir, 'prove_it_state')
      const sharedPath = path.join(__dirname, '..', 'lib', 'shared.js')

      fs.writeFileSync(probeScript, [
        `const { saveSessionState, logReview } = require(${JSON.stringify(sharedPath)});`,
        'const input = JSON.parse(require("fs").readFileSync(0, "utf8"));',
        'const sessionId = input.session_id || null;',
        'saveSessionState(sessionId, "probe_key", "probe_value");',
        'logReview(sessionId, "/test", "probe", "pass", "propagation test");'
      ].join('\n'))

      const result = spawnSync('node', [probeScript], {
        input: JSON.stringify({ session_id: 'test-session-xyz789' }),
        encoding: 'utf8',
        env: { ...process.env, PROVE_IT_DIR: proveItDir }
      })

      assert.strictEqual(result.status, 0, `Probe script should exit 0: ${result.stderr}`)

      const stateFile = path.join(proveItDir, 'sessions', 'test-session-xyz789.json')
      assert.strictEqual(fs.existsSync(stateFile), true, `State file should exist at ${stateFile}`)
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      assert.strictEqual(state.probe_key, 'probe_value')

      const logFile = path.join(proveItDir, 'sessions', 'test-session-xyz789.jsonl')
      assert.strictEqual(fs.existsSync(logFile), true, `Log file should exist at ${logFile}`)
      const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim())
      assert.strictEqual(entry.reviewer, 'probe')
      assert.strictEqual(entry.status, 'pass')
      assert.strictEqual(entry.sessionId, 'test-session-xyz789')
    })

    it('without session_id, logReview writes to project-level file', () => {
      const probeScript = path.join(tmpDir, 'session_probe_no_id.js')
      const proveItDir = path.join(tmpDir, 'prove_it_no_id')
      const sharedPath = path.join(__dirname, '..', 'lib', 'shared.js')

      fs.writeFileSync(probeScript, [
        `const { saveSessionState, loadSessionState, logReview, projectLogName } = require(${JSON.stringify(sharedPath)});`,
        'const input = JSON.parse(require("fs").readFileSync(0, "utf8"));',
        'const sessionId = input.session_id || null;',
        'saveSessionState(sessionId, "key", "value");',
        'const result = loadSessionState(sessionId, "key");',
        'logReview(sessionId, "/test", "probe", "pass", "no session");',
        'process.stdout.write(JSON.stringify({ loadResult: result, logName: projectLogName("/test") }));'
      ].join('\n'))

      const result = spawnSync('node', [probeScript], {
        input: JSON.stringify({}),
        encoding: 'utf8',
        env: { ...process.env, PROVE_IT_DIR: proveItDir }
      })

      assert.strictEqual(result.status, 0, `Probe script should exit 0: ${result.stderr}`)
      const output = JSON.parse(result.stdout)
      assert.strictEqual(output.loadResult, null)

      // logReview now writes to a project-level file instead of skipping
      const projectLog = path.join(proveItDir, 'sessions', output.logName)
      assert.strictEqual(fs.existsSync(projectLog), true,
        `Project-level log should exist at ${projectLog}`)
      const entry = JSON.parse(fs.readFileSync(projectLog, 'utf8').trim())
      assert.strictEqual(entry.sessionId, null)
      assert.strictEqual(entry.projectDir, '/test')
    })
  })

  describe('recordSessionBaseline', () => {
    it('writes session file with git info', () => {
      // Create a git repo in tmpDir
      const { spawnSync: spawn } = require('child_process')
      const projectDir = path.join(tmpDir, 'project')
      fs.mkdirSync(projectDir, { recursive: true })
      spawn('git', ['init'], { cwd: projectDir })
      spawn('git', ['config', 'user.email', 'test@test.com'], { cwd: projectDir })
      spawn('git', ['config', 'user.name', 'Test'], { cwd: projectDir })
      fs.writeFileSync(path.join(projectDir, 'file.js'), 'hello\n')
      spawn('git', ['add', '.'], { cwd: projectDir })
      spawn('git', ['commit', '-m', 'init'], { cwd: projectDir })

      recordSessionBaseline('test-baseline-123', projectDir)

      const sessionFile = path.join(tmpDir, 'prove_it', 'sessions', 'test-baseline-123.json')
      assert.strictEqual(fs.existsSync(sessionFile), true,
        `Session file should exist at ${sessionFile}`)
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
      assert.strictEqual(data.session_id, 'test-baseline-123')
      assert.strictEqual(data.project_dir, projectDir)
      assert.ok(data.git.head, 'Should have git HEAD')
      assert.ok(data.started_at, 'Should have started_at timestamp')
    })

    it('skips when sessionId is null', () => {
      recordSessionBaseline(null, '/tmp/whatever')
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      // Directory shouldn't even be created
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir)
        assert.strictEqual(files.length, 0, 'No session files should be created')
      }
    })

    it('is idempotent (skips if session file already exists)', () => {
      const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true })
      const sessionFile = path.join(sessionsDir, 'test-idem.json')
      fs.writeFileSync(sessionFile, '{"existing": true}', 'utf8')

      recordSessionBaseline('test-idem', '/tmp/whatever')

      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
      assert.strictEqual(data.existing, true,
        'Should not overwrite existing session file')
    })
  })
})
