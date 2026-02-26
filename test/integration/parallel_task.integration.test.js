const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  writeConfig,
  makeConfig,
  isolatedEnv,
  createFile,
  makeExecutable
} = require('./hook-harness')

describe('parallel task execution', () => {
  let tmpDir, projectDir, env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_parallel_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    env = isolatedEnv(tmpDir)
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  it('two parallel tasks both pass — hook approves', () => {
    for (const name of ['check-a', 'check-b']) {
      const scriptPath = path.join(projectDir, 'script', name)
      createFile(projectDir, `script/${name}`, '#!/usr/bin/env bash\nexit 0\n')
      makeExecutable(scriptPath)
    }

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'check-a', type: 'script', parallel: true, command: './script/check-a' },
          { name: 'check-b', type: 'script', parallel: true, command: './script/check-b' }
        ]
      }
    ]))

    const sessionId = 'test-parallel-pass-' + Date.now()
    const r = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r.exitCode, 0, `Should pass: ${r.stderr}`)
    assert.ok(r.output, 'Should have JSON output')
    assert.notStrictEqual(r.output.decision, 'block', 'Should not block when parallel tasks pass')
  })

  it('two parallel tasks, one fails — hook blocks', () => {
    const passScript = path.join(projectDir, 'script', 'pass-check')
    createFile(projectDir, 'script/pass-check', '#!/usr/bin/env bash\nexit 0\n')
    makeExecutable(passScript)

    const failScript = path.join(projectDir, 'script', 'fail-check')
    createFile(projectDir, 'script/fail-check', '#!/usr/bin/env bash\necho "FAIL: something bad" >&2\nexit 1\n')
    makeExecutable(failScript)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'pass-check', type: 'script', parallel: true, command: './script/pass-check' },
          { name: 'fail-check', type: 'script', parallel: true, command: './script/fail-check' }
        ]
      }
    ]))

    const sessionId = 'test-parallel-fail-' + Date.now()
    const r = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r.exitCode, 0)
    assert.ok(r.output, 'Should have JSON output')
    assert.strictEqual(r.output.decision, 'block', 'Should block when a parallel task fails')
    assert.ok(r.stdout.includes('(parallel)'), 'Failure message should mention parallel')
  })

  it('mixed serial + parallel: serial gates, parallel runs concurrently', () => {
    // Serial task passes first, then parallel tasks run
    const serialScript = path.join(projectDir, 'script', 'serial-check')
    createFile(projectDir, 'script/serial-check', '#!/usr/bin/env bash\nexit 0\n')
    makeExecutable(serialScript)

    const parallelScript = path.join(projectDir, 'script', 'parallel-check')
    createFile(projectDir, 'script/parallel-check', '#!/usr/bin/env bash\nexit 0\n')
    makeExecutable(parallelScript)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'serial-check', type: 'script', command: './script/serial-check' },
          { name: 'parallel-check', type: 'script', parallel: true, command: './script/parallel-check' }
        ]
      }
    ]))

    const sessionId = 'test-parallel-mixed-' + Date.now()
    const r = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r.exitCode, 0, `Should pass: ${r.stderr}`)
    assert.notStrictEqual(r.output?.decision, 'block', 'Should not block when all tasks pass')
  })

  it('serial failure kills parallel children before they complete', () => {
    // Serial task fails — parallel task should be killed
    const failScript = path.join(projectDir, 'script', 'serial-fail')
    createFile(projectDir, 'script/serial-fail', '#!/usr/bin/env bash\necho "FAIL" >&2\nexit 1\n')
    makeExecutable(failScript)

    // Parallel task that sleeps — should be killed before it finishes
    const sleepScript = path.join(projectDir, 'script', 'slow-parallel')
    createFile(projectDir, 'script/slow-parallel', '#!/usr/bin/env bash\nsleep 30\nexit 0\n')
    makeExecutable(sleepScript)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'slow-parallel', type: 'script', parallel: true, command: './script/slow-parallel' },
          { name: 'serial-fail', type: 'script', command: './script/serial-fail' }
        ]
      }
    ]))

    const sessionId = 'test-parallel-serial-fail-' + Date.now()
    const r = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r.exitCode, 0)
    assert.strictEqual(r.output.decision, 'block', 'Should block on serial failure')
    assert.ok(r.stdout.includes('serial-fail'), 'Block message should reference the serial task')
  })

  it('two parallel tasks both fail — first blocks, second result is cleaned up (no orphan)', () => {
    for (const name of ['fail-a', 'fail-b']) {
      const scriptPath = path.join(projectDir, 'script', name)
      createFile(projectDir, `script/${name}`, `#!/usr/bin/env bash\necho "${name} failed" >&2\nexit 1\n`)
      makeExecutable(scriptPath)
    }

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fail-a', type: 'script', parallel: true, command: './script/fail-a' },
          { name: 'fail-b', type: 'script', parallel: true, command: './script/fail-b' }
        ]
      }
    ]))

    const sessionId = 'test-parallel-both-fail-' + Date.now()

    // First Stop: blocks on first parallel failure
    const r1 = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r1.output.decision, 'block', 'Should block on parallel failure')
    assert.ok(r1.stdout.includes('(parallel)'), 'Should mention parallel')

    // Verify no orphaned result files remain (would be harvested as "async" otherwise)
    const asyncDir = path.join(env.PROVE_IT_DIR, 'sessions', sessionId, 'async')
    let remaining = []
    try {
      remaining = fs.readdirSync(asyncDir).filter(f => f.endsWith('.json') && !f.endsWith('.context.json'))
    } catch {}
    assert.strictEqual(remaining.length, 0,
      `No orphaned result files should remain, got: ${remaining.join(', ')}`)
  })

  it('parallel: true on SessionStart is ignored (runs synchronously)', () => {
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'SessionStart',
        tasks: [
          { name: 'sync-task', type: 'script', command: 'echo hello', parallel: true }
        ]
      }
    ]))

    const sessionId = 'test-parallel-ss-' + Date.now()
    const r = invokeHook('claude:SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup'
    }, { projectDir, env })

    assert.strictEqual(r.exitCode, 0)
    // Should not have created an async dir (task ran synchronously)
    const asyncDir = path.join(env.PROVE_IT_DIR, 'sessions', sessionId, 'async')
    assert.ok(!fs.existsSync(asyncDir), 'No async dir should be created for SessionStart parallel tasks')
  })
})
