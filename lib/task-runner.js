const { fork, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { ensureDir, sanitizeTaskName } = require('./io')
const { getAsyncDir } = require('./session')
const { advanceTaskRef, whenHasKey } = require('./git')
const { saveRunData } = require('./testing')

/**
 * Settle a task result—post-check bookkeeping shared by sync and async paths.
 *
 * @returns {{ blocked: boolean, message?: string }}
 */
function settleTaskResult (task, result, hookEvent, settlCtx, outputs, contextParts, systemMessages, additionalContextParts) {
  const { rootDir, sources, localCfgPath } = settlCtx

  if (!result.pass && !result.skipped) {
    if (hookEvent === 'SessionStart') {
      systemMessages.push(result.reason)
      contextParts.push(result.reason)
      return { blocked: false }
    }
    advanceTaskRef(task, false, hookEvent, rootDir, sources)
    return { blocked: true, message: `prove_it: ${task.name} failed.\n\n${result.reason}` }
  }

  if (result.skipped) {
    if (!task.quiet) {
      const text = result.reason || ''
      if (text) {
        outputs.push(text)
        if (hookEvent === 'SessionStart') contextParts.push(text)
      }
    }
    return { blocked: false }
  }

  // PASS
  advanceTaskRef(task, true, hookEvent, rootDir, sources)
  if (whenHasKey(task.when, 'sourcesModifiedSinceLastRun')) {
    const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
    saveRunData(localCfgPath, runKey, { at: Date.now(), result: 'pass' })
  }
  {
    const text = result.output || result.reason
    if (text) {
      if (task.quiet && additionalContextParts) {
        // Quiet tasks with output inject into additionalContext (visible to Claude on allow)
        additionalContextParts.push(text)
      } else if (!task.quiet) {
        outputs.push(text)
      }
      if (hookEvent === 'SessionStart') contextParts.push(text)
    }
  }
  return { blocked: false }
}

/**
 * Build the context snapshot shared by async and parallel task forks.
 */
function buildTaskSnapshot (task, context) {
  const asyncDir = getAsyncDir(context.sessionId)
  if (!asyncDir) return null
  const taskFile = sanitizeTaskName(task.name)
  const contextFilePath = path.join(asyncDir, `${taskFile}.context.json`)
  const resultPath = path.join(asyncDir, `${taskFile}.json`)

  const snapshot = {
    task,
    context: {
      rootDir: context.rootDir,
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      hookEvent: context.hookEvent,
      localCfgPath: context.localCfgPath,
      sources: context.sources,
      fileEditingTools: context.fileEditingTools,
      configEnv: context.configEnv,
      configModel: context.configModel,
      configMaxAgentTurns: context.configMaxAgentTurns,
      taskAllowedTools: context.taskAllowedTools,
      taskBypassPermissions: context.taskBypassPermissions,
      maxChars: context.maxChars,
      testOutput: context.testOutput
    },
    resultPath
  }

  ensureDir(asyncDir)
  fs.writeFileSync(contextFilePath, JSON.stringify(snapshot, null, 2), 'utf8')

  return { contextFilePath, resultPath, taskFile }
}

/**
 * Fork a parallel task as a non-detached child process.
 * Unlike spawnAsyncTask, the child is NOT detached/unref'd—we await it
 * in the same invocation.
 *
 * @returns {{ child, resultPath, task }} or null if sessionId is missing
 */
function forkParallelTask (task, context) {
  const snap = buildTaskSnapshot(task, context)
  if (!snap) return null

  const workerPath = path.join(__dirname, 'async_worker.js')
  const child = fork(workerPath, [snap.contextFilePath], {
    stdio: 'ignore',
    env: { ...process.env, PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  })

  return { child, resultPath: snap.resultPath, task }
}

/**
 * Read a parallel worker's result from its JSON file.
 */
function readParallelResult (resultPath, task) {
  try {
    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    return { task: data.task, result: data.result, resultPath }
  } catch {
    return {
      task,
      result: { pass: true, reason: 'parallel worker exited without result', output: '', skipped: true },
      resultPath
    }
  }
}

/**
 * Await all parallel children and read their result JSON.
 * Fail-fast: if any child exits with a failing result, kill remaining
 * siblings immediately and return all results collected so far.
 *
 * @param {{ child, resultPath, task }[]} batch
 * @returns {Promise<{ task, result }[]>}
 */
function awaitParallelBatch (batch) {
  return new Promise((resolve) => {
    const results = []
    let settled = false
    let remaining = batch.length

    if (remaining === 0) { resolve(results); return }

    for (const entry of batch) {
      const { child, resultPath, task } = entry

      const onDone = () => {
        if (settled) return
        const r = readParallelResult(resultPath, task)
        results.push(r)
        remaining--

        if (!r.result.pass && !r.result.skipped) {
          // Fail-fast: kill siblings and return immediately
          settled = true
          for (const other of batch) {
            if (other !== entry) {
              killChild(other.child)
              // Collect results for killed siblings (may or may not have written files)
              const otherR = readParallelResult(other.resultPath, other.task)
              if (!results.some(x => x.resultPath === other.resultPath)) {
                results.push(otherR)
              }
            }
          }
          resolve(results)
          return
        }

        if (remaining === 0) {
          settled = true
          resolve(results)
        }
      }

      child.on('exit', onDone)
      child.on('error', () => {
        if (settled) return
        results.push({
          task,
          result: { pass: true, reason: 'parallel worker failed to start', output: '', skipped: true },
          resultPath
        })
        remaining--
        if (remaining === 0) {
          settled = true
          resolve(results)
        }
      })
    }
  })
}

/**
 * Kill a forked child and its subprocess tree.
 * fork()'d workers run spawnSync which blocks signal handling,
 * so we SIGKILL the worker and also kill its children via pkill.
 */
function killChild (child) {
  if (!child || !child.pid) return
  // Kill child's subprocess tree first (e.g. bash running sleep)
  try { spawnSync('pkill', ['-KILL', '-P', String(child.pid)], { timeout: 2000 }) } catch {}
  try { child.kill('SIGKILL') } catch {}
}

/**
 * Kill all children in a parallel batch.
 */
function killParallelBatch (batch) {
  for (const { child } of batch) {
    killChild(child)
  }
}

/**
 * Spawn an async task as a detached child process.
 */
function spawnAsyncTask (task, context) {
  const snap = buildTaskSnapshot(task, context)
  if (!snap) return

  const workerPath = path.join(__dirname, 'async_worker.js')
  const child = fork(workerPath, [snap.contextFilePath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  })
  child.unref()
}

/**
 * Harvest completed async results from session storage.
 * Reads result files but does NOT delete them—callers delete after processing
 * so that unprocessed results survive a mid-loop exit (e.g., first-failure block).
 *
 * Returns array of { data, filePath } objects.
 */
function harvestAsyncResults (sessionId) {
  const asyncDir = getAsyncDir(sessionId)
  if (!asyncDir) return []

  let files
  try {
    files = fs.readdirSync(asyncDir)
  } catch {
    return []
  }

  const results = []
  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.context.json')) continue
    const filePath = path.join(asyncDir, file)
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      results.push({ data, filePath })
    } catch {
      // Corrupted or partially written—clean up
      try { fs.unlinkSync(filePath) } catch {}
    }
  }
  return results
}

/**
 * Clean the async directory for a session (fresh start).
 */
function cleanAsyncDir (sessionId) {
  const asyncDir = getAsyncDir(sessionId)
  if (!asyncDir) return
  try {
    fs.rmSync(asyncDir, { recursive: true, force: true })
  } catch {}
}

module.exports = {
  settleTaskResult,
  buildTaskSnapshot,
  forkParallelTask,
  readParallelResult,
  awaitParallelBatch,
  killChild,
  killParallelBatch,
  spawnAsyncTask,
  harvestAsyncResults,
  cleanAsyncDir
}
