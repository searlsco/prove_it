'use strict'

const { tryRun } = require('../io')

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
  const { rootDir } = context
  const command = task.command
  const timeout = task.timeout || 30000

  const r = tryRun(command, { cwd: rootDir, timeout })

  if (r.code !== 0) {
    const output = `${r.stdout}\n${r.stderr}`.trim()
    return {
      vars: {},
      error: `${task.name}: ${command} failed (exit ${r.code})${output ? '\n' + output : ''}`
    }
  }

  const { vars, parseError } = parseEnvOutput(r.stdout)
  if (parseError) {
    return {
      vars: {},
      error: `${task.name}: failed to parse env output — ${parseError}`
    }
  }

  return { vars, error: null }
}

module.exports = { parseEnvOutput, runEnvTask }
