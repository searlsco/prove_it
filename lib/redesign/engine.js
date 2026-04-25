const { allowEffect, blockEffect: blockWorkflowEffect } = require('./effects')
const {
  parseSignalCommand,
  setSignal: setLifecycleSignal
} = require('./signal_lifecycle')
const {
  targetPathMatchesProtected,
  toProjectRelativePath
} = require('./target_paths')

const DEFAULT_PROTECTED_PATHS = [
  '.prove_it/config.json',
  '.prove_it/config.local.json'
]

const MUTATING_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'multi_edit',
  'notebookedit',
  'notebook_edit'
])

function normalizeToolName (toolName) {
  return String(toolName || '').toLowerCase()
}

function isMutatingTool (toolName) {
  return MUTATING_TOOLS.has(normalizeToolName(toolName))
}

function defaultDependencies (overrides = {}) {
  return {
    allowEffect,
    blockEffect: blockWorkflowEffect,
    isMutatingTool,
    protectedPathMatch,
    ...overrides
  }
}

function protectedPathMatch (targetPath, protectedPath, rootDir) {
  return targetPathMatchesProtected(targetPath, protectedPath, rootDir)
}

function configGuardBlockEffect (protectedPath, dependencies = defaultDependencies()) {
  return dependencies.blockEffect(`prove_it: Cannot modify protected prove_it config path ${protectedPath}`)
}

function evaluateConfigGuard (task, event, options = {}) {
  const dependencies = defaultDependencies(options.dependencies)
  if (!dependencies.isMutatingTool(event.toolName)) return dependencies.allowEffect()

  const protectedPaths = task.protected_paths || DEFAULT_PROTECTED_PATHS
  for (const targetPath of event.targetPaths) {
    for (const protectedPath of protectedPaths) {
      if (dependencies.protectedPathMatch(targetPath, protectedPath, event.rootDir || event.cwd)) {
        return configGuardBlockEffect(protectedPath, dependencies)
      }
    }
  }

  return dependencies.allowEffect()
}

function preToolPipeline (config) {
  return config?.agent_workflows?.pre_tool || []
}

function taskRegistry (config) {
  return config?.tasks || {}
}

function resolveTaskRunnerPort (ports = {}) {
  return ports.task || ports.taskRunner || null
}

function taskRunnerContext (taskName, task, context) {
  return {
    taskName,
    task,
    event: context.event,
    normalizedEvent: context.event,
    config: context.config,
    effectiveConfig: context.config,
    adapterCapabilities: context.adapterCapabilities || {},
    statePort: context.ports?.state || null,
    taskPort: context.ports?.task || null,
    effectPort: context.ports?.effect || null,
    ports: context.ports || {}
  }
}

function invokeTaskRunner (runner, context) {
  if (typeof runner === 'function') {
    return runner.length >= 2 ? runner(context.task, context) : runner(context)
  }
  if (runner && typeof runner.run === 'function') {
    return runner.run.length >= 2 ? runner.run(context.task, context) : runner.run(context)
  }
  if (runner && typeof runner.runTask === 'function') {
    return runner.runTask.length >= 2 ? runner.runTask(context.task, context) : runner.runTask(context)
  }
  return null
}

function scriptTaskFailureReason (taskName, task, result, fallback) {
  const command = task?.command ? ` (${task.command})` : ''
  const detail = result?.reason || result?.message || result?.error?.message || fallback
  return `prove_it: script task "${taskName}"${command} failed. ${detail}`
}

function scriptTaskBlockEffect (taskName, task, result, dependencies) {
  if (result?.effect === 'block' || result?.effect === 'fail') {
    return dependencies.blockEffect(scriptTaskFailureReason(taskName, task, result, 'Task runner returned a blocking result.'))
  }
  return dependencies.blockEffect(scriptTaskFailureReason(taskName, task, result, 'Task runner reported failure without a reason.'))
}

