const fs = require('fs')
const path = require('path')
const { expandTemplate, getUnknownVars, getSessionVars } = require('../template')
const { BUILTIN_PROMPTS } = require('./builtins')
const { runReviewer } = require('../reviewer')
const { logReview } = require('../session')

function sanitizeTaskName (name) {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_')
  if (sanitized === '.' || sanitized === '..') return '_' + sanitized
  return sanitized
}

function backchannelDir (rootDir, sessionId, taskName) {
  return path.join(rootDir, '.claude', 'prove_it', 'sessions', sessionId, 'backchannel', sanitizeTaskName(taskName))
}

function backchannelReadmePath (rootDir, sessionId, taskName) {
  return path.join(backchannelDir(rootDir, sessionId, taskName), 'README.md')
}

function createBackchannel (rootDir, sessionId, taskName, failureReason) {
  if (!sessionId) return
  try {
    const readmePath = backchannelReadmePath(rootDir, sessionId, taskName)
    if (fs.existsSync(readmePath)) return
    const dir = backchannelDir(rootDir, sessionId, taskName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(readmePath, `# Reviewer Backchannel — ${taskName}

The reviewer **${taskName}** failed with:

${failureReason.split('\n').map(l => '> ' + l).join('\n')}

---

If you believe this failure was made in error, or you have context the
reviewer lacks, write your response below. The reviewer will read this
file before its next review.

You may place supporting evidence in this directory and reference it here.

Recommend one of:
- **PASS** — not writing code / changes aren't mine / doing planning work
- **SKIP** — mid-task, code intentionally incomplete, will address before done

If you're going back and forth with the reviewer and can't resolve the
disagreement, consider pausing and asking the user for help. The user can:
- Temporarily disable this task (\`enabled: false\` in prove_it config)
- Temporarily disable prove_it entirely
- Write in the backchannel themselves or advise you on what to say
- Adjust the reviewer's configuration

A SUPERVISORY AGENT WILL ASSESS THE HONESTY AND INTEGRITY OF YOUR
RESPONSE. DO NOT ATTEMPT TO LIE OR MANIPULATE TO BYPASS THE REVIEW.

Write your recommendation and reasoning below this line:

---
`)
  } catch (_) {}
}

function cleanBackchannel (rootDir, sessionId, taskName) {
  if (!sessionId) return
  try {
    const dir = backchannelDir(rootDir, sessionId, taskName)
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_) {}
}

function readBackchannel (rootDir, sessionId, taskName) {
  if (!sessionId) return null
  const readmePath = backchannelReadmePath(rootDir, sessionId, taskName)
  try {
    return fs.readFileSync(readmePath, 'utf8')
  } catch (_) {
    return null
  }
}

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
 * @returns {{ pass: boolean, reason: string, output: string, skipped?: boolean }}
 */
function runAgentCheck (check, context) {
  const { rootDir, projectDir, sessionId } = context
  const command = check.command || null
  const timeout = check.timeout || 120000
  const taskStart = Date.now()

  function log (status, reason) {
    if (check.quiet && status !== 'FAIL' && status !== 'CRASH') return
    logReview(sessionId, projectDir, check.name, status, reason, Date.now() - taskStart, context.hookEvent)
  }

  // Resolve prompt — either inline string or builtin reference
  let promptTemplate = check.prompt
  if (check.promptType === 'reference') {
    promptTemplate = BUILTIN_PROMPTS[check.prompt]
    if (!promptTemplate) {
      const reason = `unknown prompt reference "${check.prompt}"`
      log('FAIL', reason)
      return { pass: false, reason, output: '' }
    }
  }

  // Reject unknown template variables
  const unknownVars = getUnknownVars(promptTemplate)
  if (unknownVars.length > 0) {
    const reason = `unknown template variable(s): {{${unknownVars.join('}}, {{')}}}}`
    log('FAIL', reason)
    return { pass: false, reason, output: '' }
  }

  // Reject session-dependent vars when no session is available
  if (!context.sessionId) {
    const sessionVars = getSessionVars(promptTemplate)
    if (sessionVars.length > 0) {
      const reason = `{{${sessionVars.join('}}, {{')}}} require a Claude Code session but session_id is null (git hooks don't have sessions)`
      log('FAIL', reason)
      return { pass: false, reason, output: '' }
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
      return { pass: false, reason: detail, output: '' }
    }
  }

  // Check for developer backchannel (session-scoped, skipped for git hooks)
  const backchannelContent = readBackchannel(rootDir, sessionId, check.name)
  if (backchannelContent) {
    logReview(sessionId, projectDir, check.name, 'APPEAL', 'appealed via backchannel', null, context.hookEvent)
  }
  const backchannelBlock = backchannelContent
    ? `\n--- Developer Backchannel ---
The developer has left a response for you at:
${backchannelDir(rootDir, sessionId, check.name)}/

${backchannelContent.trimEnd()}

Review this context before proceeding. Assume good faith — the developer
may have information you don't. If their reasoning is compelling, you may
PASS or SKIP accordingly. If they referenced additional files in the
backchannel directory, read those files with tools before rendering a verdict.
--- End Developer Backchannel ---\n`
    : ''

  // Wrap with format enforcement — neutral investigation frame
  const ruleBlock = rulesSection
    ? `\n--- Rules ---\n${rulesSection.trimEnd()}\n--- End Rules ---\n`
    : ''
  const prompt = `You are a code reviewer. Your task has two phases.

Phase 1 — Relevance check (no tools):
Read the diff/context provided above. If the changes are clearly unrelated to
this review's scope, output SKIP immediately without reading any files.

Phase 2 — Investigation (only if relevant):
Use tools to read source files and check git history. Verify each claim with
evidence. The diff is a starting point — read the actual files and tests.
${ruleBlock}${backchannelBlock}
${userPrompt}

Your response MUST start with exactly one of these verdicts — no preamble:
PASS: <brief reasoning>
FAIL: <one-line reason>
SKIP: <one-line reason why now is a bad time to check>

PASS means you affirmatively approve the changes.
FAIL means you affirmatively disapprove — cite specific issues.
SKIP means now is a bad time to check — the code is mid-transition, or the changes
are unrelated to this review's scope. The check will re-fire on the next cycle.
Do NOT use SKIP because you are unsure — if in doubt, render PASS or FAIL.

Do not output anything before the verdict line.`

  // Log RUNNING before actual execution
  if (!check.quiet) {
    const runExtra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
    logReview(sessionId, projectDir, check.name, 'RUNNING', null, null, context.hookEvent, runExtra)
  }

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

  if (review.skip) {
    log('SKIP', review.reason)
    cleanBackchannel(rootDir, sessionId, check.name)
    return { pass: true, reason: review.reason, output: '', skipped: true }
  }

  if (review.pass === false) {
    log('FAIL', review.reason)
    createBackchannel(rootDir, sessionId, check.name, review.reason)
    let reason = review.reason
    if (sessionId) {
      const bcDir = backchannelDir(rootDir, sessionId, check.name)
      reason += '\n\nBefore acting on this failure, ask yourself: does this apply to the work I\'m currently doing?' +
        '\n- If it MAY apply to your current work — address the issue.' +
        '\n- If you are confident it DOES NOT apply (you\'re planning, the flagged' +
        '\n  code isn\'t yours, the changes are unrelated) — appeal the decision.' +
        `\n\nTo appeal, write your reasoning in:\n${bcDir}/README.md`
    }
    return { pass: false, reason, output: '' }
  }

  log('PASS', review.reason)
  cleanBackchannel(rootDir, sessionId, check.name)
  return { pass: true, reason: review.reason, output: '' }
}

module.exports = { defaultModel, runAgentCheck, backchannelDir, backchannelReadmePath, createBackchannel, cleanBackchannel }
