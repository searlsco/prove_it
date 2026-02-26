const fs = require('fs')
const path = require('path')
const { sanitizeTaskName } = require('../io')
const { backchannelDir, readBackchannel, cleanBackchannel } = require('./agent')
const { extractAppealText } = require('../monitor')
const { runReviewer } = require('../reviewer')
const { saveSessionState, loadSessionState, logReview } = require('../session')

const APPEAL_THRESHOLD = 5

function backchannelReadmePath (rootDir, sessionId, taskName) {
  return path.join(backchannelDir(rootDir, sessionId, taskName), 'README.md')
}

function recordFailure (sessionId, taskName) {
  if (!sessionId) return 0
  const failures = loadSessionState(sessionId, 'successiveFailures') || {}
  const key = sanitizeTaskName(taskName)
  const count = (failures[key] || 0) + 1
  failures[key] = count
  saveSessionState(sessionId, 'successiveFailures', failures)
  return count
}

function resetFailures (sessionId, taskName) {
  if (!sessionId) return
  const failures = loadSessionState(sessionId, 'successiveFailures') || {}
  const key = sanitizeTaskName(taskName)
  failures[key] = 0
  saveSessionState(sessionId, 'successiveFailures', failures)
}

function isTaskSuspended (sessionId, taskName) {
  if (!sessionId) return false
  const suspended = loadSessionState(sessionId, 'suspended') || []
  return suspended.includes(sanitizeTaskName(taskName))
}

function suspendTask (sessionId, taskName) {
  if (!sessionId) return
  const suspended = loadSessionState(sessionId, 'suspended') || []
  const key = sanitizeTaskName(taskName)
  if (!suspended.includes(key)) {
    suspended.push(key)
    saveSessionState(sessionId, 'suspended', suspended)
  }
}

