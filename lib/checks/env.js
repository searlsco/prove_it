'use strict'

const { tryRun } = require('../io')
const { logReview } = require('../session')
const { parseSessionEnvOutput } = require('../redesign/session_env')

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
  return parseSessionEnvOutput(stdout)
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
  const timeout = task.timeout
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
    const error = `${task.name}: failed to parse env output—${parseError}`
    log('FAIL', error)
    return { vars: {}, error }
  }

  const varNames = Object.keys(vars)
  const reason = varNames.length > 0 ? `set ${varNames.join(', ')}` : 'no vars'
  log('PASS', reason)
  return { vars, error: null }
}

module.exports = { parseEnvOutput, runEnvTask }
