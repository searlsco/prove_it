const fs = require('fs')
const path = require('path')
const { tryRun, truncateChars } = require('../io')
const { getLatestMtime, loadRunData, saveRunData, runResult } = require('../testing')
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
 * @param {object} check - Check config { name, command, mtime, timeout }
 * @param {object} context - { rootDir, projectDir, localCfgPath, sources, maxChars, sessionId }
 * @returns {{ pass: boolean, reason: string, output: string, cached?: boolean }}
 */
function runScriptCheck (check, context) {
  const { rootDir, projectDir, sessionId, localCfgPath, sources, maxChars } = context
  const command = check.command
  const timeout = check.timeout || 60000
  const mtimeEnabled = check.mtime !== false
  const taskStart = Date.now()

  function log (status, reason, extra) {
    if (check.quiet && status !== 'FAIL' && status !== 'CRASH') return
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
    log(result.pass ? 'PASS' : 'FAIL', result.reason)
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

  // Mtime skip check
  if (mtimeEnabled && localCfgPath) {
    const runKey = check.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    const runs = loadRunData(localCfgPath)
    const lastRun = runs[runKey]

    if (lastRun && lastRun.at) {
      const latestMtime = getLatestMtime(rootDir, sources)
      if (latestMtime > 0 && lastRun.at > latestMtime && runResult(lastRun) === 'pass') {
        const result = { pass: true, reason: 'cached pass (no code changes)', output: '', cached: true }
        log('SKIP', result.reason)
        return result
      }
    }
  }

  // Log RUNNING before actual execution
  if (!check.quiet && (sessionId || projectDir)) {
    const extra = context._triggerProgress ? { triggerProgress: context._triggerProgress } : undefined
    logReview(sessionId, projectDir, check.name, 'RUNNING', null, null, context.hookEvent, extra)
  }

  // Run the command
  const start = Date.now()
  const FORCED_ENV = { PROVE_IT_DISABLED: '1', PROVE_IT_SKIP_NOTIFY: '1' }
  const envOverride = { env: { ...process.env, ...context.configEnv, ...FORCED_ENV } }
  const r = tryRun(command, { cwd: rootDir, timeout, ...envOverride })
  const durationMs = Date.now() - start
  const combined = `${r.stdout}\n${r.stderr}`.trim()
  const output = truncateChars(combined, maxChars || 12000)

  // Save run data for mtime tracking
  if (mtimeEnabled && localCfgPath) {
    const runKey = check.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    saveRunData(localCfgPath, runKey, {
      at: Date.now(),
      result: r.code === 0 ? 'pass' : 'fail'
    })
  }

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
