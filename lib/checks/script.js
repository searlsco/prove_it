const fs = require('fs')
const path = require('path')
const { tryRun, truncateChars } = require('../io')
const { logReview } = require('../session')

/**
 * Resolve a builtin command name to its implementation.
 */
function isBuiltin (command) {
  return command && command.startsWith('prove_it run_builtin ')
}

function getBuiltinName (command) {
  return command.replace('prove_it run_builtin ', '')
}

/**
 * Run a script check.
 *
 * @param {object} check - Check config { name, command, timeout }
 * @param {object} context - { rootDir, projectDir, localCfgPath, sources, maxChars, sessionId }
 * @returns {{ pass: boolean, reason: string, output: string }}
 */
function runScriptCheck (check, context) {
  const { rootDir, projectDir, sessionId, maxChars } = context
  const command = check.command
  const timeout = check.timeout || 60000
  const taskStart = Date.now()

  function log (status, reason, extra) {
    if (check.quiet && status !== 'FAIL' && status !== 'BOOM') return
    if (sessionId || projectDir) {
      logReview(sessionId, projectDir, check.name, status, reason, Date.now() - taskStart, context.hookEvent, extra)
    }
  }

  // Handle builtins—synchronous, near-instant, so no RUNNING entry
  if (isBuiltin(command)) {
    const builtinName = getBuiltinName(command)
    const builtins = require('./builtins')
    const fn = builtins[builtinName]
    if (!fn) {
      const result = { pass: false, reason: `Unknown builtin: ${builtinName}`, output: '' }
      log('FAIL', result.reason)
      return result
    }
    const result = fn(check, context)
    const status = result.pass ? 'PASS' : 'FAIL'
    const exitCode = result.pass ? 0 : 1
    const verbose = { command, output: result.reason, exitCode }
    log(status, result.reason, { verbose })
    return result
  }

  // Validate script exists—validation error, not execution, so no RUNNING entry
  if (command.startsWith('./script/') || command.startsWith('./scripts/')) {
    const scriptPath = path.join(rootDir, command.slice(2))
    if (!fs.existsSync(scriptPath)) {
      const result = {
        pass: false,
        reason: `Script not found: ${command}`,
        output: ''
      }
      log('FAIL', result.reason)
      return result
    }
  }

  // Log RUNNING before actual execution
  if (!check.quiet && (sessionId || projectDir)) {
    const extra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
    logReview(sessionId, projectDir, check.name, 'RUNNING', null, null, context.hookEvent, extra)
  }

  // Build hook input for stdin (mirrors Claude Code's native hook input format)
  const hookInput = {}
  if (context.hookEvent) hookInput.hook_event_name = context.hookEvent
  if (context.sessionId) hookInput.session_id = context.sessionId
  if (context.toolName) hookInput.tool_name = context.toolName
  if (context.toolInput) hookInput.tool_input = context.toolInput
  const stdinPayload = Object.keys(hookInput).length > 0
    ? JSON.stringify(hookInput)
    : undefined

  // Run the command
  const start = Date.now()
  const FORCED_ENV = { PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  const envOverride = { env: { ...process.env, ...context.configEnv, ...FORCED_ENV } }
  const r = tryRun(command, { cwd: rootDir, timeout, input: stdinPayload, ...envOverride })
  const durationMs = Date.now() - start
  const combined = `${r.stdout}\n${r.stderr}`.trim()
  const output = truncateChars(combined, maxChars || 12000)

  const verbose = {
    command,
    output: combined,
    exitCode: r.code
  }

  if (r.code === 0) {
    const result = {
      pass: true,
      reason: `${command} passed (${(durationMs / 1000).toFixed(1)}s)`,
      output
    }
    log('PASS', result.reason, { verbose })
    return result
  }

  const result = {
    pass: false,
    reason: `${command} failed (exit ${r.code}, ${(durationMs / 1000).toFixed(1)}s)\n\n${output || '(no output)'}`,
    output
  }
  log('FAIL', result.reason, { verbose })
  return result
}

module.exports = { runScriptCheck, isBuiltin, getBuiltinName }
