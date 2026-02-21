'use strict'

const { tryRun } = require('../io')
const { logReview } = require('../session')

/**
 * Parse env var output from a script.
 * Auto-detects format:
 *   - JSON: { "KEY": "value", ... }
 *   - export: export KEY=value or export KEY="value"
 *   - .env: KEY=value or KEY="value"
 *
 * @param {string} stdout - Raw script output
 * @returns {{ vars: object, parseError: string|null }}
 */
function parseEnvOutput (stdout) {
  const trimmed = (stdout || '').trim()
  if (!trimmed) {
    return { vars: {}, parseError: null }
  }

  // Try JSON first
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { vars: {}, parseError: 'JSON output must be an object with string values' }
      }
      const vars = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== 'string') {
          return { vars: {}, parseError: `JSON value for "${k}" must be a string, got ${typeof v}` }
        }
        vars[k] = v
      }
      return { vars, parseError: null }
    } catch (e) {
      return { vars: {}, parseError: `Failed to parse JSON: ${e.message}` }
    }
  }

  // Line-based: export or .env format
  const vars = {}
  const lines = trimmed.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue

    // Strip leading "export "
    const stripped = line.startsWith('export ') ? line.slice(7) : line

    const eqIdx = stripped.indexOf('=')
    if (eqIdx === -1) {
      return { vars: {}, parseError: `Line ${i + 1}: no "=" found in "${line}"` }
    }

    const key = stripped.slice(0, eqIdx).trim()
    let value = stripped.slice(eqIdx + 1).trim()

    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { vars: {}, parseError: `Line ${i + 1}: invalid variable name "${key}"` }
    }

    // Unquote if wrapped in matching quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    vars[key] = value
  }

  return { vars, parseError: null }
}

/**
 * Run an env task: execute command, parse stdout as env vars.
 *
 * @param {object} task - Task config { name, command, timeout }
 * @param {object} context - { rootDir }
 * @returns {{ vars: object, error: string|null }}
 */
function runEnvTask (task, context) {
  const { rootDir, sessionId, projectDir } = context
  const command = task.command
  const timeout = task.timeout || 30000
  const taskStart = Date.now()

  function log (status, reason) {
    if (sessionId || projectDir) {
      logReview(sessionId, projectDir, task.name, status, reason, Date.now() - taskStart, context.hookEvent)
    }
  }

  // Log RUNNING before actual execution
  if (sessionId || projectDir) {
    const extra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
    logReview(sessionId, projectDir, task.name, 'RUNNING', null, null, context.hookEvent, extra)
  }

  const r = tryRun(command, { cwd: rootDir, timeout })

  if (r.code !== 0) {
    const output = `${r.stdout}\n${r.stderr}`.trim()
    const error = `${task.name}: ${command} failed (exit ${r.code})${output ? '\n' + output : ''}`
    log('FAIL', error)
    return { vars: {}, error }
  }

  const { vars, parseError } = parseEnvOutput(r.stdout)
  if (parseError) {
    const error = `${task.name}: failed to parse env output — ${parseError}`
    log('FAIL', error)
    return { vars: {}, error }
  }

  const varNames = Object.keys(vars)
  const reason = varNames.length > 0 ? `set ${varNames.join(', ')}` : 'no vars'
  log('PASS', reason)
  return { vars, error: null }
}

module.exports = { parseEnvOutput, runEnvTask }
