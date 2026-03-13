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

const FINAL_TURN_PROMPT = `You have run out of turns. Provide your final verdict RIGHT NOW based on
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
      result: parsed.result ?? '',
      sessionId: parsed.session_id ?? null,
      subtype: parsed.subtype ?? null,
      numTurns: parsed.num_turns ?? null
    }
  } catch {
    return null
  }
}

/**
 * Extract the review text from a completed reviewer run.
 * When jsonMode is active, parses JSON and handles turn-limit with a final-turn resume
 * for max_turns errors. Otherwise, returns raw text.
 */
function extractReviewText (result, jsonMode, reviewerEnv, rootDir, binary, timeout, runner) {
  if (!runner) runner = tryRun
  if (!jsonMode) {
    // Non-JSON path: claude -p writes to stderr; fall back when stdout is empty
    return { text: result.stdout.trim() || result.stderr.trim(), finalTurn: null, diag: `non-json stdout=${result.stdout.length}b stderr=${result.stderr.length}b` }
  }

  const parsed = parseJsonOutput(result.stdout)
  if (!parsed) {
    // JSON parse failed—fall back to raw text
    return { text: result.stdout.trim() || result.stderr.trim(), finalTurn: null, diag: `json-parse-failed stdout=${result.stdout.length}b` }
  }

  if (parsed.subtype === 'error_max_turns' && parsed.sessionId) {
    // Final turn: resume the session and ask for a final verdict
    const numTurns = parsed.numTurns
    const resumeCmd = `${shellEscape(binary)} -p --resume ${shellEscape(parsed.sessionId)} --max-turns 1 --output-format json --tools ""`
    const finalTurnResult = runner(resumeCmd, {
      cwd: rootDir,
      timeout,
      input: FINAL_TURN_PROMPT,
      env: reviewerEnv
    })

    if (finalTurnResult.code === 0) {
      const finalTurnParsed = parseJsonOutput(finalTurnResult.stdout)
      if (finalTurnParsed && finalTurnParsed.result) {
        return { text: finalTurnParsed.result, finalTurn: { succeeded: true, numTurns }, diag: `max-turns resume-ok numTurns=${numTurns}` }
      }
      // Final turn also hit max turns or returned no result
      if (finalTurnParsed && finalTurnParsed.subtype === 'error_max_turns') {
        return { text: '', finalTurn: { succeeded: false, numTurns }, diag: `final-turn-max-turns numTurns=${numTurns}` }
      }
      // Final turn JSON parse failed—use raw output
      return { text: finalTurnResult.stdout.trim() || finalTurnResult.stderr.trim(), finalTurn: { succeeded: true, numTurns }, diag: `max-turns resume-fallback numTurns=${numTurns}` }
    }
    // Final turn failed—use whatever the original run produced
    return { text: parsed.result || result.stdout.trim() || result.stderr.trim(), finalTurn: { succeeded: false, numTurns }, diag: `max-turns resume-failed numTurns=${numTurns}` }
  }

  // Max turns but no sessionId for resume — can't recover
  if (parsed.subtype === 'error_max_turns') {
    return { text: '', finalTurn: { succeeded: false, numTurns: parsed.numTurns }, diag: `max-turns-no-session numTurns=${parsed.numTurns}` }
  }

  if (parsed.subtype === 'success' || parsed.result) {
    return { text: parsed.result, finalTurn: null, diag: `subtype=${parsed.subtype} result=${parsed.result.length}b` }
  }

  // Unexpected JSON shape—fall back to raw text
  return { text: result.stdout.trim() || result.stderr.trim(), finalTurn: null, diag: `unexpected-json subtype=${parsed.subtype}` }
}

function runReviewer (rootDir, reviewerCfg, prompt) {
  const model = reviewerCfg?.model || null
  const maxAgentTurns = reviewerCfg?.maxAgentTurns
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

  const { text: responseText, finalTurn, diag } = extractReviewText(result, jsonMode, reviewerEnv, rootDir, binary, timeout)

  if (!responseText) {
    return { available: true, error: `reviewer returned empty output [${diag || 'no-diag'}]` }
  }

  const verdict = parseVerdict(responseText)
  if (!verdict.error) {
    return { available: true, ...verdict, responseText, finalTurn }
  }

  // Only attempt haiku classification when the reviewer exited gracefully.
  // When the final turn failed, the fallback text is likely raw JSON or garbage—
  // don't waste an API call trying to classify it.
  if (finalTurn && !finalTurn.succeeded) {
    return { available: true, error: 'agent exceeded turn limit and final turn produced no parseable verdict', responseText, finalTurn }
  }

  // Parser couldn't extract a verdict—ask haiku to classify
  const fallback = classifyVerdict(responseText)
  if (fallback.error) {
    return { available: true, error: fallback.error, responseText, finalTurn }
  }

  // Classification succeeded—use original output as the reasoning
  const reason = responseText.split('\n')[0].trim() || NO_RATIONALE
  const body = responseText.trim()
  if (fallback.verdict === 'PASS') {
    return { available: true, pass: true, reason, responseText, finalTurn }
  }
  if (fallback.verdict === 'FAIL') {
    return { available: true, pass: false, reason, body, responseText, finalTurn }
  }
  // fallback.verdict === 'SKIP' (only remaining option)
  return { available: true, skip: true, reason, responseText, finalTurn }
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
  const m = response.match(/\b(PASS|FAIL|SKIP)\b/)
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
  FINAL_TURN_PROMPT
}
