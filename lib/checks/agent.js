const { expandTemplate } = require('../template')
const { runReviewer } = require('../reviewer')
const { logReview } = require('../session')

/**
 * Run an agent check.
 *
 * @param {object} check - Check config { name, command, prompt, timeout }
 * @param {object} context - { rootDir, projectDir, sessionId, toolInput, hookEvent, testOutput }
 * @returns {{ pass: boolean, reason: string, output: string, skipped: boolean }}
 */
function runAgentCheck (check, context) {
  const { rootDir, projectDir, sessionId } = context
  const command = check.command || 'claude -p'
  const timeout = check.timeout || 120000

  // Expand template variables in the prompt
  const userPrompt = expandTemplate(check.prompt, context)

  if (!userPrompt || !userPrompt.trim()) {
    return { pass: true, reason: 'empty prompt — skipped', output: '', skipped: true }
  }

  // Wrap with format enforcement so the model always outputs PASS or FAIL: <reason>
  const prompt = `You are a code reviewer. Your ENTIRE response must be one of:\n- PASS\n- FAIL: <one-line reason>\n\nDo not explain. Do not add context. Just PASS or FAIL: <reason>.\n\n${userPrompt}`

  const reviewerCfg = { command, outputMode: 'text', timeout }
  const review = runReviewer(rootDir, reviewerCfg, prompt)

  if (!review.available) {
    const reason = `${review.binary || 'reviewer'} not found`
    logReview(sessionId, projectDir, check.name, 'FAIL', reason)
    return { pass: false, reason, output: '', skipped: false }
  }

  if (review.error) {
    logReview(sessionId, projectDir, check.name, 'FAIL', review.error)
    return { pass: false, reason: `Reviewer error: ${review.error}`, output: '', skipped: false }
  }

  if (review.pass === false) {
    logReview(sessionId, projectDir, check.name, 'FAIL', review.reason)
    return { pass: false, reason: review.reason, output: '', skipped: false }
  }

  logReview(sessionId, projectDir, check.name, 'PASS', null)
  return { pass: true, reason: 'PASS', output: '', skipped: false }
}

module.exports = { runAgentCheck }
