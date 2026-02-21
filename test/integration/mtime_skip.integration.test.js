const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  createTestScript,
  createFastTestScript,
  writeConfig,
  makeConfig,
  isolatedEnv
} = require('./hook-harness')

/**
 * Mtime-based test skip optimization.
 *
 * The script check runner tracks run timestamps in prove_it/config.local.json and
 * compares against file mtimes. If tests passed more recently than any tracked
 * file changed, the hook skips re-running. Only passes are cached — failures
 * always re-run so transient issues don't get permanently locked in.
 */

function stopHooks () {
  return [
    {
      type: 'claude',
      event: 'Stop',
      tasks: [
        { name: 'fast-tests', type: 'script', command: './script/test_fast' }
      ]
    }
  ]
}

function commitHooks () {
  return [
    {
      type: 'claude',
      event: 'PreToolUse',
      matcher: 'Bash',
      triggers: ['(^|\\s)git\\s+commit\\b'],
      tasks: [
        { name: 'full-tests', type: 'script', command: './script/test' }
      ]
    }
  ]
}

describe('Mtime-based test skip', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_mtime_')
    initGitRepo(tmpDir)

    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })

    // Create both test scripts (passing)
    createFastTestScript(tmpDir, true)
    createTestScript(tmpDir, true)
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  function writeRunData (runKey, data) {
    const localCfgPath = path.join(tmpDir, '.claude', 'prove_it/config.local.json')
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(localCfgPath, 'utf8')) } catch {}
    if (!existing.runs) existing.runs = {}
    existing.runs[runKey] = data
    fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
    fs.writeFileSync(localCfgPath, JSON.stringify(existing, null, 2), 'utf8')
  }

  function setFileMtimesBefore (runTime) {
    const before = new Date(runTime - 2000)
    const tracked = spawnSync('git', ['ls-files'], { cwd: tmpDir, encoding: 'utf8' })
    for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
      fs.utimesSync(path.join(tmpDir, file), before, before)
    }
  }

  it('stop hook skips fast tests when code unchanged since last pass', () => {
    writeConfig(tmpDir, makeConfig(stopHooks()))
    const runTime = Date.now()
    writeRunData('fast-tests', { at: runTime, pass: true })
    setFileMtimesBefore(runTime)

    const result = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: 'test-mtime-skip',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce JSON output')
    assert.strictEqual(result.output.decision, 'approve',
      'Stop should approve (cached pass, no code changes)')
  })

  it('commit hook skips full tests when code unchanged since last pass', () => {
    writeConfig(tmpDir, makeConfig(commitHooks()))
    const runTime = Date.now()
    writeRunData('full-tests', { at: runTime, pass: true })
    setFileMtimesBefore(runTime)

    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(result.exitCode, 0)
    // Tests skipped (cached pass) → allow
    if (result.output) {
      assert.notStrictEqual(
        result.output.hookSpecificOutput?.permissionDecision,
        'deny',
        'Should not deny when cached pass is fresh and no code changes'
      )
    }
  })

  it('stop hook re-runs on cached failure instead of caching it', () => {
    writeConfig(tmpDir, makeConfig(stopHooks()))
    const runTime = Date.now()
    writeRunData('fast-tests', { at: runTime, pass: false })
    setFileMtimesBefore(runTime)

    // Test scripts are passing (exit 0), so re-running should approve
    const result = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: 'test-mtime-fail',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce JSON output')
    assert.strictEqual(result.output.decision, 'approve',
      'Stop should re-run and approve (not cache the failure)')
  })

  it('commit hook re-runs on cached failure instead of caching it', () => {
    writeConfig(tmpDir, makeConfig(commitHooks()))
    const runTime = Date.now()
    writeRunData('full-tests', { at: runTime, pass: false })
    setFileMtimesBefore(runTime)

    // Test scripts are passing (exit 0), so re-running should allow
    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(result.exitCode, 0)
    // Re-ran and passed → should not deny
    if (result.output) {
      assert.notStrictEqual(
        result.output.hookSpecificOutput?.permissionDecision,
        'deny',
        'Should not deny when re-run passes'
      )
    }
  })

  it('stop hook re-runs when code changed after last run', () => {
    writeConfig(tmpDir, makeConfig(stopHooks()))
    const pastTime = Date.now() - 10000
    writeRunData('fast-tests', { at: pastTime, pass: true })

    // Touch a tracked file to NOW (after last run)
    createFile(tmpDir, 'src/app.js', '// changed\n')
    spawnSync('git', ['add', 'src/app.js'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'add src'], { cwd: tmpDir })

    const result = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: 'test-mtime-rerun',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce JSON output')
    // Tests actually run (passing script/test_fast) → approve
    assert.strictEqual(result.output.decision, 'approve',
      'Stop should re-run and approve when code changed after cached pass')
  })
})
