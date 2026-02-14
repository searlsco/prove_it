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
1. Test coverage gaps — if the diff adds or changes logic (conditionals, computations,
   state transitions, error handling), tests for that logic must exist in the staged
   diff or on disk. Declarative code (property assignments, view composition, layout,
   styling, framework wiring without branching) does not require test coverage.
   Do not assume tests will arrive in a future commit.
2. Logic errors or edge cases
3. Dead code

Staged diff:
{{staged_diff}}

Recent commits:
{{recent_commits}}

Working tree status:
{{git_status}}`,

  'review:test_coverage': `Review the code changes below for test coverage adequacy.

The standard: does the change contain logic — conditionals, computations, state
transitions, error handling, validation — that could break if reverted? If so, a test
must exist that would catch the reversion. Bug fixes and defensive guards especially
need regression tests — they encode behavior that was previously wrong.

Distinguish between decisions and declarations:
- DECISIONS need tests: if/else, switch, guard, ternary, computed values, state
  machines, error handling, event handlers, data transformations. If it branches
  or computes, test it.
- DECLARATIONS do not need tests: simple property assignments, view composition,
  layout/styling, framework wiring, and configuration expressed in code. Examples:
  \`player.allowsPiP = true\`, SwiftUI view bodies (HStack, VStack, modifiers like
  .padding(), .font()), dependency injection wiring, setting framework options.
  A test for a declaration just restates the assignment — it proves nothing.

If the project has test infrastructure (test scripts, test directories, test frameworks),
the coverage standard applies regardless of project age or "greenfield" status.
Do not waive coverage requirements because a project is new.

Exempt from testing: comments, whitespace, log messages, non-code config files
(build settings, .plist, .entitlements, CI config, dependency lockfiles, .gitignore),
pure removals (deleted code, removed features, dropped exports), and declarative
code as described above.

Before failing, verify by reading the actual test files on disk. Tests must specifically
exercise the changed behavior — a test file merely existing for the module is not enough.
If the test file exists but does not cover the new or changed behavior, that is a gap.

When a ruleFile is provided, respect the project's testing conventions. The project
team knows their framework constraints and what constitutes meaningful test coverage
in their domain.

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
- The changes are non-code files: documentation (.md, .txt), build config
  (.plist, .entitlements, CI YAML, lockfiles, .gitignore), or comment-only edits
- The changes are declarative: property assignments, view composition, layout/styling,
  framework wiring without conditional logic. A test would only restate the declaration.

FAIL criteria — ANY of:
- Significant new production logic (conditionals, computations, state management,
  error handling, data transformations) with zero test coverage
- New modules/classes with behavioral logic but no corresponding test file
- Test files exist but contain only stubs, TODOs, or trivial assertions

If test infrastructure exists (script/test, test directories, test frameworks),
the standard applies regardless of project age.`
}

module.exports = {
  'config:lock': configLock,
  BUILTIN_PROMPTS
}
