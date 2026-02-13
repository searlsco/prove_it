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

/**
 * Builtin prompt templates for agent-type review tasks.
 * These are resolved at runtime via promptType: 'reference' in config.
 */
const BUILTIN_PROMPTS = {
  'review:commit_quality': `Review staged changes for:
1. Test coverage gaps — if the diff adds or changes behavior, tests for that behavior must exist in the staged diff or on disk. Do not assume tests will arrive in a future commit.
2. Logic errors or edge cases
3. Dead code

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

Exempt from testing: comments, whitespace, log messages, and non-code config files
(build settings, .plist, .entitlements, CI config, dependency lockfiles, .gitignore).
NOT exempt: code changes in source files that alter runtime behavior, even if the
file is a view, UI layer, or "configuration" within application code.

Before failing, verify by reading the actual test files on disk. Tests must specifically
exercise the changed behavior — a test file merely existing for the module is not enough.
If the test file exists but does not cover the new or changed behavior, that is a gap.

"Hard to test", "would require mocking", and "UI-only" are not valid reasons to waive
coverage. If existing test infrastructure cannot cover a behavioral change, report
that as a gap — do not excuse it.

Files changed since last commit (most recent first):
{{recently_edited_files}}
{{#session_diff}}
Diffs for files edited with Claude's Edit tool:
{{session_diff}}
{{/session_diff}}

Recent commits:
{{recent_commits}}

Working tree status:
{{git_status}}`,

  'review:test_investment': `You are reviewing whether recent code changes include adequate test investment.

The agent is currently writing to: {{file_path}}
If this file is a test file, PASS — the agent is actively addressing test coverage.

Files recently edited (sorted by recency):
{{recently_edited_files}}

Source file patterns: {{sources}}

Review the recently edited files. For each production/source file that was modified or created,
check whether corresponding tests exist and are meaningful.

PASS criteria — at least ONE of:
- The current write target ({{file_path}}) is a test file
- Newly created production files have corresponding test files with real assertions
- Modified production files have updated or existing tests covering the changes
- The changes are test-only (improving existing coverage)
- The changes are strictly non-code files: documentation (.md, .txt), build config
  (.plist, .entitlements, CI YAML, lockfiles, .gitignore), or comment-only edits.
  Code that changes runtime behavior is NOT exempt, even in view/UI files.

FAIL criteria — ANY of:
- Significant new production logic with zero test coverage
- New modules/classes/functions without any corresponding test file
- Test files exist but contain only stubs, TODOs, or trivial assertions

If test infrastructure exists (script/test, test directories, test frameworks),
the standard applies regardless of project age.`
}

module.exports = {
  'config:lock': configLock,
  BUILTIN_PROMPTS
}
