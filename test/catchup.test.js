const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const {
  SESSION_KEYS,
  loadSessionState,
  saveSessionState
} = require('../lib/session')
const { backchannelDir } = require('../lib/paths')

const CLI = path.join(__dirname, '..', 'cli.js')

function gitCmd (cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo (dir) {
  fs.mkdirSync(dir, { recursive: true })
  gitCmd(dir, ['init', '-q', '-b', 'main'])
  gitCmd(dir, ['config', 'user.email', 'test@example.com'])
  gitCmd(dir, ['config', 'user.name', 'Test'])
  gitCmd(dir, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(dir, 'README'), 'hi\n')
  gitCmd(dir, ['add', '.'])
  gitCmd(dir, ['commit', '-q', '-m', 'init'])
  return gitCmd(dir, ['rev-parse', 'HEAD']).stdout.trim()
}

function writeProjectConfig (projectDir, taskNames) {
  const cfgDir = path.join(projectDir, '.claude', 'prove_it')
  fs.mkdirSync(cfgDir, { recursive: true })
  const tasks = taskNames.map(name => ({
    name,
    type: 'script',
    command: 'true'
  }))
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({
      enabled: true,
      hooks: { claude: { Stop: tasks } }
    }, null, 2)
  )
}

describe('prove_it catchup command', () => {
  let tmpDir
  let projectDir
  let origProveItDir
  let origSessionId

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_catchup_'))
    projectDir = path.join(tmpDir, 'project')
    origProveItDir = process.env.PROVE_IT_DIR
    origSessionId = process.env.PROVE_IT_SESSION_ID
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it')
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    if (origSessionId === undefined) delete process.env.PROVE_IT_SESSION_ID
    else process.env.PROVE_IT_SESSION_ID = origSessionId
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function runCatchup (args, env = {}, cwd = projectDir) {
    return spawnSync(process.execPath, [CLI, 'catchup', ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...env },
      timeout: 10000
    })
  }

  it('errors when PROVE_IT_SESSION_ID is not set', () => {
    initRepo(projectDir)
    writeProjectConfig(projectDir, ['foo'])
    const r = runCatchup([], { PROVE_IT_SESSION_ID: '' })
    assert.notStrictEqual(r.status, 0)
    assert.ok(r.stderr.includes('PROVE_IT_SESSION_ID'),
      `Should mention env var, got: ${r.stderr}`)
  })

  it('no-args: advances baseline, clears per-task state, resets session HEAD', () => {
    const sessionId = 'catchup-test-noargs'
    initRepo(projectDir)
    writeProjectConfig(projectDir, ['foo', 'bar'])

    saveSessionState(sessionId, SESSION_KEYS.GIT, { is_repo: true, root: projectDir, head: 'stalehead', status_hash: 'x' })
    saveSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD, 'oldstop')
    saveSessionState(sessionId, SESSION_KEYS.LAST_REVIEW_SNAPSHOT, 'oldsnap')
    saveSessionState(sessionId, SESSION_KEYS.SUCCESSIVE_FAILURES, { foo: 5, bar: 3 })
    saveSessionState(sessionId, SESSION_KEYS.SUSPENDED, ['foo', 'bar'])

    const bcDir = backchannelDir(projectDir, sessionId, 'foo')
    fs.mkdirSync(bcDir, { recursive: true })
    fs.writeFileSync(path.join(bcDir, 'README.md'), 'appeal')

    const r = runCatchup([], { PROVE_IT_SESSION_ID: sessionId })
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)

    const newHead = gitCmd(projectDir, ['rev-parse', 'HEAD']).stdout.trim()
    const git = loadSessionState(sessionId, SESSION_KEYS.GIT)
    assert.strictEqual(git.head, newHead, 'GIT.head should advance to current HEAD')
    assert.strictEqual(loadSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD), null)
    assert.strictEqual(loadSessionState(sessionId, SESSION_KEYS.LAST_REVIEW_SNAPSHOT), null)

    const failures = loadSessionState(sessionId, SESSION_KEYS.SUCCESSIVE_FAILURES) || {}
    assert.strictEqual(failures.foo, 0, 'foo failures cleared')
    assert.strictEqual(failures.bar, 0, 'bar failures cleared')

    const suspended = loadSessionState(sessionId, SESSION_KEYS.SUSPENDED) || []
    assert.deepStrictEqual(suspended, [], 'suspended list emptied')

    assert.ok(!fs.existsSync(bcDir), 'backchannel dir removed')

    const refSha = gitCmd(projectDir, ['rev-parse', 'refs/worktree/prove_it/foo']).stdout.trim()
    assert.strictEqual(refSha, newHead, 'foo task ref points at HEAD')

    assert.ok(r.stdout.includes('session baseline advanced'), `expected baseline message, got: ${r.stdout}`)
  })

  it('single-task: only touches the named task; leaves session state alone', () => {
    const sessionId = 'catchup-test-single'
    initRepo(projectDir)
    writeProjectConfig(projectDir, ['foo', 'bar'])

    saveSessionState(sessionId, SESSION_KEYS.GIT, { is_repo: true, root: projectDir, head: 'stalehead', status_hash: 'x' })
    saveSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD, 'oldstop')
    saveSessionState(sessionId, SESSION_KEYS.SUCCESSIVE_FAILURES, { foo: 5, bar: 3 })
    saveSessionState(sessionId, SESSION_KEYS.SUSPENDED, ['foo', 'bar'])

    const r = runCatchup(['foo'], { PROVE_IT_SESSION_ID: sessionId })
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)

    // Session-wide state untouched
    const git = loadSessionState(sessionId, SESSION_KEYS.GIT)
    assert.strictEqual(git.head, 'stalehead', 'session GIT.head untouched')
    assert.strictEqual(loadSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD), 'oldstop')

    // foo cleared, bar untouched
    const failures = loadSessionState(sessionId, SESSION_KEYS.SUCCESSIVE_FAILURES) || {}
    assert.strictEqual(failures.foo, 0, 'foo failures cleared')
    assert.strictEqual(failures.bar, 3, 'bar failures untouched')

    const suspended = loadSessionState(sessionId, SESSION_KEYS.SUSPENDED) || []
    assert.deepStrictEqual(suspended, ['bar'], 'only foo removed from suspended')

    assert.ok(!r.stdout.includes('session baseline advanced'), 'should not log session baseline message for per-task form')
  })

  it('exits 1 with task list when given an unknown task name', () => {
    const sessionId = 'catchup-test-unknown'
    initRepo(projectDir)
    writeProjectConfig(projectDir, ['foo', 'bar'])

    const r = runCatchup(['nope'], { PROVE_IT_SESSION_ID: sessionId })
    assert.notStrictEqual(r.status, 0)
    assert.ok(r.stderr.includes("unknown task 'nope'"), `expected unknown task message, got: ${r.stderr}`)
    assert.ok(r.stderr.includes('foo'), 'should list available tasks')
    assert.ok(r.stderr.includes('bar'), 'should list available tasks')
  })

  it('non-git directory: still resets session state, skips ref work', () => {
    const sessionId = 'catchup-test-nogit'
    fs.mkdirSync(projectDir, { recursive: true })
    writeProjectConfig(projectDir, ['foo'])

    saveSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD, 'oldstop')
    saveSessionState(sessionId, SESSION_KEYS.SUCCESSIVE_FAILURES, { foo: 4 })

    const r = runCatchup([], { PROVE_IT_SESSION_ID: sessionId })
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)

    assert.strictEqual(loadSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD), null)
    const failures = loadSessionState(sessionId, SESSION_KEYS.SUCCESSIVE_FAILURES) || {}
    assert.strictEqual(failures.foo, 0)
    assert.ok(r.stdout.includes('not a git repository'), `expected non-git message, got: ${r.stdout}`)
  })
})
