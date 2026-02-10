const { expandTemplate, getUnknownVars, getSessionVars } = require('../template')
const { BUILTIN_PROMPTS } = require('./builtins')
const { runReviewer } = require('../reviewer')
const { logReview } = require('../session')

/**
 * Run an agent check.
 *
 * @param {object} check - Check config { name, command, prompt, promptType, timeout }
 * @param {object} context - { rootDir, projectDir, sessionId, toolInput, hookEvent, testOutput }
 * @returns {{ pass: boolean, reason: string, output: string, skipped: boolean }}
 */
function runAgentCheck (check, context) {
  const { rootDir, projectDir, sessionId } = context
  const command = check.command || 'claude -p'
  const timeout = check.timeout || 120000

  // Resolve prompt — either inline string or builtin reference
  let promptTemplate = check.prompt
  if (check.promptType === 'reference') {
    promptTemplate = BUILTIN_PROMPTS[check.prompt]
    if (!promptTemplate) {
      return { pass: false, reason: `unknown prompt reference "${check.prompt}"`, output: '', skipped: false }
    }
  }

  // Reject unknown template variables
  const unknownVars = getUnknownVars(promptTemplate)
  if (unknownVars.length > 0) {
    return { pass: false, reason: `unknown template variable(s): {{${unknownVars.join('}}, {{')}}}`, output: '', skipped: false }
  }

  // Reject session-dependent vars when no session is available
  if (!context.sessionId) {
    const sessionVars = getSessionVars(promptTemplate)
    if (sessionVars.length > 0) {
      return { pass: false, reason: `{{${sessionVars.join('}}, {{')}}} require a Claude Code session but session_id is null (git hooks don't have sessions)`, output: '', skipped: false }
    }
  }

  // Expand template variables in the prompt
  const userPrompt = expandTemplate(promptTemplate, context)

  if (!userPrompt || !userPrompt.trim()) {
    return { pass: true, reason: 'empty prompt — skipped', output: '', skipped: true }
  }

  // Wrap with format enforcement so the model always outputs PASS or FAIL: <reason>
  const prompt = `You are a code reviewer. Your ENTIRE response must be one of:\n- PASS: <brief reasoning>\n- FAIL: <one-line reason>\n\nDo not explain further. Just PASS or FAIL with a brief reason.\n\n${userPrompt}`

  const reviewerCfg = { command, timeout }
  const review = runReviewer(rootDir, reviewerCfg, prompt)

  if (!review.available) {
    const reason = `${review.binary || 'reviewer'} not found`
    logReview(sessionId, projectDir, check.name, 'SKIP', reason)
    return { pass: true, reason: `⚠ ${check.name}: ${reason}`, output: '', skipped: true }
  }

  if (review.error) {
    logReview(sessionId, projectDir, check.name, 'CRASH', review.error)
    return { pass: true, reason: `⚠ ${check.name} crashed: ${review.error}`, output: '', skipped: true }
  }

  if (review.pass === false) {
    logReview(sessionId, projectDir, check.name, 'FAIL', review.reason)
    return { pass: false, reason: review.reason, output: '', skipped: false }
  }

  logReview(sessionId, projectDir, check.name, 'PASS', review.reason)
  return { pass: true, reason: review.reason, output: '', skipped: false }
}

module.exports = { runAgentCheck }
