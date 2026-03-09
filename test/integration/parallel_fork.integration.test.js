const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { fork } = require('node:child_process')

const { forkParallelTask, awaitParallelBatch } = require('../../lib/dispatcher/claude')

describe('forkParallelTask – subprocess', () => {
  let tmpDir
  let origProveItDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_parallel_'))
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

  it('spawns child and returns handle with child, resultPath, task', () => {
    const sessionId = 'test-parallel-fork'
    const task = { name: 'par-task', type: 'script', parallel: true, command: 'echo hi' }
    const context = {
      rootDir: tmpDir,
      projectDir: tmpDir,
      sessionId,
      hookEvent: 'Stop',
      localCfgPath: null,
      sources: ['**/*.js'],
      fileEditingTools: ['Edit'],
      configEnv: null,
      configModel: null,
      maxChars: 12000,
      testOutput: ''
    }

    const handle = forkParallelTask(task, context)
    assert.ok(handle, 'Should return a handle')
    assert.ok(handle.child, 'Should have a child process')
    assert.ok(handle.resultPath, 'Should have a resultPath')
    assert.strictEqual(handle.task.name, 'par-task')

    // Clean up: kill the child
    try { handle.child.kill() } catch {}
  })
})

describe('awaitParallelBatch – subprocess', () => {
  let tmpDir
  let origProveItDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_await_'))
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

  it('collects results from completed parallel children', async () => {
    const sessionId = 'test-parallel-await'
    const task = { name: 'par-echo', type: 'script', parallel: true, command: 'echo hi' }
    const context = {
      rootDir: tmpDir,
      projectDir: tmpDir,
      sessionId,
      hookEvent: 'Stop',
      localCfgPath: null,
      sources: ['**/*.js'],
      fileEditingTools: ['Edit'],
      configEnv: null,
      configModel: null,
      maxChars: 12000,
      testOutput: ''
    }

    const handle = forkParallelTask(task, context)
    assert.ok(handle, 'Should fork successfully')

    const results = await awaitParallelBatch([handle])
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].task.name, 'par-echo')
    assert.strictEqual(results[0].result.pass, true)
  })

  it('returns skip result when child crashes without writing result', async () => {
    const resultPath = path.join(tmpDir, 'nonexistent.json')
    const task = { name: 'bad-task', type: 'script', command: 'false' }

    const child = fork(path.join(__dirname, '..', '..', 'lib', 'async_worker.js'), ['/nonexistent/context.json'], {
      stdio: 'ignore',
      env: { ...process.env, PROVE_IT_DISABLED: '1' }
    })

    const results = await awaitParallelBatch([{ child, resultPath, task }])
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].result.skipped, true)
  })
})
