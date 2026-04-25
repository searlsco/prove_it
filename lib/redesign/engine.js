const {
  allowEffect,
  approveEffect,
  batchEffect,
  blockEffect: blockWorkflowEffect,
  contextInjectionEffect,
  envUpdateEffect,
  failEffect,
  remediationEffect
} = require('./effects')
const { renderCompletionAccountability, renderMethodologySummary } = require('../methodology')
const { isHardBlock, isRemediation } = require('../adapter_capabilities')
const {
  VALID_SIGNALS,
  parseSignalCommand,
  readSignal,
  setSignal: setLifecycleSignal,
  settleSignalAfterVerification
} = require('./signal_lifecycle')
const {
  targetPathMatchesProtected,
  toProjectRelativePath
} = require('./target_paths')
const { evaluateWhen } = require('./when')

const DEFAULT_PROTECTED_PATHS = [
  '.prove_it/config.json',
  '.prove_it/config.local.json'
]

const MUTATING_TOOLS = new Set([
  'bash',
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

function isBashTool (toolName) {
  return normalizeToolName(toolName) === 'bash'
}

function invalidSignalReason (signalCommand) {
  const type = signalCommand?.type || 'missing'
  return `prove_it: invalid signal "${type}". Expected one of: ${VALID_SIGNALS.join(', ')}`
}

function signalStateUnavailableReason (type) {
  return `prove_it: signal "${type}" could not be recorded because session state is unavailable`
}

function defaultDependencies (overrides = {}) {
  return {
    allowEffect,
    approveEffect,
    batchEffect,
    blockEffect: blockWorkflowEffect,
    contextInjectionEffect,
    envUpdateEffect,
    failEffect,
    remediationEffect,
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

function postToolPipeline (config) {
  return config?.agent_workflows?.post_tool || []
}

function postToolFailurePipeline (config) {
  return config?.agent_workflows?.post_tool_failure || []
}

function isStartupOrResumeSessionStart (event) {
  return event?.source?.kind === 'startup' || event?.source?.kind === 'resume'
}

function renderSessionStartGuidance () {
  return [
    renderMethodologySummary(),
    '',
    renderCompletionAccountability()
  ].join('\n')
}

function runSessionStartWorkflow (_config, event, options = {}) {
  const dependencies = defaultDependencies(options.dependencies)
  const effects = [
    dependencies.contextInjectionEffect(renderSessionStartGuidance(), {
      source: 'methodology'
    })
  ]

  if (event?.sessionId && isStartupOrResumeSessionStart(event)) {
    effects.push(dependencies.envUpdateEffect({
      PROVE_IT_SESSION_ID: event.sessionId
    }, {
      source: 'session_start'
    }))
  }

  return dependencies.batchEffect(effects)
}

function agentEndPipeline (config) {
  return config?.agent_workflows?.agent_end || []
}

function taskRegistry (config) {
  return config?.tasks || {}
}

const TASK_LIFECYCLE_STATE_KEY = 'task_lifecycle'

function readStateValue (statePort, sessionId, key) {
  if (!statePort || !key) return null
  try {
    if (typeof statePort.readSessionState === 'function') return statePort.readSessionState(sessionId, key)
    if (typeof statePort.read === 'function') return statePort.read(sessionId, key)
    if (typeof statePort.getSessionState === 'function') return statePort.getSessionState(sessionId, key)
  } catch {}
  return null
}

function writeStateValue (statePort, sessionId, key, value) {
  if (!statePort || !key) return false
  try {
    if (typeof statePort.writeSessionState === 'function') return statePort.writeSessionState(sessionId, key, value)
    if (typeof statePort.write === 'function') return statePort.write(sessionId, key, value)
    if (typeof statePort.setSessionState === 'function') return statePort.setSessionState(sessionId, key, value)
  } catch {}
  return false
}

function readTaskLifecycleState (context) {
  const state = readStateValue(context.ports?.state, context.event?.sessionId, TASK_LIFECYCLE_STATE_KEY)
  if (state && typeof state === 'object' && !Array.isArray(state)) return state
  return { async: { pending: [] }, active: { tasks: [] } }
}

function normalizeTaskLifecycleState (state) {
  const normalized = state && typeof state === 'object' && !Array.isArray(state)
    ? { ...state }
    : {}
  const asyncState = normalized.async && typeof normalized.async === 'object' && !Array.isArray(normalized.async)
    ? { ...normalized.async }
    : {}
  asyncState.pending = Array.isArray(asyncState.pending) ? [...asyncState.pending] : []
  normalized.async = asyncState
  if (!normalized.active || typeof normalized.active !== 'object' || Array.isArray(normalized.active)) {
    normalized.active = { tasks: [] }
  }
  if (!Array.isArray(normalized.active.tasks)) normalized.active.tasks = []
  return normalized
}

function writeTaskLifecycleState (context, state) {
  return writeStateValue(context.ports?.state, context.event?.sessionId, TASK_LIFECYCLE_STATE_KEY, normalizeTaskLifecycleState(state))
}

function lifecycleTaskContext (taskName, task, context) {
  return taskRunnerContext(taskName, task, context)
}

function invokeTaskPortMethod (taskPort, names, ...args) {
  if (!taskPort) return null
  for (const name of names) {
    if (typeof taskPort[name] === 'function') return taskPort[name](...args)
  }
  return null
}

function asyncResultStatus (result) {
  if (result?.skipped) return 'skip'
  if (result?.pass === true || result?.ok === true || result?.effect === 'allow' || result?.effect === 'approve') return 'pass'
  return 'fail'
}

function taskResultReason (result, fallback) {
  return result?.reason || result?.message || result?.error?.message || result?.output || fallback
}

function taskFailureReason (taskName, task, result, mode) {
  const suffix = mode ? ` (${mode})` : ''
  return scriptTaskFailureReason(taskName, task, result, `Task${suffix} failed.`)
}

function taskByNameFromLifecycle (entry, context) {
  return entry?.task || taskRegistry(context.config)[entry?.taskName] || { type: 'script' }
}

function normalizeHarvestedResult (harvested) {
  if (!harvested || typeof harvested !== 'object') return null
  return {
    id: harvested.id || harvested.handleId || harvested.taskId || harvested.taskName,
    taskName: harvested.taskName || harvested.name || harvested.task?.name,
    task: harvested.task || null,
    result: harvested.result || harvested.taskResult || null,
    missing: harvested.missing === true || harvested.stale === true,
    reason: harvested.reason || harvested.message || null
  }
}

function pendingWithoutId (pending, id) {
  return pending.filter(entry => entry.id !== id)
}

function harvestAsyncTasks (context, dependencies, options = {}) {
  const lifecycle = normalizeTaskLifecycleState(readTaskLifecycleState(context))
  const pending = lifecycle.async.pending
  const asyncResults = []
  const lifecycleWarnings = []
  let blockingFailure = null
  let changed = false

  if (pending.length === 0) return { asyncResults, lifecycleWarnings, blockingFailure, harvested: false }

  const fromPort = invokeTaskPortMethod(context.ports.task, ['harvestBackgroundTasks', 'harvestAsyncTasks'], {
    pending,
    lifecycle,
    event: context.event,
    config: context.config,
    ports: context.ports
  }, context) || []
  const harvestedById = new Map()
  for (const item of Array.isArray(fromPort) ? fromPort : []) {
    const normalized = normalizeHarvestedResult(item)
    if (normalized?.id) harvestedById.set(normalized.id, normalized)
  }

  for (const entry of [...pending]) {
    const harvested = harvestedById.get(entry.id) || (entry.status === 'failed' && entry.result
      ? { id: entry.id, taskName: entry.taskName, task: entry.task || null, result: entry.result }
      : null)
    if (!harvested) continue

    const taskName = harvested.taskName || entry.taskName
    const task = harvested.task || taskByNameFromLifecycle(entry, context)

    if (harvested.missing) {
      lifecycle.async.pending = pendingWithoutId(lifecycle.async.pending, entry.id)
      lifecycleWarnings.push({
        taskName,
        reason: harvested.reason || 'async result record was missing or stale'
      })
      changed = true
      invokeTaskPortMethod(context.ports.task, ['consumeBackgroundTask', 'consumeAsyncTask'], harvested, context)
      continue
    }

    const result = harvested.result || { pass: true, skipped: true, reason: 'async task produced no result' }
    const status = asyncResultStatus(result)

    if (status === 'fail') {
      if (context.event?.stage !== 'agent_end' && options.deferFailures !== false) {
        const index = lifecycle.async.pending.findIndex(item => item.id === entry.id)
        if (index >= 0) {
          lifecycle.async.pending[index] = { ...entry, status: 'failed', result, task }
          changed = true
        }
        continue
      }

      lifecycle.async.pending = pendingWithoutId(lifecycle.async.pending, entry.id)
      changed = true
      invokeTaskPortMethod(context.ports.task, ['consumeBackgroundTask', 'consumeAsyncTask'], harvested, context)
      blockingFailure = dependencies.blockEffect(taskFailureReason(taskName, task, result, 'async'))
      break
    }

    lifecycle.async.pending = pendingWithoutId(lifecycle.async.pending, entry.id)
    asyncResults.push({
      taskName,
      status,
      reason: taskResultReason(result, status === 'skip' ? 'async task skipped' : 'async task passed'),
      output: result.output || null
    })
    changed = true
    invokeTaskPortMethod(context.ports.task, ['consumeBackgroundTask', 'consumeAsyncTask'], harvested, context)
  }

  if (changed) writeTaskLifecycleState(context, lifecycle)
  return { asyncResults, lifecycleWarnings, blockingFailure, harvested: true }
}

function launchAsyncTask (taskName, task, context) {
  const handle = invokeTaskPortMethod(context.ports.task, ['launchBackgroundTask', 'startBackgroundTask', 'launchAsyncTask'], lifecycleTaskContext(taskName, task, context), context)
  if (!handle) return null

  const id = handle.id || handle.handleId || handle.taskId || `${taskName}:${Date.now()}`
  const lifecycle = normalizeTaskLifecycleState(readTaskLifecycleState(context))
  lifecycle.async.pending.push({
    id,
    taskName,
    stage: context.event?.stage || null,
    status: handle.status || 'pending'
  })
  writeTaskLifecycleState(context, lifecycle)
  return { id, taskName, status: handle.status || 'pending' }
}

function startParallelTask (taskName, task, context) {
  const handle = invokeTaskPortMethod(context.ports.task, ['startParallelTask', 'forkParallelTask'], lifecycleTaskContext(taskName, task, context), context)
  if (handle) return { ...handle, taskName, task }
  return { id: taskName, taskName, task, deferred: true }
}

function settleDeferredParallelHandle (handle, context) {
  const result = invokeTaskRunner(resolveTaskRunnerPort(context.ports), lifecycleTaskContext(handle.taskName, handle.task, context))
  return { id: handle.id, taskName: handle.taskName, task: handle.task, result }
}

function settleParallelBatch (handles, context) {
  const settled = invokeTaskPortMethod(context.ports.task, ['settleParallelBatch', 'awaitParallelBatch', 'runParallelBatch'], handles, context)
  if (settled) return Array.isArray(settled) ? settled : []
  return handles.map(handle => settleDeferredParallelHandle(handle, context))
}

function cancelTaskHandles (handles, context) {
  if (!handles || handles.length === 0) return
  invokeTaskPortMethod(context.ports.task, ['cancelTasks', 'cancelParallelBatch', 'killParallelBatch'], handles, context)
}

function cleanupTaskHandles (handles, context) {
  if (!handles || handles.length === 0) return
  invokeTaskPortMethod(context.ports.task, ['cleanupTasks', 'cleanupParallelBatch'], handles, context)
}

function settleParallelResults (handles, context, dependencies) {
  const parallelResults = []
  if (!handles || handles.length === 0) return { parallelResults, blockingFailure: null }

  const settled = settleParallelBatch(handles, context)
  cleanupTaskHandles(handles, context)
  for (const item of settled) {
    const taskName = item.taskName || item.task?.name
    const task = item.task || taskRegistry(context.config)[taskName] || { type: 'script' }
    const result = item.result || { pass: true, skipped: true, reason: 'parallel task produced no result' }
    const status = asyncResultStatus(result)
    parallelResults.push({
      taskName,
      status,
      reason: taskResultReason(result, status === 'skip' ? 'parallel task skipped' : 'parallel task passed'),
      output: result.output || null
    })
    if (status === 'fail') {
      return {
        parallelResults,
        blockingFailure: dependencies.blockEffect(taskFailureReason(taskName, task, result, 'parallel'))
      }
    }
  }
  return { parallelResults, blockingFailure: null }
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
    observationPort: context.ports?.observations || null,
    ports: context.ports || {}
  }
}

function recordSkippedTask (context, taskName, task, result) {
  if (!context.skippedTasks) context.skippedTasks = []
  context.skippedTasks.push({
    taskName,
    reason: result.reason || 'Skipped because task conditions were not met',
    when: task?.when || null,
    evidence: result.evidence === undefined ? null : result.evidence,
    semantics: result.semantics || null
  })
}

function allowWithSkippedTasks (context, dependencies) {
  if (context.skippedTasks && context.skippedTasks.length > 0) {
    return dependencies.allowEffect({ skipped: context.skippedTasks })
  }
  return dependencies.allowEffect()
}

function whenHasSignal (when, signalType) {
  if (!when || !signalType) return false
  const clauses = Array.isArray(when) ? when : [when]
  return clauses.some(clause => clause?.signal === signalType)
}

function agentEndTaskCanRunForSignal (task, signal) {
  if (signal?.type === 'done') return true
  return whenHasSignal(task?.when, signal?.type)
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

function taskToolMatcherMatches (task, event) {
  if (!task?.matcher) return true
  const toolName = event?.toolName || ''
  try {
    return new RegExp('^(?:' + task.matcher + ')$').test(toolName)
  } catch {
    return String(task.matcher).split('|').some(matcher => matcher === toolName)
  }
}

function taskTriggersMatch (task, event) {
  if (!Array.isArray(task?.triggers) || task.triggers.length === 0) return true
  const command = event?.command || ''
  return task.triggers.some(trigger => {
    try { return new RegExp(trigger, 'i').test(command) } catch { return false }
  })
}

function taskMatchesEvent (task, event) {
  return taskToolMatcherMatches(task, event) && taskTriggersMatch(task, event)
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

function completionVerificationBehavior (adapterCapabilities = {}) {
  return adapterCapabilities.completion_verification || null
}

function completionFailureReason (effect) {
  return effect?.reason || effect?.message || 'prove_it: completion verification failed.'
}

function completionFailureEffect (effect, context, dependencies) {
  const behavior = completionVerificationBehavior(context.adapterCapabilities)
  const reason = completionFailureReason(effect)
  const signalLifecycle = settleSignalAfterVerification(context.ports.state, context.event.sessionId, false)
  const fields = {
    capability: 'completion_verification',
    enforcement: behavior?.strength || behavior?.mode || null,
    signalLifecycle
  }

  if (isHardBlock(behavior)) return dependencies.failEffect(reason, fields)
  if (isRemediation(behavior)) return dependencies.remediationEffect(reason, fields)
  return dependencies.remediationEffect(reason, { ...fields, enforcement: fields.enforcement || 'unsupported' })
}

function completionPassEffect (context, dependencies) {
  const behavior = completionVerificationBehavior(context.adapterCapabilities)
  const signalLifecycle = settleSignalAfterVerification(context.ports.state, context.event.sessionId, true)
  return dependencies.approveEffect('prove_it: completion verification passed.', {
    capability: 'completion_verification',
    enforcement: behavior?.strength || behavior?.mode || null,
    signalLifecycle
  })
}

function runAgentEndWorkflow (config, event, options = {}) {
  const dependencies = defaultDependencies(options.dependencies)
  if (!config) return dependencies.allowEffect()

  const ports = options.ports || {
    task: options.taskPort || options.taskRunnerPort || null,
    effect: options.effectPort || options.effectsPort || null,
    state: options.statePort || null,
    observations: options.observationPort || options.observationsPort || null
  }
  const signal = readSignal(ports.state, event.sessionId)
  if (!signal || signal.type === 'idle') return dependencies.allowEffect()

  const context = {
    event,
    config,
    adapterCapabilities: options.adapterCapabilities || {},
    ports,
    skippedTasks: []
  }

  const harvested = harvestAsyncTasks(context, dependencies, { deferFailures: false })
  if (harvested.blockingFailure) {
    const effect = completionFailureEffect(harvested.blockingFailure, context, dependencies)
    effect.asyncResults = harvested.asyncResults
    if (harvested.lifecycleWarnings.length > 0) effect.lifecycleWarnings = harvested.lifecycleWarnings
    return effect
  }

  const parallelBatch = []
  const tasks = taskRegistry(config)
  for (const taskName of agentEndPipeline(config)) {
    const task = tasks[taskName]
    if (!task) continue
    if (!agentEndTaskCanRunForSignal(task, signal)) continue
    const whenResult = evaluateWhen(task.when, context, taskName)
    if (!whenResult.passed) {
      recordSkippedTask(context, taskName, task, whenResult)
      continue
    }
    if (task.async === true) {
      launchAsyncTask(taskName, task, context)
      continue
    }
    if (task.parallel === true) {
      parallelBatch.push(startParallelTask(taskName, task, context))
      continue
    }
    if (task.type === 'script' || task.type === 'agent') {
      const effect = runScriptTask(taskName, task, context, dependencies)
      if (effect.effect === 'block' || effect.effect === 'fail') {
        cancelTaskHandles(parallelBatch, context)
        cleanupTaskHandles(parallelBatch, context)
        return completionFailureEffect(effect, context, dependencies)
      }
    }
  }

  const parallel = settleParallelResults(parallelBatch, context, dependencies)
  if (parallel.blockingFailure) {
    const effect = completionFailureEffect(parallel.blockingFailure, context, dependencies)
    effect.parallelResults = parallel.parallelResults
    return effect
  }

  const effect = completionPassEffect(context, dependencies)
  if (context.skippedTasks.length > 0) effect.skipped = context.skippedTasks
  if (harvested.asyncResults.length > 0) effect.asyncResults = harvested.asyncResults
  if (harvested.lifecycleWarnings.length > 0) effect.lifecycleWarnings = harvested.lifecycleWarnings
  if (parallel.parallelResults.length > 0) effect.parallelResults = parallel.parallelResults
  return effect
}

function runTaskStageWorkflow (config, event, pipeline, options = {}) {
  const dependencies = defaultDependencies(options.dependencies)
  if (!config) return dependencies.allowEffect()

  const context = {
    event,
    config,
    adapterCapabilities: options.adapterCapabilities || {},
    ports: options.ports || {
      task: options.taskPort || options.taskRunnerPort || null,
      effect: options.effectPort || options.effectsPort || null,
      state: options.statePort || null,
      observations: options.observationPort || options.observationsPort || null
    },
    skippedTasks: []
  }

  const harvested = harvestAsyncTasks(context, dependencies)
  if (harvested.blockingFailure) return harvested.blockingFailure

  const parallelBatch = []
  const tasks = taskRegistry(config)
  for (const taskName of pipeline) {
    const task = tasks[taskName]
    if (!task || !taskMatchesEvent(task, event)) continue
    const whenResult = evaluateWhen(task.when, context, taskName)
    if (!whenResult.passed) {
      recordSkippedTask(context, taskName, task, whenResult)
      continue
    }
    if (task.async === true && event?.stage !== 'session_start') {
      launchAsyncTask(taskName, task, context)
      continue
    }
    if (task.parallel === true && event?.stage !== 'session_start') {
      parallelBatch.push(startParallelTask(taskName, task, context))
      continue
    }
    if (task.type === 'config_guard') {
      const effect = evaluateConfigGuard(task, event, { dependencies })
      if (effect.effect === 'block') {
        cancelTaskHandles(parallelBatch, context)
        cleanupTaskHandles(parallelBatch, context)
        return effect
      }
    } else if (task.type === 'script' || task.type === 'agent') {
      const effect = runScriptTask(taskName, task, context, dependencies)
      if (effect.effect === 'block' || effect.effect === 'fail') {
        cancelTaskHandles(parallelBatch, context)
        cleanupTaskHandles(parallelBatch, context)
        return effect
      }
    }
  }

  const parallel = settleParallelResults(parallelBatch, context, dependencies)
  if (parallel.blockingFailure) return parallel.blockingFailure

  const effect = allowWithSkippedTasks(context, dependencies)
  if (harvested.harvested || harvested.asyncResults.length > 0) effect.asyncResults = harvested.asyncResults
  if (harvested.lifecycleWarnings.length > 0) effect.lifecycleWarnings = harvested.lifecycleWarnings
  if (parallel.parallelResults.length > 0) effect.parallelResults = parallel.parallelResults
  return effect
}

function runPreToolWorkflow (config, event, options = {}) {
  return runTaskStageWorkflow(config, event, preToolPipeline(config), options)
}

function runPostToolWorkflow (config, event, options = {}) {
  return runTaskStageWorkflow(config, event, postToolPipeline(config), options)
}

function runPostToolFailureWorkflow (config, event, options = {}) {
  return runTaskStageWorkflow(config, event, postToolFailurePipeline(config), options)
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
  observationPort = null,
  observationsPort = null,
  dependencies = {}
} = {}) {
  const workflowConfig = effectiveConfig || config
  const ports = {
    state: statePort,
    task: taskPort || taskRunnerPort,
    effect: effectPort || effectsPort,
    observations: observationPort || observationsPort
  }
  const context = {
    event,
    config: workflowConfig,
    adapterCapabilities,
    ports,
    skippedTasks: []
  }
  const deps = defaultDependencies(dependencies)

  let effect
  if (event?.stage === 'session_start') {
    effect = runSessionStartWorkflow(workflowConfig, event, {
      adapterCapabilities,
      dependencies,
      ports
    })
  } else if (event?.stage === 'pre_tool') {
    const signalCommand = isBashTool(event.toolName) ? parseSignalCommand(event.command) : null
    if (signalCommand?.matched) {
      if (signalCommand.valid) {
        const result = setLifecycleSignal(ports.state, event.sessionId, signalCommand.type, signalCommand.message)
        effect = deps.allowEffect({
          reason: result.ok
            ? `prove_it: signal "${signalCommand.type}" recorded`
            : signalStateUnavailableReason(signalCommand.type),
          signal: result.signal,
          signalLifecycle: result
        })
      } else {
        effect = deps.allowEffect({
          reason: invalidSignalReason(signalCommand),
          signalLifecycle: {
            ok: false,
            reason: 'invalid_signal',
            signal: null
          }
        })
      }
    } else {
      effect = runPreToolWorkflow(workflowConfig, event, {
        adapterCapabilities,
        dependencies,
        ports
      })
    }
  } else if (event?.stage === 'post_tool') {
    effect = runPostToolWorkflow(workflowConfig, event, {
      adapterCapabilities,
      dependencies,
      ports
    })
  } else if (event?.stage === 'post_tool_failure') {
    effect = runPostToolFailureWorkflow(workflowConfig, event, {
      adapterCapabilities,
      dependencies,
      ports
    })
  } else if (event?.stage === 'agent_end') {
    effect = runAgentEndWorkflow(workflowConfig, event, {
      adapterCapabilities,
      dependencies,
      ports
    })
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
  renderSessionStartGuidance,
  runAgentEndWorkflow,
  runPostToolFailureWorkflow,
  runPostToolWorkflow,
  runPreToolWorkflow,
  runSessionStartWorkflow,
  runWorkflowEngine,
  toProjectRelativePath
}
