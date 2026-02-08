const fs = require('fs')
const path = require('path')
const { loadJson, ensureDir, tryRun } = require('../io')
const { gitRoot, gitHead, gitStatusHash } = require('../git')
const { getProveItDir } = require('../config')
const { isSourceFile, isLocalConfigWrite, isConfigFileEdit } = require('../globs')

/**
 * Builtin check implementations, referenced as "prove_it builtin:<name>" in config.
 * Each takes (check, context) and returns { pass, reason, output, skipped }.
 */

/**
 * session-baseline: Record git HEAD + status hash per session.
 * Always passes — it's a recording step, not a gate.
 */
function sessionBaseline (check, context) {
  const { projectDir, sessionId } = context
  if (!sessionId) return { pass: true, reason: 'no session', output: '', skipped: true }

  const sessionsDir = path.join(getProveItDir(), 'sessions')
  ensureDir(sessionsDir)

  const root = gitRoot(projectDir) || projectDir
  const head = gitHead(root)
  const statusHash = gitStatusHash(root)

  const sessionFile = path.join(sessionsDir, `${sessionId}.json`)
  const payload = {
    session_id: sessionId,
    project_dir: projectDir,
    root_dir: root,
    started_at: new Date().toISOString(),
    git: { is_repo: true, root, head, status_hash: statusHash }
  }

  try {
    const existing = loadJson(sessionFile) || {}
    const merged = { ...existing, ...payload }
    ensureDir(sessionsDir)
    fs.writeFileSync(sessionFile, JSON.stringify(merged, null, 2), 'utf8')
  } catch (e) {
    console.error(`prove_it: failed to write session baseline: ${e.message}`)
  }

  return { pass: true, reason: 'baseline recorded', output: '', skipped: false }
}

/**
 * beads-reminder: Inject beads context at session start.
 * Always passes — outputs text to stdout for SessionStart.
 */
function beadsReminder (check, context) {
  const reminder = [
    'prove_it active: verifiability-first workflow.',
    '',
    'Before claiming done:',
    '- Run ./script/test (or the configured test command)',
    '- Verify to the last mile - if you can run it, run it',
    "- Never say 'Try X to verify' - that's handing off your job",
    "- If you can't verify something, mark it UNVERIFIED explicitly",
    '',
    'The user should receive verified, working code - not a verification checklist.'
  ].join('\n')

  return { pass: true, reason: reminder, output: reminder, skipped: false }
}

/**
 * config-protection: Block writes to prove_it config files.
 * Returns deny for Write/Edit to prove_it*.json or Bash redirects to same.
 */
function configProtection (check, context) {
  const { toolName, toolInput } = context

  const DENY_REASON = 'prove_it: Cannot modify .claude/prove_it*.json\n\n' +
    'These files are for user configuration. ' +
    'To modify them, run the command directly in your terminal (not through Claude).'

  // Block Write/Edit to prove_it config files
  if (isConfigFileEdit(toolName, toolInput)) {
    return { pass: false, reason: DENY_REASON, output: '', skipped: false }
  }

  // Block Bash redirects to prove_it config files
  if (toolName === 'Bash' && isLocalConfigWrite(toolInput?.command)) {
    return { pass: false, reason: DENY_REASON, output: '', skipped: false }
  }

  return { pass: true, reason: '', output: '', skipped: false }
}

const GATED_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const BASH_WRITE_PATTERNS = [
  '\\bcat\\s+.*>',
  '\\becho\\s+.*>',
  '\\btee\\s',
  '\\bsed\\s+-i',
  '\\bawk\\s+.*-i\\s*inplace'
]

/**
 * beads-gate: Require in_progress bead for write operations.
 * Checks tool type and bash write patterns.
 */
