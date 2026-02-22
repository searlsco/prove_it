const path = require('path')
const { isLocalConfigWrite, isConfigFileEdit } = require('../globs')
const { renderBriefing } = require('../briefing')
const { loadEffectiveConfig } = require('../config')
const { loadRunData } = require('../testing')

/**
 * Builtin check implementations, referenced as "prove_it run_builtin <name>" in config.
 * Each takes (check, context) and returns { pass, reason, output }.
 */

/**
 * config:lock—Block writes to prove_it config files.
 * Returns deny for Write/Edit to prove_it*.json or Bash redirects to same.
 */
function configLock (check, context) {
  const { toolName, toolInput } = context

  const DENY_REASON = 'prove_it: Cannot modify prove_it config files\n\n' +
    'These files are for user configuration. ' +
    'To modify them, run the command directly in your terminal (not through Claude).'

  // Block Write/Edit to prove_it config files
  if (isConfigFileEdit(toolName, toolInput)) {
    return { pass: false, reason: DENY_REASON, output: '' }
  }

  // Block Bash redirects to prove_it config files
  if (toolName === 'Bash' && isLocalConfigWrite(toolInput?.command)) {
    return { pass: false, reason: DENY_REASON, output: '' }
  }

  return { pass: true, reason: '', output: '' }
}


/**
 * session:briefing—Render a human-readable orientation for SessionStart.
 * Loads the effective config and renders active tasks + review process overview.
 * Always passes—briefing failure should never block a session.
 */
function sessionBriefing (check, context) {
  try {
    const defaultFn = () => ({ enabled: false, sources: null, hooks: [] })
    const { cfg } = loadEffectiveConfig(context.projectDir, defaultFn)
    const localCfgPath = path.join(context.projectDir, '.claude', 'prove_it', 'config.local.json')
    const runs = loadRunData(localCfgPath)
    const text = renderBriefing(cfg, runs)
    return { pass: true, reason: text, output: '' }
  } catch (e) {
    return { pass: true, reason: `prove_it: briefing unavailable (${e.message})`, output: '' }
  }
}

module.exports = {
  'config:lock': configLock,
  'session:briefing': sessionBriefing
}
