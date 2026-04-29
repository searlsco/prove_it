const fs = require('fs')
const path = require('path')
const { fork } = require('child_process')

const { DEFAULT_ALLOWED_TOOLS } = require('../../defaults')
const { ensureDir, sanitizeTaskName } = require('../../io')
const { getAsyncDir } = require('../../session')
const { runAgentCheck } = require('../../checks/agent')
const { consumeBackgroundScriptTask, harvestBackgroundScriptTasks, scriptContextFromWorkflowContext } = require('../../redesign/script_task_port')

function providerOptions (task = {}) {
  return task.provider_options || {}
}

function reviewerTaskPrompt (task = {}) {
  return task.prompt || task.intent || ''
}

function isCodexModel (model) {
  return model != null && /^gpt-/i.test(model)
}

function commandBinaryName (command) {
  if (!command) return 'claude'
  const binary = String(command).trim().split(/\s+/)[0] || ''
  return path.basename(binary).replace(/^['"]|['"]$/g, '')
}

function claudeHarnessViolationReason (task = {}) {
  if (isCodexModel(task.model)) {
    return `Claude reviewer task requested Codex model "${task.model}" from the active Claude harness. Cross-harness reviewers are not supported in this runtime.`
  }

  const command = providerOptions(task).command
  if (command && commandBinaryName(command) !== 'claude') {
    return `Claude reviewer task requested command "${command}" from the active Claude harness. Cross-harness reviewers are not supported in this runtime.`
  }

  return null
}

function reviewerTaskToAgentCheck (taskName, task = {}) {
  const options = providerOptions(task)
  const prompt = reviewerTaskPrompt(task)
  const skillMatch = /^skill:([A-Za-z0-9_.-]+)$/.exec(prompt)
  return {
    name: taskName,
    type: 'agent',
    prompt: skillMatch ? skillMatch[1] : prompt,
    ...(skillMatch ? { promptType: 'skill' } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(options.max_turns != null ? { maxAgentTurns: options.max_turns } : {}),
    ...(options.command ? { command: options.command } : {}),
    ...(task.timeout_ms != null ? { timeout: task.timeout_ms } : {}),
    ...(task.output === 'failures_only' ? { quiet: true } : {})
  }
}

function claudeReviewerContextFromWorkflowContext (context) {
  const base = scriptContextFromWorkflowContext(context)
  const options = providerOptions(context.task)
  return {
    ...base,
    hookEvent: context.event?.rawEventName || context.event?.stage,
    configModel: null,
    configMaxAgentTurns: options.max_turns,
    taskAllowedTools: options.allowed_tools || DEFAULT_ALLOWED_TOOLS,
    taskBypassPermissions: options.bypass_permissions === true,
    configEnv: options.env || {},
    reviewerContextFiles: context.contextFiles || context.reviewerContextFiles || []
  }
}

function verdictStatus (result = {}) {
  if (result.skipped || result.skip) return 'skip'
  if (result.pass === true || result.ok === true) return 'pass'
  return 'fail'
}

function normalizeClaudeReviewerResult (result = {}, context = {}) {
  const status = verdictStatus(result)
  const reason = result.reason || result.message || (status === 'skip' ? 'review skipped' : status === 'pass' ? 'review passed' : 'review failed')
  const body = result.body || null
  const output = result.output || result.responseText || ''
  return {
    pass: status !== 'fail',
    ...(status === 'skip' ? { skipped: true } : {}),
    reason,
    output,
    ...(body ? { body } : {}),
    verdict: {
      status,
      reason,
      body,
      evidence: result.evidence === undefined ? (body || output || null) : result.evidence,
      transcript: result.transcript || { sessionId: context.event?.sessionId || null }
    }
  }
}

function runClaudeReviewerTask (context, options = {}) {
  const violationReason = claudeHarnessViolationReason(context.task)
  if (violationReason) {
    return normalizeClaudeReviewerResult({ pass: false, reason: violationReason, output: '' }, context)
  }

  const run = options.runAgentCheck || runAgentCheck
  const check = reviewerTaskToAgentCheck(context.taskName, context.task)
  const agentContext = claudeReviewerContextFromWorkflowContext(context)
  return normalizeClaudeReviewerResult(run(check, agentContext), context)
}

function asyncSnapshotForReviewerTask (context, options = {}) {
  const sessionId = context.event?.sessionId || null
  const asyncDir = options.asyncDir || getAsyncDir(sessionId)
  if (!asyncDir) return null

  const taskFile = `${sanitizeTaskName(context.taskName)}-${Date.now()}-${process.pid}`
  const contextFilePath = path.join(asyncDir, `${taskFile}.context.json`)
  const resultPath = path.join(asyncDir, `${taskFile}.json`)
  const snapshot = {
    task: reviewerTaskToAgentCheck(context.taskName, context.task),
    context: claudeReviewerContextFromWorkflowContext(context),
    resultPath
  }

  ensureDir(asyncDir)
  fs.writeFileSync(contextFilePath, JSON.stringify(snapshot, null, 2), 'utf8')
  return { contextFilePath, resultPath }
}

function launchBackgroundClaudeReviewerTask (context, options = {}) {
  if (claudeHarnessViolationReason(context.task)) return null

  const snapshot = asyncSnapshotForReviewerTask(context, options)
  if (!snapshot) return null

  const workerPath = options.workerPath || path.join(__dirname, '..', '..', 'async_worker.js')
  const child = fork(workerPath, [snapshot.contextFilePath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  })
  child.unref()
  return { id: snapshot.resultPath, status: 'pending' }
}

function createClaudeReviewerPort (options = {}) {
  return {
    run (context) {
      return runClaudeReviewerTask(context, options)
    },
    launchBackgroundTask (context) {
      return launchBackgroundClaudeReviewerTask(context, options)
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
  asyncSnapshotForReviewerTask,
  claudeHarnessViolationReason,
  claudeReviewerContextFromWorkflowContext,
  createClaudeReviewerPort,
  launchBackgroundClaudeReviewerTask,
  normalizeClaudeReviewerResult,
  reviewerTaskToAgentCheck,
  runClaudeReviewerTask
}
