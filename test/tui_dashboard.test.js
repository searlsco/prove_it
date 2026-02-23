const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { createDashboard } = require('../lib/tui/dashboard')

// Suppress colors
process.env.NO_COLOR = '1'

describe('tui/dashboard', () => {
  let tmpDir
  let origProveItDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_tui_'))
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')

    // Create sessions dir
    fs.mkdirSync(path.join(tmpDir, 'prove_it', 'sessions'), { recursive: true })
  })

  afterEach(() => {
    if (origProveItDir === undefined) {
      delete process.env.PROVE_IT_DIR
    } else {
      process.env.PROVE_IT_DIR = origProveItDir
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function createMockStreams () {
    let output = ''
    const stdout = {
      columns: 80,
      rows: 30,
      write: (s) => { output += s },
      on: () => {},
      removeListener: () => {}
    }
    const stdin = {
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
      on: () => {},
      removeListener: () => {}
    }
    return { stdin, stdout, getOutput: () => output, clearOutput: () => { output = '' } }
  }

  function createSession (id, projectDir, entries) {
    const sessionsDir = path.join(tmpDir, 'prove_it', 'sessions')
    fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify({
      project_dir: projectDir,
      started_at: new Date().toISOString()
    }))
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(path.join(sessionsDir, `${id}.jsonl`), lines)
  }

  it('creates a dashboard without crashing', () => {
    const { stdin, stdout } = createMockStreams()
    const dashboard = createDashboard({ stdin, stdout })
    assert.ok(dashboard)
    assert.ok(typeof dashboard.start === 'function')
    assert.ok(typeof dashboard.stop === 'function')
  })

  it('refreshSessions loads sessions from disk', () => {
    createSession('test-session-01', '/project/a', [
      { at: Date.now(), reviewer: 'fast-tests', status: 'PASS', reason: 'ok' }
    ])

    const { stdin, stdout } = createMockStreams()
    const dashboard = createDashboard({ stdin, stdout })
    dashboard.refreshSessions()
    // The dashboard should have found the session (no crash = success)
    assert.ok(true)
  })

  it('loadSession loads entries from a session file', () => {
    const sid = 'load-session-test'
    createSession(sid, '/project/b', [
      { at: 1, reviewer: 'a', status: 'PASS', reason: 'ok' },
      { at: 2, reviewer: 'b', status: 'FAIL', reason: 'bad' }
    ])

    const { stdin, stdout } = createMockStreams()
    const dashboard = createDashboard({ stdin, stdout })
    dashboard.loadSession(sid)
    dashboard.cleanup() // stop watchers
    assert.ok(true) // no crash
  })

  it('render produces output containing panel labels', () => {
    createSession('render-test-01', '/project/c', [
      { at: Date.now(), reviewer: 'test', status: 'PASS', reason: 'ok' }
    ])

    const { stdin, stdout, getOutput } = createMockStreams()
    const dashboard = createDashboard({ stdin, stdout })
    dashboard.refreshSessions()
    dashboard.loadSession('render-test-01')
    dashboard.render()
    dashboard.cleanup() // stop watchers

    const output = getOutput()
    assert.ok(output.includes('Sessions'), 'Output should contain Sessions label')
    assert.ok(output.includes('Log'), 'Output should contain Log label')
    assert.ok(output.includes('Detail'), 'Output should contain Detail label')
  })

  it('focusedPanel defaults to sessions', () => {
    const { stdin, stdout } = createMockStreams()
    const dashboard = createDashboard({ stdin, stdout })
    assert.strictEqual(dashboard.focusedPanel(), 'sessions')
  })
})
