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

describe('async task lifecycle', () => {
  let tmpDir, projectDir, env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_async_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    env = isolatedEnv(tmpDir)
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  it('spawns async task on Stop, result file appears, then harvests on next Stop', () => {
    // Create a fast script task (sync) and an async script task
    const asyncScript = path.join(projectDir, 'script', 'slow-check')
    createFile(projectDir, 'script/slow-check', '#!/usr/bin/env bash\necho "async check passed"\nexit 0\n')
    makeExecutable(asyncScript)

    const syncScript = path.join(projectDir, 'script', 'fast-check')
    createFile(projectDir, 'script/fast-check', '#!/usr/bin/env bash\nexit 0\n')
    makeExecutable(syncScript)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'fast-check', type: 'script', command: './script/fast-check' },
          { name: 'slow-check', type: 'script', async: true, command: './script/slow-check' }
        ]
      }
    ]))

    const sessionId = 'test-async-' + Date.now()

    // First Stop: spawns the async task, sync task runs normally
    const r1 = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r1.exitCode, 0, `First Stop should pass: ${r1.stderr}`)

    // Check that the async result file eventually appears
    const asyncDir = path.join(env.PROVE_IT_DIR, 'sessions', sessionId, 'async')
    // Wait for the async worker to complete (it's a detached child)
    let found = false
    for (let i = 0; i < 50; i++) {
      const Atomics = globalThis.Atomics
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, 100) // sleep 100ms
      try {
        const files = fs.readdirSync(asyncDir)
        if (files.some(f => f === 'slow-check.json')) {
          found = true
          break
        }
      } catch {}
    }
    assert.ok(found, 'Async result file should appear within 5 seconds')

    // Verify the result file content
    const resultPath = path.join(asyncDir, 'slow-check.json')
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    assert.strictEqual(result.taskName, 'slow-check')
    assert.strictEqual(result.result.pass, true)
    assert.ok(result.task.async === true)

    // Second Stop: harvests the async result
    const r2 = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r2.exitCode, 0, `Second Stop should pass: ${r2.stderr}`)

    // Result file should be consumed (deleted)
    assert.ok(!fs.existsSync(resultPath), 'Result file should be deleted after harvest')
  })

  it('async failure blocks on next Stop', () => {
    const asyncScript = path.join(projectDir, 'script', 'failing-check')
    createFile(projectDir, 'script/failing-check', '#!/usr/bin/env bash\necho "FAIL: something bad" >&2\nexit 1\n')
    makeExecutable(asyncScript)

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'failing-check', type: 'script', async: true, command: './script/failing-check' }
        ]
      }
    ]))

    const sessionId = 'test-async-fail-' + Date.now()

    // First Stop: spawns the async task
    invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    // Wait for result
    const asyncDir = path.join(env.PROVE_IT_DIR, 'sessions', sessionId, 'async')
    for (let i = 0; i < 50; i++) {
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, 100)
      try {
        const files = fs.readdirSync(asyncDir)
        if (files.some(f => f === 'failing-check.json')) break
      } catch {}
    }

    // Second Stop: should block because async task failed
    const r2 = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r2.exitCode, 0)
    assert.ok(r2.output, 'Should have JSON output')
    assert.strictEqual(r2.output.decision, 'block',
      `Should block on async failure, got: ${JSON.stringify(r2.output)}`)
    assert.ok(r2.stdout.includes('(async)'), 'Failure message should mention async')
  })

  it('SessionStart startup cleans stale async results', () => {
    const sessionId = 'test-async-clean-' + Date.now()
    const asyncDir = path.join(env.PROVE_IT_DIR, 'sessions', sessionId, 'async')
    fs.mkdirSync(asyncDir, { recursive: true })
    fs.writeFileSync(path.join(asyncDir, 'stale.json'), '{}')

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'SessionStart',
        tasks: [
          { name: 'briefing', type: 'script', command: 'echo ok' }
        ]
      }
    ]))

    invokeHook('claude:SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup'
    }, { projectDir, env })

    assert.ok(!fs.existsSync(asyncDir), 'Async dir should be cleaned on startup')
  })

  it('second async failure survives when first blocks', () => {
    // Two async tasks, both failing
    for (const name of ['check-a', 'check-b']) {
      const scriptPath = path.join(projectDir, 'script', name)
      createFile(projectDir, `script/${name}`, `#!/usr/bin/env bash\necho "${name} failed" >&2\nexit 1\n`)
      makeExecutable(scriptPath)
    }

    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'check-a', type: 'script', async: true, command: './script/check-a' },
          { name: 'check-b', type: 'script', async: true, command: './script/check-b' }
        ]
      }
    ]))

    const sessionId = 'test-async-multi-fail-' + Date.now()
    const asyncDir = path.join(env.PROVE_IT_DIR, 'sessions', sessionId, 'async')

    // First Stop: spawns both async tasks
    invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    // Wait for both results
    for (let i = 0; i < 50; i++) {
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, 100)
      try {
        const files = fs.readdirSync(asyncDir).filter(f => f.endsWith('.json') && !f.endsWith('.context.json'))
        if (files.length >= 2) break
      } catch {}
    }

    // Second Stop: blocks on first failure
    const r2 = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r2.output.decision, 'block')

    // One file should be consumed, the other should survive for next harvest
    const remaining = fs.readdirSync(asyncDir).filter(f => f.endsWith('.json') && !f.endsWith('.context.json'))
    assert.strictEqual(remaining.length, 1,
      `Expected 1 surviving result file, got ${remaining.length}: ${remaining.join(', ')}`)

    // Third Stop: blocks on the surviving failure
    const r3 = invokeHook('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId
    }, { projectDir, env })

    assert.strictEqual(r3.output.decision, 'block', 'Third Stop should block on second failure')

    // Now both are consumed
    const finalRemaining = fs.readdirSync(asyncDir).filter(f => f.endsWith('.json') && !f.endsWith('.context.json'))
    assert.strictEqual(finalRemaining.length, 0, 'All result files should be consumed')
  })

  it('async: true on SessionStart tasks is ignored (runs synchronously)', () => {
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'SessionStart',
        tasks: [
          { name: 'sync-briefing', type: 'script', command: 'echo hello', async: true }
        ]
      }
    ]))

    const sessionId = 'test-async-ss-' + Date.now()
    const r = invokeHook('claude:SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup'
    }, { projectDir, env })

    assert.strictEqual(r.exitCode, 0)
    // Should not have created an async dir (task ran synchronously)
    const asyncDir = path.join(env.PROVE_IT_DIR, 'sessions', sessionId, 'async')
    assert.ok(!fs.existsSync(asyncDir), 'No async dir should be created for SessionStart tasks')
  })
})
