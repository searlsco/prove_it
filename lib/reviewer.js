const path = require('path')
const { shellEscape, tryRun } = require('./io')

const NO_RATIONALE = '<<Reviewer provided no rationale>>'

function isCodexModel (model) {
  return model != null && /^gpt-/i.test(model)
}

function parseVerdict (output) {
  if (!output) return { error: 'No output from reviewer' }

  const lines = output.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const [verdict, ...rest] = line.split(':')
    const reason = rest.join(':').trim() || NO_RATIONALE

    if (verdict === 'PASS') {
      return { pass: true, reason }
    }

    if (verdict === 'FAIL') {
      return { pass: false, reason }
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
  const timeout = reviewerCfg?.timeout || 120000
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
  return { available: true, ...verdict, responseText }
}

module.exports = {
  isCodexModel,
  parseVerdict,
  runReviewer
}