function createScriptBackchannel (rootDir, sessionId, taskName, failureReason, command) {
  if (!sessionId) return
  try {
    const readmePath = backchannelReadmePath(rootDir, sessionId, taskName)
    if (fs.existsSync(readmePath)) return
    const dir = backchannelDir(rootDir, sessionId, taskName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(readmePath, `# Script Appeal—${taskName}

The script task **${taskName}** (\`${command}\`) has failed ${APPEAL_THRESHOLD} consecutive times.

Latest failure output:

${failureReason.split('\n').map(l => '> ' + l).join('\n')}

---

If you believe this failure is not caused by your code changes (e.g., flaky test,
environment issue, pre-existing failure), write your reasoning below.

An AI arbiter will evaluate your appeal and may suspend this task for the
remainder of the session.

Recommend one of:
- **PASS**—failure is environmental / pre-existing / not caused by my changes
- **SKIP**—mid-task, will address before done, suspend for now

A SUPERVISORY AGENT WILL ASSESS THE HONESTY AND INTEGRITY OF YOUR
RESPONSE. DO NOT ATTEMPT TO LIE OR MANIPULATE TO BYPASS THE CHECK.

Write your recommendation and reasoning below this line:

---
`)
  } catch (_) {}
}

function evaluateAppeal (rootDir, sessionId, taskName, scriptOutput, command, failCount) {
  const backchannelContent = readBackchannel(rootDir, sessionId, taskName)
  if (!backchannelContent) return null

  const appealText = extractAppealText(backchannelContent)
  if (!appealText) return null

  const prompt = `You are an arbiter evaluating whether a script task should be suspended.

A script task has failed ${failCount} consecutive times. The developer has appealed
the failure. Your job is to assess whether the appeal is honest and reasonable.

## Script
Command: \`${command}\`

## Latest script output (may be truncated)
${(scriptOutput || '(no output)').slice(0, 4000)}

## Developer's appeal
${appealText}

## Instructions

Evaluate the developer's reasoning. Consider:
1. Is the appeal honest and specific? (Not vague hand-waving)
2. Is it plausible that the failure is environmental, pre-existing, or unrelated?
3. Would suspending this task for the session be a reasonable decision?

Your first word must be PASS, FAIL, or SKIP. Then explain your reasoning briefly.

PASS—suspend the task for the rest of this session (appeal is compelling)
FAIL—deny the appeal (developer should fix the issue)
SKIP—suspend the task (benefit of the doubt / unclear situation)`

  const reviewerCfg = { model: 'haiku' }
  const review = runReviewer(rootDir, reviewerCfg, prompt)

  return { review, prompt, appealText, backchannelContent }
}

/**
 * Orchestrator for the script appeal flow.
 *
 * Called after a script task fails. Manages failure counting, backchannel
 * creation, and arbiter invocation.
 *
 * @param {object} task - Task config { name, command, ... }
 * @param {object} result - Script result { pass, reason, output }
 * @param {object} context - Dispatch context { rootDir, projectDir, sessionId, hookEvent }
 * @returns {object} Possibly-modified result
 */
function handleScriptAppeal (task, result, context) {
  const { rootDir, projectDir, sessionId, hookEvent } = context

  // No session = no appeal system
  if (!sessionId) return result

  const failCount = recordFailure(sessionId, task.name)

  // Below threshold: normal blocking
  if (failCount < APPEAL_THRESHOLD) return result

  // At threshold: create backchannel if it doesn't exist
  if (failCount === APPEAL_THRESHOLD) {
    createScriptBackchannel(rootDir, sessionId, task.name, result.reason, task.command)
    const bcDir = backchannelDir(rootDir, sessionId, task.name)
    result.reason += '\n\n' +
      `This task has failed ${failCount} consecutive times. You may appeal this failure.\n` +
      `To appeal, write your reasoning in:\n${bcDir}/README.md`
    return result
  }

  // Above threshold: check for appeal
  const appeal = evaluateAppeal(rootDir, sessionId, task.name, result.output, task.command, failCount)

  // No appeal written yet: keep blocking, remind about backchannel
  if (!appeal) {
    const bcDir = backchannelDir(rootDir, sessionId, task.name)
    result.reason += '\n\n' +
      `This task has failed ${failCount} consecutive times. You may appeal this failure.\n` +
      `To appeal, write your reasoning in:\n${bcDir}/README.md`
    return result
  }

  // Log the plea
  logReview(sessionId, projectDir, task.name, 'PLEA', 'appealed via backchannel', null, hookEvent, {
    verbose: { backchannelContent: appeal.backchannelContent }
  })

  const { review, prompt } = appeal

  // Arbiter couldn't run (claude not available, etc.)
  if (!review.available) {
    return result
  }

  // Arbiter errored
  if (review.error) {
    logReview(sessionId, projectDir, task.name, 'BOOM', `arbiter error: ${review.error}`, null, hookEvent, {
      verbose: { prompt, response: review.responseText || null }
    })
    return result
  }

  // Arbiter PASS or SKIP: suspend the task
  if (review.pass || review.skip) {
    const verdict = review.skip ? 'SKIP' : 'PASS'
    logReview(sessionId, projectDir, task.name, verdict, `arbiter: ${review.reason}`, null, hookEvent, {
      verbose: { prompt, response: review.responseText || null, failCount }
    })
    suspendTask(sessionId, task.name)
    resetFailures(sessionId, task.name)
    cleanBackchannel(rootDir, sessionId, task.name)
    return {
      pass: true,
      reason: `${task.name} suspended by arbiter: ${review.reason}`,
      output: result.output,
      skipped: true
    }
  }

  // Arbiter FAIL: deny appeal, keep blocking
  logReview(sessionId, projectDir, task.name, 'FAIL', `arbiter denied appeal: ${review.reason}`, null, hookEvent, {
    verbose: { prompt, response: review.responseText || null, failCount }
  })
  result.reason += `\n\nAppeal denied by arbiter: ${review.reason}`
  return result
}

module.exports = {
  APPEAL_THRESHOLD,
  recordFailure,
  resetFailures,
  isTaskSuspended,
  suspendTask,
  createScriptBackchannel,
  evaluateAppeal,
  handleScriptAppeal
}
