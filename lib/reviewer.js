const { shellEscape, tryRun } = require('./io')

function parseJsonlOutput (stdout) {
  const lines = stdout.trim().split('\n')
  let lastMessage = null
  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        lastMessage = event.item.text
      }
    } catch {}
  }
  return lastMessage
}

function parseVerdict (output) {
  if (!output) return { error: 'No output from reviewer' }

  const firstLine = output.split('\n')[0].trim()

  if (firstLine === 'PASS') {
    return { pass: true }
  }

  if (firstLine.startsWith('FAIL:')) {
    return { pass: false, reason: firstLine.slice(5).trim() }
  }

  if (firstLine === 'FAIL') {
    const lines = output.split('\n')
    const reason = lines.length > 1 ? lines[1].trim() : 'No reason provided'
    return { pass: false, reason }
  }

  return { error: `Unexpected reviewer output: ${firstLine}` }
}

function runReviewer (rootDir, reviewerCfg, prompt) {
  const command = reviewerCfg?.command || 'claude -p'
  const outputMode = reviewerCfg?.outputMode || 'text'

  const binary = command.split(/\s+/)[0]
  const whichResult = tryRun(`which ${shellEscape(binary)}`, {})
  if (whichResult.code !== 0) {
    return { available: false, binary }
  }

  const result = tryRun(command, {
    cwd: rootDir,
    timeout: 120000,
    input: prompt
  })

  if (result.code !== 0) {
    return { available: true, error: result.stderr || 'unknown error' }
  }

  let responseText
  if (outputMode === 'jsonl') {
    responseText = parseJsonlOutput(result.stdout)
  } else {
    responseText = result.stdout.trim()
  }

  const verdict = parseVerdict(responseText)
  return { available: true, ...verdict }
}

module.exports = {
  parseJsonlOutput,
  parseVerdict,
  runReviewer
}
