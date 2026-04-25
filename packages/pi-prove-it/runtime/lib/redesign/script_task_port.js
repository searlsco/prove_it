const { runScriptCheck } = require('../checks/script')

const DEFAULT_MAX_CHARS = 12000

function scriptCheckFromTask (taskName, task) {
  return {
    ...task,
    name: taskName,
    timeout: task.timeout_ms
  }
}

function scriptContextFromWorkflowContext ({ event, config, effectiveConfig }) {
  return {
    rootDir: event?.rootDir || event?.cwd || process.cwd(),
    projectDir: event?.projectDir || event?.rootDir || event?.cwd || process.cwd(),
    sessionId: event?.sessionId || null,
    maxChars: DEFAULT_MAX_CHARS,
    hookEvent: event?.rawEventName || event?.stage,
    toolName: event?.toolName || event?.tool?.name,
    toolInput: event?.toolInput || event?.tool?.input,
    toolResponse: event?.tool?.response,
    error: event?.tool?.error,
    config: effectiveConfig || config
  }
}

function createScriptTaskPort (options = {}) {
  const runScript = options.runScript || runScriptCheck

  return {
    run (context) {
      return runScript(
        scriptCheckFromTask(context.taskName, context.task),
        scriptContextFromWorkflowContext(context)
      )
    }
  }
}

module.exports = {
  createScriptTaskPort,
  scriptCheckFromTask,
  scriptContextFromWorkflowContext
}
