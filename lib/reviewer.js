const fs = require('fs')
const os = require('os')
const path = require('path')
const { shellEscape, tryRun } = require('./io')

const NO_RATIONALE = '<<Reviewer provided no rationale>>'

function isCodexModel (model) {
  return model != null && /^gpt-/i.test(model)
}

function isSettingsBypassMode () {
  const files = [
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    path.join(os.homedir(), '.claude', 'settings.json')
  ]
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'))
      const mode = s?.permissions?.defaultMode
      if (mode) return mode === 'bypassPermissions'
    } catch { /* continue */ }
  }
  return false
}

function parseVerdict (output) {
  if (!output) return { error: 'No output from reviewer' }

  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Strip markdown formatting that may wrap a verdict keyword:
    // **FAIL**, *PASS*, ***SKIP***, __FAIL__, # PASS, ## FAIL, etc.
    const stripped = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*{1,3}/g, '')
      .replace(/_{1,3}/g, '')
      .trim()
    const m = stripped.match(/^(PASS|FAIL|SKIP)\b:?\s*(.*)/)
    if (!m) continue

    const verdict = m[1]
    const reason = m[2].trim() || NO_RATIONALE
    const body = lines.slice(i + 1).join('\n').trim()

    if (verdict === 'PASS') {
      if (reason === NO_RATIONALE && body) {
        return { pass: true, reason: body }
      }
      return { pass: true, reason }
    }

    if (verdict === 'FAIL') {
      // When there's no inline reason but body has content, fold body into
      // reason — the body IS the rationale. Without this, the display shows
      // "<<Reviewer provided no rationale>>" above a detailed review.
      if (reason === NO_RATIONALE && body) {
        return { pass: false, reason: body, body: null }
      }
      return { pass: false, reason, body: body || null }
    }

    if (verdict === 'SKIP') {
      return { skip: true, reason }
    }
  }

  const firstLine = lines[0].trim()
  return { error: `Unexpected reviewer output: ${firstLine}` }
}

const NUDGE_PROMPT = `You have run out of turns. Provide your final verdict RIGHT NOW based on
what you have gathered so far. Use the expected output format: start with
a PASS, FAIL, or SKIP verdict line, then your summary and findings.
Do NOT use any more tools.`

/**
 * Try to parse `--output-format json` output from `claude -p`.
 * Returns { result, sessionId, subtype } or null on failure.
 */
function parseJsonOutput (stdout) {
  try {
    const parsed = JSON.parse(stdout)
    return {
      result: parsed.result || '',
      sessionId: parsed.session_id || null,
      subtype: parsed.subtype || null
    }
  } catch {
    return null
  }
}

/**
 * Extract the review text from a completed reviewer run.
 * When jsonMode is active, parses JSON and handles nudge-and-resume
 * for max_turns errors. Otherwise, returns raw text.
 */
function extractReviewText (result, jsonMode, reviewerEnv, rootDir, fullCommand, timeout) {
  if (!jsonMode) {
    // Non-JSON path: claude -p writes to stderr; fall back when stdout is empty
    return result.stdout.trim() || result.stderr.trim()
  }

  const parsed = parseJsonOutput(result.stdout)
  if (!parsed) {
    // JSON parse failed—fall back to raw text
    return result.stdout.trim() || result.stderr.trim()
  }

  if (parsed.subtype === 'error_max_turns' && parsed.sessionId) {
    // Nudge resume: ask the reviewer to produce a verdict from what it has
    const resumeCmd = `claude -p --resume ${shellEscape(parsed.sessionId)} --max-turns 1 --output-format json`
    const nudgeResult = tryRun(resumeCmd, {
      cwd: rootDir,
      timeout,
      input: NUDGE_PROMPT,
      env: reviewerEnv
    })

    if (nudgeResult.code === 0) {
      const nudgeParsed = parseJsonOutput(nudgeResult.stdout)
      if (nudgeParsed && nudgeParsed.result) {
        return nudgeParsed.result
      }
      // Nudge JSON parse failed—use raw output
      return nudgeResult.stdout.trim() || nudgeResult.stderr.trim()
    }
    // Nudge failed—use whatever the original run produced
    return parsed.result || result.stdout.trim() || result.stderr.trim()
  }

  if (parsed.subtype === 'success' || parsed.result) {
    return parsed.result
  }

  // Unexpected JSON shape—fall back to raw text
  return result.stdout.trim() || result.stderr.trim()
}

