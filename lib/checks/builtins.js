const fs = require('fs')
const path = require('path')
const { isLocalConfigWrite, isConfigFileEdit } = require('../globs')

/**
 * Builtin check implementations, referenced as "prove_it run_builtin <name>" in config.
 * Each takes (check, context) and returns { pass, reason, output, skipped }.
 */

/**
 * config:lock — Block writes to prove_it config files.
 * Returns deny for Write/Edit to prove_it*.json or Bash redirects to same.
 */
function configLock (check, context) {
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
 * beads:require_wip — Require in_progress bead for write operations.
 * Checks tool type and bash write patterns.
 */
function beadsRequireWip (check, context) {
  const { toolName, toolInput, rootDir, sources } = context
  const { tryRun } = require('../io')
  const { isSourceFile } = require('../globs')

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
 * Builtin prompt templates for agent-type review tasks.
 * These are resolved at runtime via promptType: 'reference' in config.
 */
const BUILTIN_PROMPTS = {
  'review:commit_quality': `Review staged changes for:
1. Test coverage gaps
2. Logic errors or edge cases
3. Dead code

Before failing for coverage gaps, check recent git history — tests may have been committed separately.

Staged diff:
{{staged_diff}}

Recent commits:
{{recent_commits}}

Working tree status:
{{git_status}}`,

  'review:test_coverage': `Review the code changes below for test coverage adequacy.

The standard: if any changed line were reverted, would an existing test fail?
If not, a test is missing. Bug fixes and defensive guards especially need
regression tests — they encode behavior that was previously wrong.

If the project has test infrastructure (test scripts, test directories, test frameworks),
the coverage standard applies regardless of project age or "greenfield" status.
Do not waive coverage requirements because a project is new.

Do not require tests for: comments, whitespace, log messages, or config-only changes.

Before failing, verify your conclusions by reading test files on disk and checking recent git history.
If adequate tests exist in the repo (even if not in the diff), PASS.

Session diff:
{{session_diff}}

Recent commits:
{{recent_commits}}

Working tree status:
{{git_status}}`,

  'review:test_investment': `You are reviewing whether recent code changes include adequate test investment.

Files recently edited (sorted by recency):
{{recently_edited_files}}

Source file patterns: {{sources}}

Review the recently edited files. For each production/source file that was modified or created,
check whether corresponding tests exist and are meaningful.

PASS criteria — at least ONE of:
- Newly created production files have corresponding test files with real assertions
- Modified production files have updated or existing tests covering the changes
- The changes are test-only (improving existing coverage)
- The changes are config/docs/non-logic files that don't need tests

FAIL criteria — ANY of:
- Significant new production logic with zero test coverage
- New modules/classes/functions without any corresponding test file
- Test files exist but contain only stubs, TODOs, or trivial assertions

If test infrastructure exists (script/test, test directories, test frameworks),
the standard applies regardless of project age.`
}

module.exports = {
  'config:lock': configLock,
  'beads:require_wip': beadsRequireWip,
  BUILTIN_PROMPTS,
  GATED_TOOLS,
  BASH_WRITE_PATTERNS
}
