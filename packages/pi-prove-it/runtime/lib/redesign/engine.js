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
const { sanitizeTaskName } = require('../io')
const { renderCompletionAccountability, renderMethodologySummary } = require('../methodology')
const { isHardBlock, isRemediation } = require('../adapter_capabilities')
const {
  VALID_SIGNALS,
  parseSignalCommand,
  readSignal,
  setSignal: setLifecycleSignal,
  settleSignalAfterVerification
} = require('./signal_lifecycle')
const { parsePhaseCommand, setPhase: setLifecyclePhase } = require('./phase_state')
const { consumeSessionCancel } = require('./session_control')
const {
  targetPathMatchesProtected,
  toProjectRelativePath
} = require('./target_paths')
const { evaluateWhen } = require('./when')
const { attachReviewerContextFiles } = require('./reviewer_context_files')
const { parseSessionEnvOutput } = require('./session_env')

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

function phaseStateUnavailableReason (phase) {
  return `prove_it: phase "${phase}" could not be recorded because session state is unavailable`
}

function phaseSystemMessage (phase) {
  return `Phase set to "${phase}". This is an administrative mode switch — continue with your current task.`
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

function gitWorkflowPipeline (config, stage) {
  return config?.git_workflows?.[stage] || []
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

function sessionStartPipeline (config) {
  return config?.agent_workflows?.session_start || []
}

function sessionEnvDeliverySupported (adapterCapabilities = {}) {
  const capability = adapterCapabilities.session_env || adapterCapabilities.session_environment
  return capability === true || capability?.supported === true || capability?.delivery === 'env_update'
}

function sessionEnvDeliveryUnsupportedMessage (event) {
  return `prove_it: adapter "${event?.adapterId || event?.adapter || 'unknown'}" does not support session_env delivery; SessionStart env tasks were not run.`
}

function resolveSessionEnvRunnerPort (ports = {}) {
  return ports.task || ports.taskRunner || null
}

function invokeSessionEnvRunner (runner, runnerContext) {
  if (!runner) return null
  for (const method of ['runSessionEnvTask', 'runSessionEnv', 'sessionEnv']) {
    if (typeof runner[method] === 'function') return runner[method](runnerContext)
  }
  return null
}

function sessionEnvDiagnosticEffects (message, dependencies, fields = {}) {
  return [
    dependencies.contextInjectionEffect(message, { source: 'session_env', ...fields }),
    dependencies.failEffect(message, { source: 'session_env', ...fields })
  ]
}

function sessionEnvCommandFailedMessage (taskName, result) {
  const output = [result?.stdout, result?.stderr].filter(Boolean).join('\n').trim()
  const detailParts = [result?.reason || result?.message, output].filter(Boolean)
  const detail = detailParts.length > 0 ? detailParts.join('\n') : 'command failed'
  const exit = result?.exitCode !== undefined ? ` (exit ${result.exitCode})` : ''
  return `prove_it: session_env task "${taskName}" failed${exit}: ${detail}`
}

function runSessionEnvTaskForEffects (taskName, task, context, dependencies) {
  const runner = resolveSessionEnvRunnerPort(context.ports)
  if (!runner) {
    return sessionEnvDiagnosticEffects(
      `prove_it: session_env task "${taskName}" cannot run because no task runner port was provided.`,
      dependencies,
      { taskName }
    )
  }

  let result
  try {
    result = invokeSessionEnvRunner(runner, taskRunnerContext(taskName, task, context))
  } catch (error) {
    return sessionEnvDiagnosticEffects(
      `prove_it: session_env task "${taskName}" failed: ${error.message}`,
      dependencies,
      { taskName }
    )
  }

  if (!result || result.pass === false || result.ok === false || (Number.isInteger(result.exitCode) && result.exitCode !== 0)) {
    return sessionEnvDiagnosticEffects(sessionEnvCommandFailedMessage(taskName, result), dependencies, { taskName })
  }

  const { vars, parseError } = parseSessionEnvOutput(result.stdout || result.output || '')
  if (parseError) {
    return sessionEnvDiagnosticEffects(
      `prove_it: session_env task "${taskName}" failed to parse output: ${parseError}`,
      dependencies,
      { taskName }
    )
  }

  const names = Object.keys(vars)
  if (names.length === 0) {
    return [dependencies.contextInjectionEffect(`prove_it: session_env task "${taskName}" produced no env vars.`, {
      source: 'session_env',
      taskName
    })]
  }

  return [dependencies.envUpdateEffect(vars, {
    source: 'session_env',
    taskName
  })]
}

function runSessionStartWorkflow (config, event, options = {}) {
  const dependencies = defaultDependencies(options.dependencies)
  const effects = [
    dependencies.contextInjectionEffect(renderSessionStartGuidance(), {
      source: 'methodology'
    })
  ]

  const startupOrResume = isStartupOrResumeSessionStart(event)
  if (event?.sessionId && startupOrResume) {
    effects.push(dependencies.envUpdateEffect({
      PROVE_IT_SESSION_ID: event.sessionId
    }, {
      source: 'session_start'
    }))
  }

  const sessionEnvTasks = sessionStartPipeline(config)
  if (startupOrResume && sessionEnvTasks.length > 0) {
    if (!sessionEnvDeliverySupported(options.adapterCapabilities || {})) {
      effects.push(dependencies.contextInjectionEffect(sessionEnvDeliveryUnsupportedMessage(event), {
        source: 'session_env'
      }))
    } else {
      const context = {
        event,
        config,
        adapterCapabilities: options.adapterCapabilities || {},
        ports: options.ports || {},
        skippedTasks: []
      }
      const tasks = taskRegistry(config)
      for (const taskName of sessionEnvTasks) {
        const task = tasks[taskName]
        if (!task || task.type !== 'session_env') continue
        effects.push(...runSessionEnvTaskForEffects(taskName, task, context, dependencies))
      }
    }
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
const DEFAULT_APPEAL_THRESHOLDS = Object.freeze({
  script: 5,
  agent: 1,
  reviewer: 1
})
const OUTPUT_POLICY_FAILURES_ONLY = 'failures_only'

function taskUsesFailuresOnlyOutput (task) {
  return task?.output === OUTPUT_POLICY_FAILURES_ONLY
}

function recordRoutineTaskOutput (context, task) {
  if (!context) return
  if (taskUsesFailuresOnlyOutput(task)) context.routineOutputSuppressed = true
  else context.routineOutputVisible = true
}

function routineTaskOutputVisible (context, task) {
  recordRoutineTaskOutput(context, task)
  return !taskUsesFailuresOnlyOutput(task)
}

function finalizeRoutineOutputEffect (context, effect) {
  if (effect && context?.routineOutputSuppressed && !context?.routineOutputVisible) {
    effect.routineOutputSuppressed = true
  }
  return effect
}

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
  if (!normalized.failures || typeof normalized.failures !== 'object' || Array.isArray(normalized.failures)) {
    normalized.failures = {}
  }
  return normalized
}

function writeTaskLifecycleState (context, state) {
  return writeStateValue(context.ports?.state, context.event?.sessionId, TASK_LIFECYCLE_STATE_KEY, normalizeTaskLifecycleState(state))
}

function preserveLatestFailureState (context, lifecycle) {
  const latest = normalizeTaskLifecycleState(readTaskLifecycleState(context))
  return { ...lifecycle, failures: latest.failures }
}

function lifecycleTaskContext (taskName, task, context) {
  return taskRunnerContext(taskName, task, context)
}

function isReviewerTask (task) {
  return task?.type === 'reviewer' || task?.type === 'agent'
}

function activeAdapterId (context) {
  return context.event?.adapterId || context.event?.adapter || 'unknown'
}

function reviewerBackendMissingReason (taskName, context) {
  return `prove_it: reviewer task "${taskName}" cannot run because no reviewer backend is available for active adapter "${activeAdapterId(context)}".`
}

function reviewerProviderMismatchReason (taskName, task, context) {
  return `prove_it: reviewer task "${taskName}" requested reviewer provider "${task.provider}", but the active adapter is "${activeAdapterId(context)}". Cross-harness reviewers are not supported in this runtime.`
}

function resolveReviewerRunnerPort (ports = {}) {
  return ports.reviewer || ports.reviewerRunner || null
}

function resolveBackchannelPort (ports = {}) {
  return ports.backchannel || ports.backchannelProvider || null
}

function resolveLifecyclePortForTask (task, context) {
  return isReviewerTask(task) ? resolveReviewerRunnerPort(context.ports) : resolveTaskRunnerPort(context.ports)
}

function invokeTaskPortMethod (taskPort, names, ...args) {
  if (!taskPort) return null
  for (const name of names) {
    if (typeof taskPort[name] === 'function') return taskPort[name](...args)
  }
  return null
}

function asyncResultStatus (result) {
  if (result?.skipped || result?.skip) return 'skip'
  if (result?.pass === true || result?.ok === true || result?.effect === 'allow' || result?.effect === 'approve') return 'pass'
  return 'fail'
}

function taskFailureKey (taskName) {
  return sanitizeTaskName(taskName || 'task')
}

function taskTypeForLifecycle (task) {
  return isReviewerTask(task) ? 'reviewer' : (task?.type || 'script')
}

function defaultAppealThreshold (task) {
  return DEFAULT_APPEAL_THRESHOLDS[taskTypeForLifecycle(task)] ?? 1
}

function appealConfigForTask (task) {
  if (task?.appeal === false) return { enabled: false, threshold: defaultAppealThreshold(task) }
  if (task?.appeal && typeof task.appeal === 'object' && !Array.isArray(task.appeal)) {
    return {
      enabled: task.appeal.enabled !== false,
      threshold: task.appeal.threshold ?? defaultAppealThreshold(task)
    }
  }
  return { enabled: true, threshold: defaultAppealThreshold(task) }
}

function taskFailureState (context, taskName) {
  const lifecycle = normalizeTaskLifecycleState(readTaskLifecycleState(context))
  return lifecycle.failures[taskFailureKey(taskName)] || null
}

function taskIsSuspended (context, taskName) {
  return taskFailureState(context, taskName)?.status === 'suspended'
}

function callBackchannelPort (context, names, payload) {
  const port = resolveBackchannelPort(context.ports)
  if (!port) return null
  return invokeTaskPortMethod(port, names, payload, context)
}

function normalizeBackchannelMetadata (metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  return {
    available: metadata.available !== false,
    ...(metadata.kind ? { kind: metadata.kind } : {}),
    ...(metadata.location ? { location: metadata.location } : {}),
    ...(metadata.path ? { path: metadata.path } : {}),
    ...(metadata.appealPath ? { appealPath: metadata.appealPath } : {}),
    ...(metadata.instructions ? { instructions: metadata.instructions } : {})
  }
}

function normalizeAppealRead (appeal) {
  if (!appeal) return null
  if (typeof appeal === 'string') return appeal.trim() ? { appealText: appeal, content: appeal } : { empty: true }
  if (typeof appeal !== 'object' || Array.isArray(appeal)) return { malformed: true, reason: 'backchannel provider returned malformed appeal content' }
  return {
    content: appeal.content || appeal.backchannelContent || null,
    appealText: appeal.appealText || appeal.text || null,
    empty: appeal.empty === true,
    malformed: appeal.malformed === true,
    reason: appeal.reason || appeal.message || null
  }
}

function normalizeAppealVerdict (verdict) {
  if (!verdict) return null
  if (typeof verdict !== 'object' || Array.isArray(verdict)) return { accepted: false, reason: 'appeal evaluator returned malformed verdict' }
  return {
    accepted: verdict.accepted === true || verdict.pass === true || verdict.skip === true,
    skipped: verdict.skip === true || verdict.skipped === true,
    rejected: verdict.accepted === false || verdict.pass === false || verdict.rejected === true,
    reason: verdict.reason || verdict.message || null,
    verdict
  }
}

function appendAppealGuidance (reason, failure) {
  const backchannel = failure?.backchannel
  if (!backchannel) return reason
  const appealPath = backchannel.appealPath || backchannel.path || backchannel.location
  if (!appealPath) return reason
  return `${reason}\n\nTo appeal, write your reasoning in:\n${appealPath}`
}

function writeFailureLifecycleState (context, taskName, failure) {
  const lifecycle = normalizeTaskLifecycleState(readTaskLifecycleState(context))
  lifecycle.failures[taskFailureKey(taskName)] = failure
  writeTaskLifecycleState(context, lifecycle)
  return failure
}

function clearFailureLifecycleState (context, taskName) {
  const lifecycle = normalizeTaskLifecycleState(readTaskLifecycleState(context))
  const key = taskFailureKey(taskName)
  const previous = lifecycle.failures[key] || null
  if (previous) {
    delete lifecycle.failures[key]
    writeTaskLifecycleState(context, lifecycle)
  }
  callBackchannelPort(context, ['clearFailureChannel', 'clearBackchannel', 'clear'], {
    taskName,
    failure: previous,
    event: context.event,
    config: context.config,
    ports: context.ports
  })
  return previous
}

function failurePayload (taskName, task, result, context, failure, mode) {
  return {
    taskName,
    task,
    result,
    failure,
    mode: mode || null,
    event: context.event,
    config: context.config,
    ports: context.ports
  }
}

function createOrRefreshFailureChannel (taskName, task, result, context, failure, mode) {
  const appeal = appealConfigForTask(task)
  if (!appeal.enabled || failure.count < appeal.threshold) return failure
  const existing = failure.backchannel || null
  const created = callBackchannelPort(context, ['createFailureChannel', 'createBackchannel', 'create'], failurePayload(taskName, task, result, context, failure, mode))
  const metadata = normalizeBackchannelMetadata(created) || existing
  return metadata ? { ...failure, backchannel: metadata } : failure
}

function readTaskAppeal (taskName, task, result, context, failure, mode) {
  const appeal = appealConfigForTask(task)
  if (!appeal.enabled || failure.count < appeal.threshold) return null
  return normalizeAppealRead(callBackchannelPort(context, ['readAppeal', 'readBackchannel', 'read'], failurePayload(taskName, task, result, context, failure, mode)))
}

function suspendTaskForAppeal (taskName, task, result, context, failure, verdict, mode) {
  const suspended = {
    ...failure,
    status: 'suspended',
    count: 0,
    appeal: {
      status: 'accepted',
      reason: verdict.reason || 'appeal accepted',
      verdict: verdict.verdict || null
    }
  }
  writeFailureLifecycleState(context, taskName, suspended)
  callBackchannelPort(context, ['clearFailureChannel', 'clearBackchannel', 'clear'], failurePayload(taskName, task, result, context, suspended, mode))
  return {
    status: 'skip',
    result: { pass: true, skipped: true, reason: `${taskName} suspended by appeal: ${suspended.appeal.reason}`, output: result?.output || '' },
    reason: `${taskName} suspended by appeal: ${suspended.appeal.reason}`,
    taskFailure: suspended
  }
}

function recordTaskFailure (taskName, task, result, context, mode) {
  const previous = taskFailureState(context, taskName) || {}
  const reason = taskResultReason(result, 'task failed')
  let failure = {
    ...previous,
    taskName,
    taskType: taskTypeForLifecycle(task),
    status: 'failed',
    count: (previous.status === 'failed' ? previous.count || 0 : 0) + 1,
    lastReason: reason,
    mode: mode || null
  }

  failure = createOrRefreshFailureChannel(taskName, task, result, context, failure, mode)
  let failureReason = appendAppealGuidance(taskFailureReason(taskName, task, result, mode), failure)
  const appeal = readTaskAppeal(taskName, task, result, context, failure, mode)

  if (appeal?.malformed || appeal?.empty) {
    failure = {
      ...failure,
      appeal: {
        status: 'malformed',
        reason: appeal.reason || (appeal.empty ? 'backchannel is empty; write appeal text below the final separator' : 'backchannel content could not be parsed')
      }
    }
    writeFailureLifecycleState(context, taskName, failure)
    return {
      status: 'fail',
      reason: `${failureReason}\n\nAppeal not evaluated: ${failure.appeal.reason}`,
      taskFailure: failure
    }
  }

  if (appeal?.appealText) {
    const verdict = normalizeAppealVerdict(callBackchannelPort(context, ['evaluateAppeal', 'reviewAppeal', 'arbitrateAppeal'], {
      ...failurePayload(taskName, task, result, context, failure, mode),
      appealText: appeal.appealText,
      backchannelContent: appeal.content || null
    }))
    if (verdict?.accepted) return suspendTaskForAppeal(taskName, task, result, context, failure, verdict, mode)
    if (verdict?.rejected) {
      failure = {
        ...failure,
        appeal: {
          status: 'rejected',
          reason: verdict.reason || 'appeal rejected',
          verdict: verdict.verdict || null
        }
      }
      failureReason += `\n\nAppeal denied: ${failure.appeal.reason}`
    } else {
      failure = {
        ...failure,
        appeal: {
          status: 'pending',
          reason: 'appeal evaluator unavailable or inconclusive'
        }
      }
    }
  }

  writeFailureLifecycleState(context, taskName, failure)
  return { status: 'fail', reason: failureReason, taskFailure: failure }
}

function settleTaskLifecycleResult (taskName, task, result, context, mode) {
  const actualResult = result || { pass: false, reason: 'task produced no result' }
  const status = asyncResultStatus(actualResult)
  if (status === 'pass') {
    clearFailureLifecycleState(context, taskName)
    return {
      status,
      result: actualResult,
      reason: taskResultReason(actualResult, mode ? `${mode} task passed` : 'task passed')
    }
  }
  if (status === 'skip') {
    if (isReviewerTask(task)) clearFailureLifecycleState(context, taskName)
    return {
      status,
      result: actualResult,
      reason: taskResultReason(actualResult, mode ? `${mode} task skipped` : 'task skipped')
    }
  }
  return recordTaskFailure(taskName, task, actualResult, context, mode)
}

function taskResultReason (result, fallback) {
  return result?.reason || result?.message || result?.error?.message || result?.output || fallback
}

function taskFailureReason (taskName, task, result, mode) {
  const suffix = mode ? ` (${mode})` : ''
  if (isReviewerTask(task)) return reviewerTaskFailureReason(taskName, task, result, `Task${suffix} failed.`)
  return scriptTaskFailureReason(taskName, task, result, `Task${suffix} failed.`)
}

function taskByNameFromLifecycle (entry, context) {
  return entry?.task || taskRegistry(context.config)[entry?.taskName] || { type: 'script' }
}

function normalizeHarvestedResult (harvested, lifecyclePort = null) {
  if (!harvested || typeof harvested !== 'object') return null
  return {
    id: harvested.id || harvested.handleId || harvested.taskId || harvested.taskName,
    taskName: harvested.taskName || harvested.name || harvested.task?.name,
    task: harvested.task || null,
    result: harvested.result || harvested.taskResult || null,
    missing: harvested.missing === true || harvested.stale === true,
    reason: harvested.reason || harvested.message || null,
    lifecyclePort
  }
}

function lifecycleEntryIsReviewer (entry, context) {
  if (entry?.taskType === 'reviewer' || entry?.taskType === 'agent') return true
  const task = taskByNameFromLifecycle(entry, context)
  return isReviewerTask(task)
}

function pendingForHarvestPort (pending, port, context) {
  if (port === context.ports.reviewer) return pending.filter(entry => lifecycleEntryIsReviewer(entry, context))
  if (port === context.ports.task) return pending.filter(entry => !lifecycleEntryIsReviewer(entry, context))
  return pending
}

function consumeHarvestedBackgroundTask (harvested, task, context) {
  const lifecyclePort = harvested.lifecyclePort || resolveLifecyclePortForTask(task, context) || context.ports.task
  invokeTaskPortMethod(lifecyclePort, ['consumeBackgroundTask', 'consumeAsyncTask'], harvested, context)
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

  const harvestPorts = [...new Set([context.ports.task, context.ports.reviewer].filter(Boolean))]
  const harvestedById = new Map()
  for (const port of harvestPorts) {
    const portPending = pendingForHarvestPort(pending, port, context)
    if (portPending.length === 0) continue
    const fromPort = invokeTaskPortMethod(port, ['harvestBackgroundTasks', 'harvestAsyncTasks'], {
      pending: portPending,
      lifecycle,
      event: context.event,
      config: context.config,
      ports: context.ports
    }, context) || []
    for (const item of Array.isArray(fromPort) ? fromPort : []) {
      const normalized = normalizeHarvestedResult(item, port)
      if (normalized?.id) harvestedById.set(normalized.id, normalized)
    }
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
      consumeHarvestedBackgroundTask(harvested, task, context)
      continue
    }

    const result = harvested.result || { pass: true, skipped: true, reason: 'async task produced no result' }
    const status = asyncResultStatus(result)

    if (status === 'fail' && context.event?.stage !== 'agent_end' && options.deferFailures !== false) {
      const index = lifecycle.async.pending.findIndex(item => item.id === entry.id)
      if (index >= 0) {
        lifecycle.async.pending[index] = { ...entry, status: 'failed', result, task }
        changed = true
      }
      continue
    }

    const settled = settleTaskLifecycleResult(taskName, task, result, context, 'async')
    if (settled.status === 'fail') {
      lifecycle.async.pending = pendingWithoutId(lifecycle.async.pending, entry.id)
      changed = true
      consumeHarvestedBackgroundTask(harvested, task, context)
      blockingFailure = dependencies.blockEffect(settled.reason, { taskFailure: settled.taskFailure })
      break
    }

    lifecycle.async.pending = pendingWithoutId(lifecycle.async.pending, entry.id)
    if (routineTaskOutputVisible(context, task)) {
      asyncResults.push({
        taskName,
        status: settled.status,
        reason: settled.reason,
        output: result.output || null
      })
    }
    changed = true
    consumeHarvestedBackgroundTask(harvested, task, context)
  }

  if (changed) writeTaskLifecycleState(context, preserveLatestFailureState(context, lifecycle))
  return { asyncResults, lifecycleWarnings, blockingFailure, harvested: true }
}

function launchAsyncTask (taskName, task, context) {
  const lifecyclePort = resolveLifecyclePortForTask(task, context)
  let runnerContext
  try {
    runnerContext = lifecycleTaskContext(taskName, task, context)
  } catch (error) {
    return { failed: true, result: { pass: false, reason: error.message } }
  }
  const handle = invokeTaskPortMethod(lifecyclePort, ['launchBackgroundTask', 'startBackgroundTask', 'launchAsyncTask'], runnerContext, context)
  if (!handle) return null

  const id = handle.id || handle.handleId || handle.taskId || `${taskName}:${Date.now()}`
  const lifecycle = normalizeTaskLifecycleState(readTaskLifecycleState(context))
  const pendingEntry = {
    id,
    taskName,
    stage: context.event?.stage || null,
    status: handle.status || 'pending'
  }
  if (isReviewerTask(task)) pendingEntry.taskType = task?.type || null
  lifecycle.async.pending.push(pendingEntry)
  writeTaskLifecycleState(context, lifecycle)
  return { id, taskName, status: handle.status || 'pending' }
}

function startParallelTask (taskName, task, context) {
  const lifecyclePort = resolveLifecyclePortForTask(task, context)
  let runnerContext
  try {
    runnerContext = lifecycleTaskContext(taskName, task, context)
  } catch (error) {
    return { id: taskName, taskName, task, result: { pass: false, reason: error.message }, deferred: true, lifecyclePort }
  }
  const handle = invokeTaskPortMethod(lifecyclePort, ['startParallelTask', 'forkParallelTask'], runnerContext, context)
  if (handle) return { ...handle, taskName, task, lifecyclePort }
  return { id: taskName, taskName, task, deferred: true, lifecyclePort }
}

function settleDeferredParallelHandle (handle, context) {
  const result = handle.result || runTaskForResult(handle.taskName, handle.task, context)
  return { id: handle.id, taskName: handle.taskName, task: handle.task, result }
}

function groupHandlesByLifecyclePort (handles, context) {
  const groups = new Map()
  for (const handle of handles || []) {
    const lifecyclePort = handle.lifecyclePort || resolveLifecyclePortForTask(handle.task, context)
    if (!groups.has(lifecyclePort)) groups.set(lifecyclePort, [])
    groups.get(lifecyclePort).push(handle)
  }
  return groups
}

function settleParallelBatch (handles, context) {
  const settled = []
  for (const [lifecyclePort, portHandles] of groupHandlesByLifecyclePort(handles, context)) {
    const deferred = portHandles.filter(handle => handle.deferred)
    const started = portHandles.filter(handle => !handle.deferred)

    if (started.length > 0) {
      const portSettled = invokeTaskPortMethod(lifecyclePort, ['settleParallelBatch', 'awaitParallelBatch', 'runParallelBatch'], started, context)
      if (Array.isArray(portSettled)) settled.push(...portSettled)
      else settled.push(...started.map(handle => settleDeferredParallelHandle(handle, context)))
    }

    settled.push(...deferred.map(handle => settleDeferredParallelHandle(handle, context)))
  }
  return settled
}

function cancelTaskHandles (handles, context) {
  if (!handles || handles.length === 0) return
  for (const [lifecyclePort, portHandles] of groupHandlesByLifecyclePort(handles, context)) {
    invokeTaskPortMethod(lifecyclePort, ['cancelTasks', 'cancelParallelBatch', 'killParallelBatch'], portHandles, context)
  }
}

function cleanupTaskHandles (handles, context) {
  if (!handles || handles.length === 0) return
  for (const [lifecyclePort, portHandles] of groupHandlesByLifecyclePort(handles, context)) {
    invokeTaskPortMethod(lifecyclePort, ['cleanupTasks', 'cleanupParallelBatch'], portHandles, context)
  }
}

function pendingAsyncCancelHandles (context, lifecycle) {
  return (lifecycle.async.pending || []).map(entry => ({
    ...entry,
    task: entry.task || taskByNameFromLifecycle(entry, context),
    lifecyclePort: lifecycleEntryIsReviewer(entry, context) ? resolveReviewerRunnerPort(context.ports) : resolveTaskRunnerPort(context.ports)
  }))
}

function cancelPendingAsyncWork (context, lifecycle) {
  const handles = pendingAsyncCancelHandles(context, lifecycle)
  if (handles.length === 0) return false
  for (const [lifecyclePort, portHandles] of groupHandlesByLifecyclePort(handles, context)) {
    invokeTaskPortMethod(lifecyclePort, ['cancelBackgroundTasks', 'cancelAsyncTasks', 'cancelTasks'], portHandles, context)
    invokeTaskPortMethod(lifecyclePort, ['cleanupBackgroundTasks', 'cleanupAsyncTasks', 'cleanupTasks'], portHandles, context)
  }
  lifecycle.async.pending = []
  return true
}

function cancellationEffect (context, dependencies, cancelLifecycle) {
  const fields = {
    reason: 'prove_it: Cancelled by user',
    cancellationLifecycle: cancelLifecycle
  }
  if (context.event?.stage === 'agent_end') return dependencies.approveEffect(fields.reason, { cancellationLifecycle: cancelLifecycle })
  return dependencies.allowEffect(fields)
}

function observeCancellationCheckpoint (context, dependencies, activeHandles = []) {
  const cancelLifecycle = consumeSessionCancel(context.ports?.state, context.event?.sessionId)
  if (!cancelLifecycle.canceled) return null

  cancelTaskHandles(activeHandles, context)
  cleanupTaskHandles(activeHandles, context)

  const lifecycle = normalizeTaskLifecycleState(readTaskLifecycleState(context))
  const canceledPending = cancelPendingAsyncWork(context, lifecycle)
  if (canceledPending) writeTaskLifecycleState(context, preserveLatestFailureState(context, lifecycle))

  return cancellationEffect(context, dependencies, cancelLifecycle)
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
    const settled = settleTaskLifecycleResult(taskName, task, result, context, 'parallel')
    if (settled.status === 'fail' || routineTaskOutputVisible(context, task)) {
      parallelResults.push({
        taskName,
        status: settled.status,
        reason: settled.reason,
        output: result.output || null
      })
    }
    if (settled.status === 'fail') {
      return {
        parallelResults,
        blockingFailure: dependencies.blockEffect(settled.reason, { taskFailure: settled.taskFailure })
      }
    }
  }
  return { parallelResults, blockingFailure: null }
}

function resolveTaskRunnerPort (ports = {}) {
  return ports.task || ports.taskRunner || null
}

function taskRunnerContext (taskName, task, context) {
  const runnerContext = {
    taskName,
    task,
    event: context.event,
    normalizedEvent: context.event,
    config: context.config,
    effectiveConfig: context.config,
    adapterCapabilities: context.adapterCapabilities || {},
    statePort: context.ports?.state || null,
    taskPort: context.ports?.task || null,
    reviewerPort: context.ports?.reviewer || null,
    backchannelPort: context.ports?.backchannel || null,
    effectPort: context.ports?.effect || null,
    observationPort: context.ports?.observations || null,
    taskFailure: taskFailureState(context, taskName),
    ports: context.ports || {}
  }
  return isReviewerTask(task) ? attachReviewerContextFiles(runnerContext) : runnerContext
}

function recordSkippedTask (context, taskName, task, result) {
  if (!routineTaskOutputVisible(context, task)) return
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
  const fields = {}
  if (context.skippedTasks && context.skippedTasks.length > 0) fields.skipped = context.skippedTasks
  if (context.contextParts && context.contextParts.length > 0) fields.reason = context.contextParts.join('\n\n')
  return Object.keys(fields).length > 0 ? dependencies.allowEffect(fields) : dependencies.allowEffect()
}

function recordAllowContext (context, effect) {
  if (!effect?.reason && !effect?.message) return
  if (!context.contextParts) context.contextParts = []
  context.contextParts.push(effect.reason || effect.message)
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

function reviewerTaskFailureReason (taskName, task, result, fallback) {
  const detail = result?.reason || result?.message || result?.error?.message || fallback
  const body = result?.body ? `\n\n${result.body}` : ''
  return `prove_it: reviewer task "${taskName}" failed. ${detail}${body}`
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

  const normalized = result || { pass: false, reason: 'Task runner returned no pass/fail result.' }
  const settled = settleTaskLifecycleResult(taskName, task, normalized, context, null)
  if (settled.status === 'pass' || settled.status === 'skip') {
    if (!routineTaskOutputVisible(context, task)) return dependencies.allowEffect()
    return normalized.output ? dependencies.allowEffect({ reason: normalized.output }) : dependencies.allowEffect()
  }
  return dependencies.blockEffect(settled.reason, { taskFailure: settled.taskFailure })
}

function reviewerTaskProviderAllowed (task, context) {
  return !task?.provider || task.provider === activeAdapterId(context)
}

function invokeReviewerRunner (runner, context) {
  return invokeTaskRunner(runner, context)
}

function runReviewerTask (taskName, task, context, dependencies) {
  if (!reviewerTaskProviderAllowed(task, context)) {
    return dependencies.blockEffect(reviewerProviderMismatchReason(taskName, task, context))
  }

  const runner = resolveReviewerRunnerPort(context.ports)
  if (!runner) return dependencies.blockEffect(reviewerBackendMissingReason(taskName, context))

  let result
  try {
    result = invokeReviewerRunner(runner, taskRunnerContext(taskName, task, context))
  } catch (error) {
    return dependencies.blockEffect(reviewerTaskFailureReason(taskName, task, {
      reason: error.message
    }, 'Reviewer runner threw an error.'))
  }

  const normalized = result || { pass: false, reason: 'Reviewer runner returned no pass/fail verdict.' }
  if (task.failure_behavior === 'warn' && asyncResultStatus(normalized) === 'fail') {
    return dependencies.allowEffect({ reason: reviewerTaskFailureReason(taskName, task, normalized, 'Reviewer reported a warning.') })
  }

  const settled = settleTaskLifecycleResult(taskName, task, normalized, context, null)
  if (settled.status === 'pass' || settled.status === 'skip') {
    recordRoutineTaskOutput(context, task)
    return dependencies.allowEffect()
  }
  return dependencies.blockEffect(settled.reason, { taskFailure: settled.taskFailure })
}

function runTaskForResult (taskName, task, context) {
  const runner = isReviewerTask(task) ? resolveReviewerRunnerPort(context.ports) : resolveTaskRunnerPort(context.ports)
  if (!runner) {
    return {
      pass: false,
      reason: isReviewerTask(task)
        ? reviewerBackendMissingReason(taskName, context)
        : `prove_it: script task "${taskName}" cannot run because no task runner port was provided.`
    }
  }
  if (isReviewerTask(task) && !reviewerTaskProviderAllowed(task, context)) {
    return { pass: false, reason: reviewerProviderMismatchReason(taskName, task, context) }
  }
  try {
    return invokeTaskRunner(runner, taskRunnerContext(taskName, task, context))
  } catch (error) {
    return { pass: false, reason: error.message }
  }
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
    signalLifecycle,
    ...(effect?.taskFailure ? { taskFailure: effect.taskFailure } : {})
  }

  if (isHardBlock(behavior)) return dependencies.failEffect(reason, fields)
  if (isRemediation(behavior)) return dependencies.remediationEffect(reason, fields)
  return dependencies.remediationEffect(reason, { ...fields, enforcement: fields.enforcement || 'unsupported' })
}

function completionPassEffect (context, dependencies) {
  const behavior = completionVerificationBehavior(context.adapterCapabilities)
  const signalLifecycle = settleSignalAfterVerification(context.ports.state, context.event.sessionId, true)
  const phaseLifecycle = signalLifecycle?.signal?.type === 'done'
    ? setLifecyclePhase(context.ports.state, context.event.sessionId, 'unknown')
    : null
  return dependencies.approveEffect('prove_it: completion verification passed.', {
    capability: 'completion_verification',
    enforcement: behavior?.strength || behavior?.mode || null,
    signalLifecycle,
    ...(phaseLifecycle ? { phaseLifecycle } : {})
  })
}

function runAgentEndWorkflow (config, event, options = {}) {
  const dependencies = defaultDependencies(options.dependencies)
  if (!config) return dependencies.allowEffect()

  const ports = options.ports || {
    task: options.taskPort || options.taskRunnerPort || null,
    reviewer: options.reviewerPort || options.reviewerRunnerPort || null,
    backchannel: options.backchannelPort || options.backchannelProviderPort || null,
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

  const canceledBeforeWork = observeCancellationCheckpoint(context, dependencies)
  if (canceledBeforeWork) return canceledBeforeWork

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
    if (taskIsSuspended(context, taskName)) {
      recordSkippedTask(context, taskName, task, { reason: 'suspended by appeal', semantics: 'task_lifecycle.suspended' })
      continue
    }
    if (!agentEndTaskCanRunForSignal(task, signal)) continue
    const whenResult = evaluateWhen(task.when, context, taskName)
    if (!whenResult.passed) {
      recordSkippedTask(context, taskName, task, whenResult)
      continue
    }
    if (task.async === true) {
      const handle = launchAsyncTask(taskName, task, context)
      if (handle?.failed) {
        return completionFailureEffect(dependencies.blockEffect(taskFailureReason(taskName, task, handle.result, 'async')), context, dependencies)
      }
      if (!handle && isReviewerTask(task)) {
        return completionFailureEffect(dependencies.blockEffect(reviewerBackendMissingReason(taskName, context)), context, dependencies)
      }
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      continue
    }
    if (task.parallel === true) {
      parallelBatch.push(startParallelTask(taskName, task, context))
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      continue
    }
    if (task.type === 'script') {
      const effect = runScriptTask(taskName, task, context, dependencies)
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      if (effect.effect === 'block' || effect.effect === 'fail') {
        cancelTaskHandles(parallelBatch, context)
        cleanupTaskHandles(parallelBatch, context)
        return completionFailureEffect(effect, context, dependencies)
      }
    } else if (isReviewerTask(task)) {
      const effect = runReviewerTask(taskName, task, context, dependencies)
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      if (effect.effect === 'block' || effect.effect === 'fail') {
        cancelTaskHandles(parallelBatch, context)
        cleanupTaskHandles(parallelBatch, context)
        return completionFailureEffect(effect, context, dependencies)
      }
    }
  }

  const canceledBeforeSettle = observeCancellationCheckpoint(context, dependencies, parallelBatch)
  if (canceledBeforeSettle) return canceledBeforeSettle

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
  return finalizeRoutineOutputEffect(context, effect)
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
      reviewer: options.reviewerPort || options.reviewerRunnerPort || null,
      backchannel: options.backchannelPort || options.backchannelProviderPort || null,
      effect: options.effectPort || options.effectsPort || null,
      state: options.statePort || null,
      observations: options.observationPort || options.observationsPort || null
    },
    skippedTasks: [],
    contextParts: []
  }

  const canceledBeforeWork = observeCancellationCheckpoint(context, dependencies)
  if (canceledBeforeWork) return canceledBeforeWork

  const harvested = harvestAsyncTasks(context, dependencies)
  if (harvested.blockingFailure) return harvested.blockingFailure

  const parallelBatch = []
  const tasks = taskRegistry(config)
  for (const taskName of pipeline) {
    const task = tasks[taskName]
    if (!task || !taskMatchesEvent(task, event)) continue
    if (taskIsSuspended(context, taskName)) {
      recordSkippedTask(context, taskName, task, { reason: 'suspended by appeal', semantics: 'task_lifecycle.suspended' })
      continue
    }
    const whenResult = evaluateWhen(task.when, context, taskName)
    if (!whenResult.passed) {
      recordSkippedTask(context, taskName, task, whenResult)
      continue
    }
    if (task.async === true && event?.stage !== 'session_start') {
      const handle = launchAsyncTask(taskName, task, context)
      if (handle?.failed) return dependencies.blockEffect(taskFailureReason(taskName, task, handle.result, 'async'))
      if (!handle && isReviewerTask(task)) return dependencies.blockEffect(reviewerBackendMissingReason(taskName, context))
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      continue
    }
    if (task.parallel === true && event?.stage !== 'session_start') {
      parallelBatch.push(startParallelTask(taskName, task, context))
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      continue
    }
    if (task.type === 'config_guard') {
      const effect = evaluateConfigGuard(task, event, { dependencies })
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      if (effect.effect === 'block') {
        cancelTaskHandles(parallelBatch, context)
        cleanupTaskHandles(parallelBatch, context)
        return effect
      }
      recordRoutineTaskOutput(context, task)
      recordAllowContext(context, effect)
    } else if (task.type === 'script') {
      const effect = runScriptTask(taskName, task, context, dependencies)
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      if (effect.effect === 'block' || effect.effect === 'fail') {
        cancelTaskHandles(parallelBatch, context)
        cleanupTaskHandles(parallelBatch, context)
        return effect
      }
      recordAllowContext(context, effect)
    } else if (isReviewerTask(task)) {
      const effect = runReviewerTask(taskName, task, context, dependencies)
      const canceled = observeCancellationCheckpoint(context, dependencies, parallelBatch)
      if (canceled) return canceled
      if (effect.effect === 'block' || effect.effect === 'fail') {
        cancelTaskHandles(parallelBatch, context)
        cleanupTaskHandles(parallelBatch, context)
        return effect
      }
      recordAllowContext(context, effect)
    }
  }

  const canceledBeforeSettle = observeCancellationCheckpoint(context, dependencies, parallelBatch)
  if (canceledBeforeSettle) return canceledBeforeSettle

  const parallel = settleParallelResults(parallelBatch, context, dependencies)
  if (parallel.blockingFailure) return parallel.blockingFailure

  const effect = allowWithSkippedTasks(context, dependencies)
  if (harvested.harvested || harvested.asyncResults.length > 0) effect.asyncResults = harvested.asyncResults
  if (harvested.lifecycleWarnings.length > 0) effect.lifecycleWarnings = harvested.lifecycleWarnings
  if (parallel.parallelResults.length > 0) effect.parallelResults = parallel.parallelResults
  return finalizeRoutineOutputEffect(context, effect)
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