function runReviewer (rootDir, reviewerCfg, prompt) {
  const model = reviewerCfg?.model || null
  const maxAgentTurns = reviewerCfg?.maxAgentTurns || null
  const defaultCommand = isCodexModel(model) ? 'codex exec -' : 'claude -p'
  const command = reviewerCfg?.command || defaultCommand
  const timeout = reviewerCfg?.timeout || undefined
  const configEnv = reviewerCfg?.configEnv || null

  const binary = command.split(/\s+/)[0]
  const whichResult = tryRun(`which ${shellEscape(binary)}`, {})
  if (whichResult.code !== 0) {
    return { available: false, binary }
  }

  let fullCommand = command
  const binaryName = path.basename(binary)
  if (model && (binaryName === 'claude' || binaryName === 'codex')) {
    fullCommand += ` --model ${shellEscape(model)}`
  }

  // JSON output mode: only for claude binary with maxAgentTurns
  const jsonMode = binaryName === 'claude' && maxAgentTurns != null
  if (jsonMode) {
    fullCommand += ` --max-turns ${maxAgentTurns} --output-format json`
  }

  if (binaryName === 'claude') {
    const bypass = reviewerCfg?.bypassPermissions === true ||
      (reviewerCfg?.bypassPermissions == null && isSettingsBypassMode())
    if (bypass) {
      fullCommand += ' --dangerously-skip-permissions'
    } else if (reviewerCfg?.allowedTools) {
      fullCommand += ` --allowedTools ${shellEscape(reviewerCfg.allowedTools)}`
    }
  } else if (reviewerCfg?.allowedTools && binaryName === 'codex') {
    fullCommand += ` --allowedTools ${shellEscape(reviewerCfg.allowedTools)}`
  }

  const reviewerEnv = { ...process.env, ...configEnv, LC_ALL: 'C', PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1', CLAUDECODE: '' }

  const result = tryRun(fullCommand, {
    cwd: rootDir,
    timeout,
    input: prompt,
    env: reviewerEnv
  })

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    const sig = result.signal ? ` (${result.signal})` : ''
    const promptInfo = ` [prompt: ${prompt.length} chars]`
    const error = detail
      ? `reviewer exited ${result.code}${sig}: ${detail}${promptInfo}`
      : `reviewer exited ${result.code}${sig} with no output${promptInfo}`
    return { available: true, error }
  }

  const responseText = extractReviewText(result, jsonMode, reviewerEnv, rootDir, fullCommand, timeout)

  if (!responseText) {
    return { available: true, error: 'reviewer returned empty output' }
  }

  const verdict = parseVerdict(responseText)
  if (!verdict.error) {
    return { available: true, ...verdict, responseText }
  }

  // Parser couldn't extract a verdict—ask haiku to classify
  const fallback = classifyVerdict(responseText)
  if (fallback.error) {
    return { available: true, error: fallback.error, responseText }
  }

  // Classification succeeded—use original output as the reasoning
  const reason = responseText.split('\n')[0].trim() || NO_RATIONALE
  const body = responseText.trim()
  if (fallback.verdict === 'PASS') {
    return { available: true, pass: true, reason, responseText }
  }
  if (fallback.verdict === 'FAIL') {
    return { available: true, pass: false, reason, body, responseText }
  }
  // fallback.verdict === 'SKIP' (only remaining option)
  return { available: true, skip: true, reason, responseText }
}

function classifyVerdict (reviewerOutput) {
  const snippet = reviewerOutput.length > 2000
    ? reviewerOutput.slice(0, 2000) + '\n[truncated]'
    : reviewerOutput
  const classifyPrompt = `A code reviewer produced the output below but our parser could not extract a structured verdict.

Read the output and determine: is this a PASS, FAIL, or SKIP?

Respond with EXACTLY one word—PASS, FAIL, or SKIP—and nothing else.
If the output is not a coherent review or you truly cannot tell, respond
with a short error message (one sentence) explaining why.

--- Reviewer output ---
${snippet}
--- End reviewer output ---`

  const result = tryRun('claude -p --model haiku', {
    timeout: 30000,
    input: classifyPrompt,
    env: { ...process.env, LC_ALL: 'C', PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1', CLAUDECODE: '' }
  })

  if (result.code !== 0) {
    return { error: 'verdict fallback failed: classifier exited ' + result.code }
  }

  const response = (result.stdout || result.stderr || '').trim()
  const m = response.match(/^(PASS|FAIL|SKIP)$/)
  if (!m) {
    // Haiku returned an error description—surface it
    return { error: `verdict unclear (classifier: ${response})` }
  }

  return { verdict: m[1] }
}

module.exports = {
  isCodexModel,
  isSettingsBypassMode,
  parseVerdict,
  parseJsonOutput,
  extractReviewText,
  classifyVerdict,
  runReviewer,
  NUDGE_PROMPT
}