function beadsGate (check, context) {
  const { toolName, toolInput, rootDir, sources } = context

  // Check if this tool requires a bead
  let requiresBead = GATED_TOOLS.includes(toolName)

  if (!requiresBead && toolName === 'Bash') {
    const command = toolInput?.command || ''
    requiresBead = BASH_WRITE_PATTERNS.some(pat => {
      try { return new RegExp(pat, 'i').test(command) } catch { return false }
    })
  }

  if (!requiresBead) {
    return { pass: true, reason: '', output: '', skipped: true }
  }

  // Skip enforcement for non-source files
  if (sources && sources.length > 0) {
    let targetPath = null
    if (GATED_TOOLS.includes(toolName)) {
      targetPath = toolInput?.file_path || toolInput?.notebook_path
    }
    if (targetPath) {
      const dir = rootDir || '.'
      const relativePath = path.isAbsolute(targetPath)
        ? path.relative(dir, targetPath)
        : targetPath
      if (relativePath.startsWith('..')) {
        return { pass: true, reason: 'outside repo', output: '', skipped: true }
      }
      if (!isSourceFile(relativePath, dir, sources)) {
        return { pass: true, reason: 'non-source file', output: '', skipped: true }
      }
    }
  }

  // Check if this is a beads repo
  const beadsDir = path.join(rootDir, '.beads')
  const isBeads = fs.existsSync(beadsDir) && (
    fs.existsSync(path.join(beadsDir, 'config.yaml')) ||
    fs.existsSync(path.join(beadsDir, 'beads.db')) ||
    fs.existsSync(path.join(beadsDir, 'metadata.json'))
  )
  if (!isBeads) {
    return { pass: true, reason: 'not a beads repo', output: '', skipped: true }
  }

  // Check for in_progress beads
  let r
  try {
    r = tryRun('bd list --status in_progress 2>/dev/null', { cwd: rootDir })
  } catch (e) {
    console.error(`prove_it: bd command failed: ${e.message}. Beads may need updating.`)
    return { pass: true, reason: 'bd command error', output: '', skipped: true }
  }

  if (r.code !== 0) {
    if (r.stderr && r.stderr.includes('command not found')) {
      console.error('prove_it: bd command not found. Install beads or disable beads enforcement.')
    }
    return { pass: true, reason: 'bd unavailable', output: '', skipped: true }
  }

  const lines = r.stdout.trim().split('\n').filter(line => {
    if (!line.trim()) return false
    if (line.includes('───') || line.includes('---')) return false
    if (line.toLowerCase().includes('no issues found')) return false
    if (line.toLowerCase().includes('id') && line.toLowerCase().includes('subject')) return false
    return true
  })

  if (lines.length > 0) {
    return { pass: true, reason: 'bead in progress', output: '', skipped: false }
  }

  return {
    pass: false,
    reason: `prove_it: No bead is tracking this work.

Before making code changes, select or create a bead to track this work:

  bd ready              # Show tasks ready to work on
  bd list               # Show all tasks
  bd show <id>          # View task details
  bd update <id> --status in_progress   # Start working on a task
  bd create "Title"     # Create a new task

Once you have an in_progress bead, this operation will be allowed.

Tip: If this is exploratory work, you can disable beads enforcement in
.claude/prove_it.local.json by setting beads.enabled: false`,
    output: '',
    skipped: false
  }
}

/**
 * soft-stop-reminder: Emit "verify before finishing" text.
 * Always passes.
 */
function softStopReminder (check, context) {
  const reminder = 'prove_it: Tests passed. Before finishing, verify:\n' +
    '- Did you run every verification command yourself, or did you leave "Try X" for the user?\n' +
    "- If you couldn't run something, did you clearly mark it UNVERIFIED?\n" +
    '- Is the user receiving completed, verified work - or a verification TODO list?'
  return { pass: true, reason: reminder, output: reminder, skipped: false }
}

module.exports = {
  'session-baseline': sessionBaseline,
  'beads-reminder': beadsReminder,
  'config-protection': configProtection,
  'beads-gate': beadsGate,
  'soft-stop-reminder': softStopReminder,
  GATED_TOOLS,
  BASH_WRITE_PATTERNS
}