function runScriptTask (taskName, task, context, dependencies) {
  const runner = resolveTaskRunnerPort(context.ports)
  if (!runner) {
    return dependencies.blockEffect(
      `prove_it: script task "${taskName}" cannot run because no task runner port was provided.`
    )
  }

  let result
  try {
    result = invokeTaskRunner(runner, taskRunnerContext(taskName, task, context))
  } catch (error) {
    return dependencies.blockEffect(scriptTaskFailureReason(taskName, task, {
      reason: error.message
    }, 'Task runner threw an error.'))
  }

  if (result?.effect === 'allow' || result?.effect === 'approve' || result?.pass === true || result?.ok === true) {
    return dependencies.allowEffect()
  }

  if (result?.effect === 'block' || result?.effect === 'fail' || result?.pass === false || result?.ok === false) {
    return scriptTaskBlockEffect(taskName, task, result, dependencies)
  }

  return dependencies.blockEffect(
    scriptTaskFailureReason(taskName, task, result, 'Task runner returned no pass/fail result.')
  )
}

function runPreToolWorkflow (config, event, options = {}) {
  const dependencies = defaultDependencies(options.dependencies)
  if (!config) return dependencies.allowEffect()

  const context = {
    event,
    config,
    adapterCapabilities: options.adapterCapabilities || {},
    ports: options.ports || {
      task: options.taskPort || options.taskRunnerPort || null,
      effect: options.effectPort || options.effectsPort || null,
      state: options.statePort || null
    }
  }

  const tasks = taskRegistry(config)
  for (const taskName of preToolPipeline(config)) {
    const task = tasks[taskName]
    if (!task) continue
    if (task.type === 'config_guard') {
      const effect = evaluateConfigGuard(task, event, { dependencies })
      if (effect.effect === 'block') return effect
    } else if (task.type === 'script') {
      const effect = runScriptTask(taskName, task, context, dependencies)
      if (effect.effect === 'block' || effect.effect === 'fail') return effect
    }
  }

  return dependencies.allowEffect()
}

function emitEffect (effectPort, effect, context) {
  if (!effectPort) return effect

  let emitted
  if (typeof effectPort === 'function') {
    emitted = effectPort(effect, context)
  } else if (typeof effectPort.emit === 'function') {
    emitted = effectPort.emit(effect, context)
  }

  return emitted && typeof emitted === 'object' ? emitted : effect
}

function runWorkflowEngine ({
  event,
  effectiveConfig,
  config,
  adapterCapabilities = {},
  statePort = null,
  taskPort = null,
  effectPort = null,
  effectsPort = null,
  taskRunnerPort = null,
  dependencies = {}
} = {}) {
  const workflowConfig = effectiveConfig || config
  const ports = {
    state: statePort,
    task: taskPort || taskRunnerPort,
    effect: effectPort || effectsPort
  }
  const context = {
    event,
    config: workflowConfig,
    adapterCapabilities,
    ports
  }
  const deps = defaultDependencies(dependencies)

  let effect
  if (event?.stage === 'pre_tool') {
    const signalCommand = parseSignalCommand(event.command)
    if (signalCommand?.valid) {
      const result = setLifecycleSignal(ports.state, event.sessionId, signalCommand.type, signalCommand.message)
      effect = deps.allowEffect({
        reason: `prove_it: signal "${signalCommand.type}" recorded`,
        signal: result.signal
      })
    } else {
      effect = runPreToolWorkflow(workflowConfig, event, {
        adapterCapabilities,
        dependencies,
        ports
      })
    }
  } else {
    effect = deps.allowEffect()
  }

  return emitEffect(ports.effect, effect, context)
}

module.exports = {
  DEFAULT_PROTECTED_PATHS,
  evaluateConfigGuard,
  isMutatingTool,
  protectedPathMatch,
  runPreToolWorkflow,
  runWorkflowEngine,
  toProjectRelativePath
}
