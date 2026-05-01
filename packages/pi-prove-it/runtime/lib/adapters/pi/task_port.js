const { shellEscape, tryRun } = require('../../io')
const { parseVerdict } = require('../../reviewer')
const { createScriptTaskPort } = require('../../redesign/script_task_port')
const { reviewerContextFilesBlock } = require('../../redesign/reviewer_context_files')

const REVIEWER_VERDICT_INSTRUCTIONS = `

--- prove_it reviewer contract ---
Respond with a clear verdict as the first non-empty line: PASS, FAIL, or SKIP.
Use PASS only when the work satisfies the requested review. Use FAIL when remediation is needed. Use SKIP only when the review cannot be meaningfully performed yet.
--- end prove_it reviewer contract ---`

function rootDirFromContext (context = {}) {
  return context.event?.rootDir || context.event?.cwd || context.event?.projectDir || process.cwd()
}

function buildPiReviewerPrompt (context) {
  const contextFilesBlock = reviewerContextFilesBlock(context.contextFiles || context.reviewerContextFiles)
  const contextBlock = contextFilesBlock ? `\n\n${contextFilesBlock}` : ''
  return `${context.task.prompt || context.task.intent || ''}${contextBlock}${REVIEWER_VERDICT_INSTRUCTIONS}`
}

function piReviewerCommand (task = {}) {
  let command = 'pi -p --no-session'
  if (task.model) command += ` --model ${shellEscape(task.model)}`
  return command
}

function runPiReviewerTask (context, options = {}) {
  const runner = options.runner || tryRun
  const command = piReviewerCommand(context.task)
  const rootDir = rootDirFromContext(context)
  const timeout = context.task.timeout_ms || options.timeout
  const prompt = buildPiReviewerPrompt(context)

  const result = runner(command, {
    cwd: rootDir,
    timeout,
    input: prompt,
    env: {
      ...process.env,
      ...(options.env || {}),
      LC_ALL: 'C',
      PROVE_IT_DISABLED: '1',
      PROVE_IT_SKIP_NOTIFY: '1',
      CLAUDECODE: ''
    }
  })

  const output = result.stdout || result.stderr || ''
  if (result.code !== 0) {
    const detail = output.trim() || 'no output'
    return {
      pass: false,
      reason: `Pi reviewer exited ${result.code}: ${detail}`,
      output
    }
  }

  const verdict = parseVerdict(output)
  if (verdict.error) {
    return {
      pass: false,
      reason: verdict.error,
      output
    }
  }
  if (verdict.skip) {
    return {
      pass: true,
      skipped: true,
      reason: verdict.reason,
      output,
      verdict: {
        status: 'skip',
        reason: verdict.reason,
        body: null,
        evidence: output || null,
        transcript: null
      }
    }
  }
  return {
    pass: verdict.pass,
    reason: verdict.reason,
    output,
    ...(verdict.body ? { body: verdict.body } : {}),
    verdict: {
      status: verdict.pass ? 'pass' : 'fail',
      reason: verdict.reason,
      body: verdict.body || null,
      evidence: verdict.body || output || null,
      transcript: null
    }
  }
}

function createPiReviewerPort (pi = null, ctx = {}, options = {}) {
  const reviewer = options.reviewer || ((context) => runPiReviewerTask(context, options))
  return {
    run (context) {
      return reviewer({ ...context, pi, piContext: ctx })
    }
  }
}

function createPiTaskPort (pi = null, ctx = {}, options = {}) {
  const scriptPort = options.scriptPort || createScriptTaskPort(options)
  const reviewerPort = createPiReviewerPort(pi, ctx, options)

  return {
    run (context) {
      if (context.task?.type === 'agent' || context.task?.type === 'reviewer') return reviewerPort.run(context)
      return scriptPort.run(context)
    }
  }
}

module.exports = {
  REVIEWER_VERDICT_INSTRUCTIONS,
  buildPiReviewerPrompt,
  createPiReviewerPort,
  createPiTaskPort,
  piReviewerCommand,
  runPiReviewerTask
}
