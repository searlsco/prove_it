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
  makeExecutable
} = require('./hook-harness')

/**
 * GAP 1: Mtime-based test skip optimization.
 *
 * README promise: "won't waste daylight re-running your tests"
 *
 * The hooks track run timestamps in prove_it.local.json and compare against
 * file mtimes. If tests passed more recently than any tracked file changed,
 * the hook skips re-running and uses the cached result.
 */

describe('Mtime-based test skip', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_mtime_')
    initGitRepo(tmpDir)

    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })

    // Create both test scripts (passing)
    createFile(tmpDir, 'script/test_fast', '#!/bin/bash\nexit 0\n')
    makeExecutable(path.join(tmpDir, 'script', 'test_fast'))
    createTestScript(tmpDir, true)
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  function isolatedEnv () {
    return {
      HOME: tmpDir,
      PROVE_IT_DIR: path.join(tmpDir, '.prove_it_test')
    }
  }

  function writeRunData (runKey, data) {
    const localCfgPath = path.join(tmpDir, '.claude', 'prove_it.local.json')
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(localCfgPath, 'utf8')) } catch {}
    if (!existing.runs) existing.runs = {}
    existing.runs[runKey] = data
    fs.mkdirSync(path.dirname(localCfgPath), { recursive: true })
    fs.writeFileSync(localCfgPath, JSON.stringify(existing, null, 2), 'utf8')
  }

  it('stop hook skips fast tests when code unchanged since last pass', () => {
    const runTime = Date.now()
    writeRunData('test_fast', { at: runTime, pass: true, head: 'abc123' })

    // Set file mtimes to 2 seconds before run time
    const before = new Date(runTime - 2000)
    const tracked = spawnSync('git', ['ls-files'], { cwd: tmpDir, encoding: 'utf8' })
    for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
      fs.utimesSync(path.join(tmpDir, file), before, before)
    }

    const result = invokeHook('prove_it_stop.js', {
      hook_event_name: 'Stop',
      session_id: 'test-mtime-skip',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv() })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce JSON output')
    assert.strictEqual(result.output.decision, 'approve',
      'Stop should approve (cached pass, no code changes)')
  })

  it('done hook skips full tests when code unchanged since last pass', () => {
    const runTime = Date.now()
    writeRunData('test_full', { at: runTime, pass: true, head: 'abc123' })

    const before = new Date(runTime - 2000)
    const tracked = spawnSync('git', ['ls-files'], { cwd: tmpDir, encoding: 'utf8' })
    for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
      fs.utimesSync(path.join(tmpDir, file), before, before)
    }

    const result = invokeHook('prove_it_done.js', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv() })

    assert.strictEqual(result.exitCode, 0)
    // Tests skipped but reviewer still runs (no staged changes = PASS)
    // Output may be null (reviewer not enabled in defaults without claude binary)
    // or contain allow. Either way, not a deny.
    if (result.output) {
      assert.notStrictEqual(
        result.output.hookSpecificOutput?.permissionDecision,
        'deny',
        'Done hook should not deny when cached pass is fresh and no staged changes'
      )
    }
  })

  it('done hook runs reviewer even when tests are mtime-skipped', () => {
    const runTime = Date.now()
    writeRunData('test_full', { at: runTime, pass: true, head: 'abc123' })

    const before = new Date(runTime - 2000)
    const tracked = spawnSync('git', ['ls-files'], { cwd: tmpDir, encoding: 'utf8' })
    for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
      fs.utimesSync(path.join(tmpDir, file), before, before)
    }

    // Create a mock reviewer that FAILs
    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    createFile(tmpDir, 'fail_reviewer.sh', '#!/bin/bash\necho "FAIL: untested code"\n')
    makeExecutable(reviewerPath)

    createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
      hooks: {
        done: {
          reviewer: {
            enabled: true,
            command: reviewerPath
          }
        }
      }
    }))

    // Stage a change so reviewer has something to look at
    createFile(tmpDir, 'src/new.js', 'function untested() {}\n')
    spawnSync('git', ['add', 'src/new.js'], { cwd: tmpDir })

    const result = invokeHook('prove_it_done.js', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "add untested"' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv() })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce output when reviewer fails')
    assert.strictEqual(
      result.output.hookSpecificOutput.permissionDecision,
      'deny',
      'Done hook should deny when reviewer fails, even with mtime-skipped tests'
    )
    assert.ok(
      result.output.hookSpecificOutput.permissionDecisionReason.includes('untested code'),
      'Denial reason should include reviewer feedback'
    )
  })

  it('stop hook blocks on cached failure without re-running', () => {
    const runTime = Date.now()
    writeRunData('test_fast', { at: runTime, pass: false, head: 'abc123' })

    const before = new Date(runTime - 2000)
    const tracked = spawnSync('git', ['ls-files'], { cwd: tmpDir, encoding: 'utf8' })
    for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
      fs.utimesSync(path.join(tmpDir, file), before, before)
    }

    const result = invokeHook('prove_it_stop.js', {
      hook_event_name: 'Stop',
      session_id: 'test-mtime-fail',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv() })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce JSON output')
    assert.strictEqual(result.output.decision, 'block',
      'Stop should block on cached failure')
    assert.ok(result.output.reason.includes('Tests failed and no code has changed'),
      `Reason should mention cached failure, got: ${result.output.reason}`)
  })

  it('done hook blocks on cached failure without re-running', () => {
    const runTime = Date.now()
    writeRunData('test_full', { at: runTime, pass: false, head: 'abc123' })

    const before = new Date(runTime - 2000)
    const tracked = spawnSync('git', ['ls-files'], { cwd: tmpDir, encoding: 'utf8' })
    for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
      fs.utimesSync(path.join(tmpDir, file), before, before)
    }

    const result = invokeHook('prove_it_done.js', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv() })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce JSON output')
    assert.strictEqual(
      result.output.hookSpecificOutput.permissionDecision,
      'deny',
      'Done hook should deny on cached failure'
    )
    assert.ok(
      result.output.hookSpecificOutput.permissionDecisionReason.includes('Tests failed and no code has changed'),
      'Should mention cached failure in reason'
    )
  })

  it('stop hook re-runs when code changed after last run', () => {
    const pastTime = Date.now() - 10000
    writeRunData('test_fast', { at: pastTime, pass: true, head: 'abc123' })

    // Touch a tracked file to NOW (after last run)
    createFile(tmpDir, 'src/app.js', '// changed\n')
    spawnSync('git', ['add', 'src/app.js'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'add src'], { cwd: tmpDir })

    const result = invokeHook('prove_it_stop.js', {
      hook_event_name: 'Stop',
      session_id: 'test-mtime-rerun',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv() })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce JSON output')
    // Tests actually run (passing script/test_fast) → approve
    assert.strictEqual(result.output.decision, 'approve',
      'Stop should re-run and approve when code changed after cached pass')
  })

  it('full test pass satisfies fast test skip', () => {
    const runTime = Date.now()
    // Only write full test run data (no fast test data)
    writeRunData('test_full', { at: runTime, pass: true, head: 'abc123' })

    const before = new Date(runTime - 2000)
    const tracked = spawnSync('git', ['ls-files'], { cwd: tmpDir, encoding: 'utf8' })
    for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
      fs.utimesSync(path.join(tmpDir, file), before, before)
    }

    const result = invokeHook('prove_it_stop.js', {
      hook_event_name: 'Stop',
      session_id: 'test-full-satisfies-fast',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv() })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Hook should produce JSON output')
    assert.strictEqual(result.output.decision, 'approve',
      'Full test pass should satisfy fast test requirement')
  })
})
