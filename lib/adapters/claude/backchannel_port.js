const path = require('path')

const { createBackchannel, cleanBackchannel, readBackchannel } = require('../../checks/agent')
const { APPEAL_THRESHOLD, createScriptBackchannel } = require('../../checks/arbiter')
const { backchannelDir, backchannelReadmePath, backchannelPrefix } = require('../../paths')
const { extractAppealText } = require('../../monitor')
const reviewer = require('../../reviewer')

function rootDirFromPayload (payload = {}) {
  return payload.event?.rootDir || payload.event?.projectDir || payload.event?.cwd || process.cwd()
}

function sessionIdFromPayload (payload = {}) {
  return payload.event?.sessionId || null
}

function taskCommand (task = {}) {
  return task.command || '(no command)'
}

function failureReport (result = {}) {
  return result.body ? `${result.reason || 'task failed'}\n\n${result.body}` : (result.reason || result.output || 'task failed')
}

function channelMetadata (rootDir, sessionId, taskName) {
  if (!sessionId) return null
  return {
    kind: 'claude_filesystem',
    location: backchannelDir(rootDir, sessionId, taskName),
    appealPath: backchannelReadmePath(rootDir, sessionId, taskName)
  }
}

function createFailureChannel (payload = {}) {
  const rootDir = rootDirFromPayload(payload)
  const sessionId = sessionIdFromPayload(payload)
  if (!sessionId) return null

  if (payload.task?.type === 'script') {
    createScriptBackchannel(rootDir, sessionId, payload.taskName, failureReport(payload.result), taskCommand(payload.task))
  } else {
    createBackchannel(rootDir, sessionId, payload.taskName, failureReport(payload.result))
  }
  return channelMetadata(rootDir, sessionId, payload.taskName)
}

function readAppeal (payload = {}) {
  const rootDir = rootDirFromPayload(payload)
  const sessionId = sessionIdFromPayload(payload)
  if (!sessionId) return null
  const content = readBackchannel(rootDir, sessionId, payload.taskName)
  if (!content) return null
  if (!content.includes('\n---\n')) {
    return { malformed: true, content, reason: 'backchannel README is missing the appeal separator; write appeal text below the final --- line' }
  }
  const appealText = extractAppealText(content)
  if (!appealText) return { empty: true, content, reason: 'backchannel is empty; write appeal text below the final --- line' }
  return { content, appealText }
}

function evaluateAppeal (payload = {}) {
  if (payload.task?.type !== 'script') return null
  const rootDir = rootDirFromPayload(payload)
  const failCount = payload.failure?.count || APPEAL_THRESHOLD
  const prompt = `You are an arbiter evaluating whether a script task should be suspended.

A script task has failed ${failCount} consecutive times. The developer has appealed
the failure. Your job is to assess whether the appeal is honest and reasonable.

## Script
Command: \`${taskCommand(payload.task)}\`

## Latest script output (may be truncated)
${(payload.result?.output || payload.result?.reason || '(no output)').slice(0, 4000)}

## Developer's appeal
${payload.appealText}

## Instructions

Evaluate the developer's reasoning. Consider:
1. Is the appeal honest and specific? (Not vague hand-waving)
2. Is it plausible that the failure is environmental, pre-existing, or unrelated?
3. Would suspending this task for the session be a reasonable decision?

Your first word must be PASS, FAIL, or SKIP. Then explain your reasoning briefly.

PASS—suspend the task for the rest of this session (appeal is compelling)
FAIL—deny the appeal (developer should fix the issue)
SKIP—suspend the task (benefit of the doubt / unclear situation)`

  const review = reviewer.runReviewer(rootDir, { model: 'haiku' }, prompt)
  if (!review.available || review.error) return null
  if (review.pass || review.skip) return { accepted: true, skip: true, reason: review.reason || 'appeal accepted', review, prompt }
  return { accepted: false, reason: review.reason || 'appeal rejected', review, prompt }
}

function clearFailureChannel (payload = {}) {
  const rootDir = rootDirFromPayload(payload)
  const sessionId = sessionIdFromPayload(payload)
  if (!sessionId) return false
  cleanBackchannel(rootDir, sessionId, payload.taskName)
  return true
}

function targetPathFromEvent (event = {}) {
  return event.toolInput?.file_path || event.toolInput?.notebook_path || ''
}

function isBackchannelWriteAllowed (event = {}) {
  if (event.stage !== 'pre_tool' || !event.sessionId) return false
  const toolName = String(event.toolName || '').toLowerCase()
  if (!['write', 'edit', 'multiedit', 'multi_edit', 'notebookedit', 'notebook_edit'].includes(toolName)) return false
  const targetPath = targetPathFromEvent(event)
  if (!targetPath || !path.isAbsolute(targetPath)) return false
  const rootDir = event.rootDir || event.projectDir || event.cwd || process.cwd()
  const roots = [rootDir]
  try {
    const realRoot = require('fs').realpathSync(rootDir)
    if (!roots.includes(realRoot)) roots.push(realRoot)
  } catch {}
  const resolvedTarget = path.resolve(targetPath)
  return roots.some(root => resolvedTarget.startsWith(backchannelPrefix(root, event.sessionId) + path.sep))
}

function createClaudeBackchannelPort () {
  return {
    createFailureChannel,
    readAppeal,
    evaluateAppeal,
    clearFailureChannel,
    isBackchannelWriteAllowed
  }
}

module.exports = {
  createClaudeBackchannelPort,
  createFailureChannel,
  readAppeal,
  evaluateAppeal,
  clearFailureChannel,
  isBackchannelWriteAllowed
}
