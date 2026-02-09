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
  const prompt = `You are a code reviewer. Your ENTIRE response must be one of:\n- PASS: <brief reasoning>\n- FAIL: <one-line reason>\n\nDo not explain further. Just PASS or FAIL with a brief reason.\n\n${userPrompt}`

  const reviewerCfg = { command, outputMode: 'text', timeout }
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
