const fs = require('fs')
const path = require('path')
const { expandTemplate, getUnknownVars, getSessionVars } = require('../template')
const { BUILTIN_PROMPTS } = require('./builtins')
const { runReviewer } = require('../reviewer')
const { logReview } = require('../session')

const DEFAULT_MODELS = {
  PreToolUse: 'haiku',
  Stop: 'haiku',
  'pre-commit': 'sonnet',
  'pre-push': 'sonnet'
}

function defaultModel (hookEvent, hasExplicitCommand) {
  if (hasExplicitCommand) return null
  return DEFAULT_MODELS[hookEvent] || null
}

/**
 * Run an agent check.
 *
 * @param {object} check - Check config { name, command, prompt, promptType, timeout }
 * @param {object} context - { rootDir, projectDir, sessionId, toolInput, hookEvent, testOutput }
 * @returns {{ pass: boolean, reason: string, output: string, skipped: boolean }}
 */
function runAgentCheck (check, context) {
  const { rootDir, projectDir, sessionId } = context
  const command = check.command || null
  const timeout = check.timeout || 120000
  const taskStart = Date.now()

  function log (status, reason) {
    logReview(sessionId, projectDir, check.name, status, reason, Date.now() - taskStart)
  }

  // Resolve prompt — either inline string or builtin reference
  let promptTemplate = check.prompt
  if (check.promptType === 'reference') {
    promptTemplate = BUILTIN_PROMPTS[check.prompt]
    if (!promptTemplate) {
      const reason = `unknown prompt reference "${check.prompt}"`
      log('FAIL', reason)
      return { pass: false, reason, output: '', skipped: false }
    }
  }

  // Reject unknown template variables
  const unknownVars = getUnknownVars(promptTemplate)
  if (unknownVars.length > 0) {
    const reason = `unknown template variable(s): {{${unknownVars.join('}}, {{')}}}}`
    log('FAIL', reason)
    return { pass: false, reason, output: '', skipped: false }
  }

  // Reject session-dependent vars when no session is available
  if (!context.sessionId) {
    const sessionVars = getSessionVars(promptTemplate)
    if (sessionVars.length > 0) {
      const reason = `{{${sessionVars.join('}}, {{')}}} require a Claude Code session but session_id is null (git hooks don't have sessions)`
      log('FAIL', reason)
      return { pass: false, reason, output: '', skipped: false }
    }
  }

  // Expand template variables in the prompt
  const userPrompt = expandTemplate(promptTemplate, context)

  if (!userPrompt || !userPrompt.trim()) {
    log('SKIP', 'empty prompt')
    return { pass: true, reason: 'empty prompt — skipped', output: '', skipped: true }
  }

  // Read rule file if configured
  let rulesSection = ''
  if (check.ruleFile) {
    const rulePath = path.resolve(projectDir, check.ruleFile)
    try {
      rulesSection = fs.readFileSync(rulePath, 'utf8')
    } catch (err) {
      const detail = err.code === 'ENOENT'
        ? `ruleFile not found: ${check.ruleFile}`
        : `ruleFile error: ${check.ruleFile} (${err.message})`
      log('FAIL', detail)
      return { pass: false, reason: detail, output: '', skipped: false }
    }
  }

  // Wrap with format enforcement — neutral investigation frame
  const ruleBlock = rulesSection
    ? `\n--- Rules ---\n${rulesSection.trimEnd()}\n--- End Rules ---\n`
    : ''
  const prompt = `You are a code reviewer. Investigate the changes described below.
You MUST use tools to read source files and check git history to verify your conclusions.
Do not assume changes are fine — verify each claim with evidence from the codebase.
The diff is a starting point. Read the actual files and tests before rendering a verdict.
${ruleBlock}
${userPrompt}

Your response MUST start with exactly one of these two verdicts — no preamble:
PASS: <brief reasoning>
FAIL: <one-line reason>

Do not output anything before the verdict line.`

  const model = check.model || context.configModel || defaultModel(context.hookEvent, !!check.command)
  const reviewerCfg = { command, timeout, model, configEnv: context.configEnv }
  const review = runReviewer(rootDir, reviewerCfg, prompt)

  if (!review.available) {
    const reason = `${review.binary || 'reviewer'} not found`
    log('SKIP', reason)
    return { pass: true, reason: `⚠ ${check.name}: ${reason}`, output: '', skipped: true }
  }

  if (review.error) {
    log('CRASH', review.error)
    return { pass: true, reason: `⚠ ${check.name} crashed: ${review.error}`, output: '', skipped: true }
  }

  if (review.pass === false) {
    log('FAIL', review.reason)
    return { pass: false, reason: review.reason, output: '', skipped: false }
  }

  log('PASS', review.reason)
  return { pass: true, reason: review.reason, output: '', skipped: false }
}

module.exports = { defaultModel, runAgentCheck }