function runGitWorkflow (config, event, options = {}) {
  return runTaskStageWorkflow(config, event, gitWorkflowPipeline(config, event?.stage), options)
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
  reviewerPort = null,
  reviewerRunnerPort = null,
  backchannelPort = null,
  backchannelProviderPort = null,
  observationPort = null,
  observationsPort = null,
  dependencies = {}
} = {}) {
  const workflowConfig = effectiveConfig || config
  const ports = {
    state: statePort,
    task: taskPort || taskRunnerPort,
    reviewer: reviewerPort || reviewerRunnerPort,
    backchannel: backchannelPort || backchannelProviderPort,
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
    if (String(event.toolName || '').toLowerCase() === 'enterplanmode') {
      setLifecyclePhase(ports.state, event.sessionId, 'plan')
    }

    const signalCommand = isBashTool(event.toolName) ? parseSignalCommand(event.command) : null
    const phaseCommand = isBashTool(event.toolName) ? parsePhaseCommand(event.command) : null
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
    } else if (phaseCommand?.matched && phaseCommand.valid) {
      const result = setLifecyclePhase(ports.state, event.sessionId, phaseCommand.phase)
      const systemMessage = phaseSystemMessage(phaseCommand.phase)
      effect = deps.allowEffect({
        reason: result.ok
          ? `prove_it: phase "${phaseCommand.phase}" recorded\n\n${systemMessage}`
          : phaseStateUnavailableReason(phaseCommand.phase),
        systemMessage,
        phase: result.phase,
        phaseLifecycle: result
      })
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
  } else if (event?.stage === 'pre_commit' || event?.stage === 'pre_push') {
    effect = runGitWorkflow(workflowConfig, event, {
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
  runGitWorkflow,
  runPostToolFailureWorkflow,
  runPostToolWorkflow,
  runPreToolWorkflow,
  runSessionStartWorkflow,
  runWorkflowEngine,
  toProjectRelativePath
}
