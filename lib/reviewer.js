const { shellEscape, tryRun } = require('./io')

const NO_RATIONALE = '<<Reviewer provided no rationale>>'

function parseVerdict (output) {
  if (!output) return { error: 'No output from reviewer' }

  const firstLine = output.split('\n')[0].trim()
  const [verdict, ...rest] = firstLine.split(':')
  const reason = rest.join(':').trim() || NO_RATIONALE

  if (verdict === 'PASS') {
    return { pass: true, reason }
  }

  if (verdict === 'FAIL') {
    return { pass: false, reason }
  }

  return { error: `Unexpected reviewer output: ${firstLine}` }
}

function runReviewer (rootDir, reviewerCfg, prompt) {
  const command = reviewerCfg?.command || 'claude -p'

  const binary = command.split(/\s+/)[0]
  const whichResult = tryRun(`which ${shellEscape(binary)}`, {})
  if (whichResult.code !== 0) {
    return { available: false, binary }
  }

  const result = tryRun(command, {
    cwd: rootDir,
    timeout: 120000,
    input: prompt,
    env: { ...process.env, PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
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
  return { available: true, ...verdict }
}

module.exports = {
  parseVerdict,
  runReviewer
}
