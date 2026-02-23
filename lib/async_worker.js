'use strict'

/**
 * Async task worker—runs as a detached child process.
 *
 * Receives a context file path as argv[2]. The context file contains
 * everything needed to run the task without re-deriving dispatcher state.
 *
 * Lifecycle:
 *   1. Read context file
 *   2. Log RUNNING to session JSONL
 *   3. Run the check (script or agent)
 *   4. Log verdict to session JSONL
 *   5. Log DONE to session JSONL (awaiting enforcement)
 *   6. Write result JSON atomically (tmp + rename)
 *   7. Delete context file
 *   8. Exit
 */

const fs = require('fs')
const path = require('path')
const { runScriptCheck } = require('./checks/script')
const { runAgentCheck } = require('./checks/agent')
const { logReview } = require('./session')

const contextFilePath = process.argv[2]
if (!contextFilePath) {
  process.exit(1)
}

let ctx
try {
  ctx = JSON.parse(fs.readFileSync(contextFilePath, 'utf8'))
} catch (e) {
  process.exit(1)
}

const { task, context, resultPath } = ctx

// Apply configEnv then re-apply recursion guards (defense-in-depth)
if (context.configEnv) {
  Object.assign(process.env, context.configEnv)
}
Object.assign(process.env, { PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' })

logReview(context.sessionId, context.projectDir, task.name, 'RUNNING', null, null, context.hookEvent)

let result
let crashed = false
try {
  if (task.type === 'script') {
    result = runScriptCheck(task, context)
  } else if (task.type === 'agent') {
    result = runAgentCheck(task, context)
  } else {
    result = { pass: false, reason: `unsupported async task type: ${task.type}`, output: '' }
  }
} catch (e) {
  crashed = true
  result = { pass: false, reason: `async worker crash: ${e.message}`, output: '' }
  logReview(context.sessionId, context.projectDir, task.name, 'BOOM', result.reason, null, context.hookEvent)
}

// Log verdict (skip if already logged as BOOM)
if (!crashed) {
  const status = result.skipped ? 'SKIP' : (result.pass ? 'PASS' : 'FAIL')
  logReview(context.sessionId, context.projectDir, task.name, status, result.reason, null, context.hookEvent)
}

// Log DONE—review complete, awaiting enforcement on next Stop hook
logReview(context.sessionId, context.projectDir, task.name, 'DONE', 'review complete, waiting for Stop hook', null, context.hookEvent)

// Write result atomically
const payload = {
  taskName: task.name,
  task,
  result: {
    pass: result.pass,
    reason: result.reason,
    output: result.output || '',
    skipped: result.skipped || false
  },
  completedAt: Date.now()
}

const tmpPath = resultPath + '.tmp'
try {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true })
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.renameSync(tmpPath, resultPath)
} catch (e) {
  logReview(context.sessionId, context.projectDir, task.name, 'BOOM', `failed to write result: ${e.message}`, null, context.hookEvent)
  process.exit(1)
}

// Clean up context file
try { fs.unlinkSync(contextFilePath) } catch {}

process.exit(0)
