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
  const prompt = expandTemplate(check.prompt, context)

  if (!prompt || !prompt.trim()) {
    return { pass: true, reason: 'empty prompt — skipped', output: '', skipped: true }
  }

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
