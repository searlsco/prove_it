const fs = require('fs')
const path = require('path')
const { fork } = require('child_process')
const { runScriptCheck } = require('../checks/script')
const { ensureDir, sanitizeTaskName, tryRun } = require('../io')
const { getAsyncDir } = require('../session')

const DEFAULT_MAX_CHARS = 12000

function scriptCheckFromTask (taskName, task) {
  return {
    ...task,
    name: taskName,
    timeout: task.timeout_ms,
    ...(task.output === 'failures_only' ? { quiet: true } : {})
  }
}

function scriptContextFromWorkflowContext ({ event, config, effectiveConfig, task, configEnv }) {
  const workflowConfig = effectiveConfig || config || {}
  const taskEnv = task?.env && typeof task.env === 'object' && !Array.isArray(task.env) ? task.env : {}
  return {
    rootDir: event?.rootDir || event?.cwd || process.cwd(),
    projectDir: event?.projectDir || event?.rootDir || event?.cwd || process.cwd(),
    cwd: event?.cwd || event?.rootDir || process.cwd(),
    adapterId: event?.adapterId || event?.adapter || null,
    sessionId: event?.sessionId || null,
    maxChars: DEFAULT_MAX_CHARS,
    hookEvent: event?.rawEventName || event?.stage,
    workflowStage: event?.stage || null,
    toolName: event?.toolName || event?.tool?.name,
    toolInput: event?.toolInput || event?.tool?.input,
    toolResponse: event?.tool?.response,
    error: event?.tool?.error,
    command: event?.command || null,
    targetPaths: event?.targetPaths || [],
    normalizedEvent: event || null,
    config: workflowConfig,
    configEnv: { ...(configEnv || {}), ...taskEnv },
    sources: workflowConfig.globs?.source || [],
    tests: workflowConfig.globs?.test || [],
    testCommands: workflowConfig.testCommands || []
  }
}

function asyncSnapshotForTask (context, options = {}) {
  const sessionId = context.event?.sessionId || null
  const asyncDir = options.asyncDir || getAsyncDir(sessionId)
  if (!asyncDir) return null

  const taskFile = `${sanitizeTaskName(context.taskName)}-${Date.now()}-${process.pid}`
  const contextFilePath = path.join(asyncDir, `${taskFile}.context.json`)
  const resultPath = path.join(asyncDir, `${taskFile}.json`)
  const snapshot = {
    task: scriptCheckFromTask(context.taskName, context.task),
    context: scriptContextFromWorkflowContext(context),
    resultPath
  }

  ensureDir(asyncDir)
  fs.writeFileSync(contextFilePath, JSON.stringify(snapshot, null, 2), 'utf8')
  return { contextFilePath, resultPath }
}

function launchBackgroundScriptTask (context, options = {}) {
  const snapshot = asyncSnapshotForTask(context, options)
  if (!snapshot) return null

  const workerPath = options.workerPath || path.join(__dirname, '..', 'async_worker.js')
  const child = fork(workerPath, [snapshot.contextFilePath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  })
  child.unref()
  return { id: snapshot.resultPath, status: 'pending' }
}

function harvestBackgroundScriptTasks ({ pending } = {}) {
  const results = []
  for (const entry of Array.isArray(pending) ? pending : []) {
    if (!entry?.id || typeof entry.id !== 'string') continue
    try {
      const data = JSON.parse(fs.readFileSync(entry.id, 'utf8'))
      results.push({
        id: entry.id,
        taskName: data.taskName || entry.taskName,
        task: data.task || null,
        result: data.result || null
      })
    } catch {}
  }
  return results
}

function consumeBackgroundScriptTask (result) {
  if (!result?.id || typeof result.id !== 'string') return false
  try {
    fs.unlinkSync(result.id)
    return true
  } catch {
    return false
  }
}

function sessionEnvInputFromContext (context) {
  const input = {}
  const event = context.event || {}
  if (event.rawEventName || event.stage) input.hook_event_name = event.rawEventName || event.stage
  if (event.stage) input.workflow_stage = event.stage
  if (event.adapterId || event.adapter) input.adapter_id = event.adapterId || event.adapter
  if (event.sessionId) input.session_id = event.sessionId
  if (event.cwd) input.cwd = event.cwd
  if (event.projectDir) input.project_dir = event.projectDir
  if (event.rootDir) input.root_dir = event.rootDir
  if (context.task?.params) input.params = context.task.params
  return Object.keys(input).length > 0 ? JSON.stringify(input) : undefined
}

function runSessionEnvCommand (context) {
  const task = context.task || {}
  const command = task.command
  const scriptContext = scriptContextFromWorkflowContext(context)
  const result = tryRun(command, {
    cwd: scriptContext.rootDir,
    timeout: task.timeout_ms,
    input: sessionEnvInputFromContext(context),
    env: {
      ...process.env,
      ...scriptContext.configEnv,
      PROVE_IT_DISABLED: '1',
      PROVE_IT_SKIP_NOTIFY: '1'
    }
  })

  return {
    pass: result.code === 0,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    reason: result.code === 0 ? null : `${command} failed`
  }
}

function createScriptTaskPort (options = {}) {
  const runScript = options.runScript || runScriptCheck
  const runSessionEnv = options.runSessionEnv || runSessionEnvCommand

  return {
    run (context) {
      return runScript(
        scriptCheckFromTask(context.taskName, context.task),
        scriptContextFromWorkflowContext(context)
      )
    },
    runSessionEnvTask (context) {
      return runSessionEnv(context)
    },
    launchBackgroundTask (context) {
      return launchBackgroundScriptTask(context, options)
    },
    harvestBackgroundTasks (context) {
      return harvestBackgroundScriptTasks(context)
    },
    consumeBackgroundTask (result) {
      return consumeBackgroundScriptTask(result)
    }
  }
}

module.exports = {
  asyncSnapshotForTask,
  consumeBackgroundScriptTask,
  createScriptTaskPort,
  harvestBackgroundScriptTasks,
  launchBackgroundScriptTask,
  runSessionEnvCommand,
  scriptCheckFromTask,
  scriptContextFromWorkflowContext,
  sessionEnvInputFromContext
}
