const fs = require('fs')
const os = require('os')
const path = require('path')
const { sanitizeTaskName } = require('../io')
const { expandTemplate, getUnknownVars, getSessionVars } = require('../template')
const { runReviewer } = require('../reviewer')
const { logReview } = require('../session')

function stripFrontmatter (text) {
  if (!text.startsWith('---\n')) return text.trim()
  const endIdx = text.indexOf('\n---\n', 4)
  if (endIdx === -1) return text.trim()
  return text.slice(endIdx + 5).trim()
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
    fs.writeFileSync(readmePath, `# Reviewer Backchannel—${taskName}

The reviewer **${taskName}** failed with:

${failureReason.split('\n').map(l => '> ' + l).join('\n')}

---

If you believe this failure was made in error, or you have context the
reviewer lacks, write your response below. The reviewer will read this
file before its next review.

You may place supporting evidence in this directory and reference it here.

Recommend one of:
- **PASS**—not writing code / changes aren't mine / doing planning work
- **SKIP**—mid-task, code intentionally incomplete, will address before done

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
  const timeout = check.timeout || undefined
  const taskStart = Date.now()

  function log (status, reason, extra) {
    if (check.quiet && status !== 'FAIL' && status !== 'CRASH') return
    logReview(sessionId, projectDir, check.name, status, reason, Date.now() - taskStart, context.hookEvent, extra)
  }

  // Resolve prompt—either inline string or skill file
  let promptTemplate = check.prompt
  if (check.promptType === 'skill') {
    const skillPath = path.join(os.homedir(), '.claude', 'skills', check.prompt, 'SKILL.md')
    try {
      promptTemplate = stripFrontmatter(fs.readFileSync(skillPath, 'utf8'))
    } catch (err) {
      const reason = err.code === 'ENOENT'
        ? `skill "${check.prompt}" not found at ${skillPath} — run \`prove_it install\``
        : `skill "${check.prompt}" read error: ${err.message}`
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
  const templateContext = { ...context, taskName: check.name }
  const userPrompt = expandTemplate(promptTemplate, templateContext)

  if (!userPrompt || !userPrompt.trim()) {
    log('SKIP', 'empty prompt')
    return { pass: true, reason: 'empty prompt—skipped', output: '', skipped: true }
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

Review this context before proceeding. Assume good faith—the developer
may have information you don't. If their reasoning is compelling, you may
PASS or SKIP accordingly. If they referenced additional files in the
backchannel directory, read those files with tools before rendering a verdict.
--- End Developer Backchannel ---\n`
    : ''

  // Wrap with format enforcement—neutral investigation frame
  const ruleBlock = rulesSection
    ? `\n--- Rules ---\n${rulesSection.trimEnd()}\n--- End Rules ---\n`
    : ''
  const prompt = `You are a code reviewer. Your task has two phases.

Phase 1—Relevance check (no tools):
Read the diff/context provided above. If the changes are clearly unrelated to
this review's scope, output SKIP immediately without reading any files.

Phase 2—Investigation (only if relevant):
Use tools to read source files and check git history. Verify each claim with
evidence. The diff is a starting point—read the actual files and tests.
${ruleBlock}${backchannelBlock}
${userPrompt}

Your response MUST start with exactly one of these verdicts—no preamble:
PASS: <reasoning>
FAIL: <one-line summary>
SKIP: <reason>

PASS means you affirmatively approve the changes.
FAIL means you affirmatively disapprove—cite specific issues.
SKIP means now is a bad time to check—the code is mid-transition, or the changes
are unrelated to this review's scope. The check will re-fire on the next cycle.
Do NOT use SKIP because you are unsure—if in doubt, render PASS or FAIL.

Do not output anything before the verdict line.

On FAIL, follow the verdict line with your full detailed analysis. Structure it:
- Summary (2-3 sentences: what changed, risk areas, confidence)
- Issues (numbered, most severe first: severity, location, problem, scenario, suggested fix)
- Missing Changes (what should be in the diff but isn't)
- Test Gaps (untested scenarios for new/changed code)

On PASS or SKIP, the verdict line alone is sufficient.`

  // Log RUNNING before actual execution
  if (!check.quiet) {
    const runExtra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
    logReview(sessionId, projectDir, check.name, 'RUNNING', null, null, context.hookEvent, runExtra)
  }

  const model = check.model || context.configModel || defaultModel(context.hookEvent, !!check.command)
  const reviewerCfg = { command, timeout, model, configEnv: context.configEnv }
  const review = runReviewer(rootDir, reviewerCfg, prompt)

  // Build verbose data for the final verdict log entry
  const verbose = {
    prompt,
    response: review.responseText || null,
    model: model || null,
    backchannel: !!backchannelContent
  }

  if (!review.available) {
    const reason = `${review.binary || 'reviewer'} not found`
    log('SKIP', reason, { verbose })
    return { pass: true, reason: `⚠ ${check.name}: ${reason}`, output: '', skipped: true }
  }

  if (review.error) {
    // When a task specifies an explicit model and the reviewer crashes,
    // hard-fail with actionable guidance—a silently-skipped reviewer
    // that never runs is worse than a blocking failure.
    if (check.model) {
      const reason = `${check.name} crashed: ${review.error}\n\n` +
        `This task uses model "${check.model}". Possible causes: model not available on your plan, timeout, or transient failure.\n` +
        'To unblock: run `prove_it signal clear` to clear the signal, or ask the user to check the config.'
      log('FAIL', reason, { verbose })
      return { pass: false, reason, output: '' }
    }
    log('CRASH', review.error, { verbose })
    return { pass: true, reason: `⚠ ${check.name} crashed: ${review.error}`, output: '', skipped: true }
  }

  if (review.skip) {
    log('SKIP', review.reason, { verbose })
    cleanBackchannel(rootDir, sessionId, check.name)
    return { pass: true, reason: review.reason, output: '', skipped: true }
  }

  if (review.pass === false) {
    log('FAIL', review.reason, { verbose })
    const fullReport = review.body
      ? review.reason + '\n\n' + review.body
      : review.reason
    createBackchannel(rootDir, sessionId, check.name, fullReport)
    let reason = fullReport
    if (sessionId) {
      const bcDir = backchannelDir(rootDir, sessionId, check.name)
      reason += '\n\nBefore acting on this failure, ask yourself: does this apply to the work I\'m currently doing?' +
        '\n- If it MAY apply to your current work—address the issue.' +
        '\n- If you are confident it DOES NOT apply (you\'re planning, the flagged' +
        '\n  code isn\'t yours, the changes are unrelated)—appeal the decision.' +
        `\n\nTo appeal, write your reasoning in:\n${bcDir}/README.md`
    }
    return { pass: false, reason, output: '' }
  }

  log('PASS', review.reason, { verbose })
  cleanBackchannel(rootDir, sessionId, check.name)
  return { pass: true, reason: review.reason, output: '' }
}

module.exports = { defaultModel, runAgentCheck, backchannelDir, backchannelReadmePath, createBackchannel, cleanBackchannel }
