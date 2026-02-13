const fs = require('fs')
const path = require('path')
const { tryRun, truncateChars } = require('../io')
const { getLatestMtime, loadRunData, saveRunData } = require('../testing')
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
 * @returns {{ pass: boolean, reason: string, output: string, skipped: boolean }}
 */
function runScriptCheck (check, context) {
  const { rootDir, projectDir, sessionId, localCfgPath, sources, maxChars } = context
  const command = check.command
  const timeout = check.timeout || 60000
  const mtimeEnabled = check.mtime !== false

  function log (status, reason) {
    if (sessionId || projectDir) {
      logReview(sessionId, projectDir, check.name, status, reason)
    }
  }

  // Handle builtins
  if (isBuiltin(command)) {
    const builtinName = getBuiltinName(command)
    const builtins = require('./builtins')
    const fn = builtins[builtinName]
    if (!fn) {
      const result = { pass: false, reason: `Unknown builtin: ${builtinName}`, output: '', skipped: false }
      log('FAIL', result.reason)
      return result
    }
    const result = fn(check, context)
    log(result.pass ? 'PASS' : 'FAIL', result.reason)
    return result
  }

  // Check if script exists (for ./script/* paths)
  if (command.startsWith('./script/') || command.startsWith('./scripts/')) {
    const scriptPath = path.join(rootDir, command.slice(2))
    if (!fs.existsSync(scriptPath)) {
      const result = {
        pass: false,
        reason: `Script not found: ${command}`,
        output: '',
        skipped: false
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
      if (latestMtime > 0 && lastRun.at > latestMtime) {
        if (lastRun.pass) {
          const result = { pass: true, reason: 'cached pass (no code changes)', output: '', skipped: true }
          log('SKIP', result.reason)
          return result
        } else {
          const result = {
            pass: false,
            reason: `Tests failed and no code has changed since.\nCommand: ${command}\nLast run: ${new Date(lastRun.at).toISOString()}`,
            output: '',
            skipped: true
          }
          log('SKIP', result.reason)
          return result
        }
      }
    }
  }

  // Run the command
  const start = Date.now()
  const r = tryRun(command, { cwd: rootDir, timeout })
  const durationMs = Date.now() - start
  const combined = `${r.stdout}\n${r.stderr}`.trim()
  const output = truncateChars(combined, maxChars || 12000)

  // Save run data for mtime tracking
  if (mtimeEnabled && localCfgPath) {
    const runKey = check.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    saveRunData(localCfgPath, runKey, {
      at: Date.now(),
      pass: r.code === 0
    })
  }

  if (r.code === 0) {
    const result = {
      pass: true,
      reason: `${command} passed (${(durationMs / 1000).toFixed(1)}s)`,
      output,
      skipped: false
    }
    log('PASS', result.reason)
    return result
  }

  const result = {
    pass: false,
    reason: `${command} failed (exit ${r.code}, ${(durationMs / 1000).toFixed(1)}s)\n\n${output || '(no output)'}`,
    output,
    skipped: false
  }
  log('FAIL', result.reason)
  return result
}

module.exports = { runScriptCheck, isBuiltin, getBuiltinName }
