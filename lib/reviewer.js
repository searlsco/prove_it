const path = require('path')
const { shellEscape, tryRun } = require('./io')

const NO_RATIONALE = '<<Reviewer provided no rationale>>'

function isCodexModel (model) {
  return model != null && /^gpt-/i.test(model)
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

function runReviewer (rootDir, reviewerCfg, prompt) {
  const model = reviewerCfg?.model || null
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

  const result = tryRun(fullCommand, {
    cwd: rootDir,
    timeout,
    input: prompt,
    env: { ...process.env, ...configEnv, LC_ALL: 'C', PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1', CLAUDECODE: '' }
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

  // claude -p writes to stderr; fall back to it when stdout is empty
  const responseText = (result.stdout.trim() || result.stderr.trim())

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
  parseVerdict,
  classifyVerdict,
  runReviewer
}
