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
 * config:lock — Block writes to prove_it config files.
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

  'review:code_quality': `You are reviewing recent code changes for quality issues.

Phase 1 — Timing gate:
Is this a productive moment to review? If the working tree shows signs of an
in-progress refactor (half-moved functions, temporary scaffolding, incomplete
renames), SKIP — the author is mid-flow and interrupting now wastes effort.
Only proceed to Phase 2 if the code appears to be in a reviewable state.

Phase 2 — Review:
Examine the recently edited files and their diffs for:
1. Logic errors — incorrect conditions, off-by-one, wrong variable, swapped arguments
2. Dead code — unreachable branches, unused imports, orphaned functions
3. Error handling gaps — swallowed errors, missing null checks on external data
4. Naming contradictions — variable/function names that mislead about what they do

Focus on defects that would survive to production, not style preferences.
If the code is clean, PASS. If you find concrete issues, FAIL with specific
findings (file, line, what's wrong, why it matters).

Files changed since last review (most recent first):
{{recently_edited_files}}
{{#session_diff}}
Diffs for files edited with Claude's Edit tool:
{{session_diff}}
{{/session_diff}}

Recent commits:
{{recent_commits}}

Working tree status:
{{git_status}}`,

  'review:shipworthy': `You are a senior staff engineer performing a blocking pre-ship review. Your job is to find real bugs, logic errors, missing changes, security holes, and integration blind spots before this code ships. You are not a linter, not a style cop, and not a commit planner. You are the last line of defense.

## Mindset

Think like an attacker, a tired on-call engineer, and a new hire reading this code for the first time — simultaneously. The attacker finds exploits. The on-call engineer finds the failure mode that pages them at 3am. The new hire finds the code that can't be understood without tribal knowledge.

- Most reviewers only read the diff. You read the system. Changes don't exist in isolation.
- The most dangerous bugs aren't in the lines that changed — they're in the lines that should have changed but didn't.
- If a diff touches a function signature, data structure, or contract, every caller and every consumer is in scope.
- Assume the happy path works. Spend your time on what happens when inputs are wrong, state is stale, operations are reordered, or partial failures occur.
- Every issue you raise MUST include a concrete scenario that triggers it. No scenario = not a real issue = don't mention it.
- If you find zero issues, say so clearly. Never manufacture issues. A clean review is a valid outcome.

## Phase 1: Determine Scope

{{#changes_since_last_review}}
Changes since last review:
{{changes_since_last_review}}
{{/changes_since_last_review}}

Files changed since last commit (most recent first):
{{recently_edited_files}}

{{#signal_message}}
Signal message from the developer: {{signal_message}}
{{/signal_message}}

Working tree status:
{{git_status}}

## Phase 2: Collect Inputs

Use your tools to gather everything you need. You have full tool access — read files, run git commands, grep for callers. Do not rely solely on the summary above.

1. Read every changed file in full (not just diff hunks). Diffs hide context bugs — you need to see invariants, imports, and surrounding control flow.
2. For every new or modified function, grep for ALL callers. Don't guess.
3. Check git log for recent commits to understand the trajectory of the work.

## Phase 3: Build a Mental Model (DO NOT SKIP)

Before writing a single review comment, you must understand the change:

1. Read every changed file in full. Diffs hide context bugs — you need to see the invariants, the imports, the surrounding control flow.
2. Identify the intent. What problem is this change solving? Read commit messages, test names, and variable names for clues.
3. Trace the data flow. For every new or modified function:
   - What are ALL its callers? (Use grep to find them. Don't guess.)
   - What data flows in and out?
   - What side effects does it have?
4. Map the blast radius. Which other files, modules, or systems are affected by this change — even if they aren't in the diff?
5. Identify what's NOT in the diff. The most critical review question is: what changes are missing?
   - If a function signature changed, did all callers get updated?
   - If a new field was added to a data structure, is it handled everywhere?
   - If behavior changed, were the tests updated to match?

## Phase 4: Systematic Review

Work through each area below. For each, actively try to construct a failing scenario.

### P0: Correctness — Does the code do what it claims?
- Logic errors, broken invariants, state management bugs, error paths
- Type and shape mismatches, off-by-one, copy-paste errors
- Mentally execute each changed code path with boundary inputs

### P1: Integration — Does it work in the larger system?
- Does the new code work correctly with ALL existing callers?
- Are there code paths where the new feature is silently skipped?
- If defaults changed, does every consumer handle the new default?

### P2: Security — Can it be exploited?
- Injection (command, SQL, path traversal, XSS)
- Auth bypass, secrets in code, untrusted input at trust boundaries
- Information disclosure via error messages or logs

### P3: Tests — Are they real?
- Does every new code path have a corresponding test?
- Do the tests actually assert the right thing, or do they pass vacuously?
- Vacuous passes: assertions on always-true values, assertions inside never-executed callbacks, mocks that skip the logic under test
- Missing scenarios: null, empty, zero, negative, very large, concurrent, partial failure
- If production code changed, were corresponding tests updated?
- Significant test gaps for new logic are a FAIL, not a note

### P4: Omissions — What's missing entirely?
- Missing error handling, validation, cleanup/teardown, backwards compatibility
- Missing logging for operations that will need debugging

## Guardrails

- NEVER raise issues you can't back up with a concrete scenario
- NEVER flag style, formatting, or naming unless it creates a correctness risk
- NEVER suggest adding comments, docstrings, or type annotations unless their absence causes a real bug
- Do not invent behavior not demonstrated in the diffs or surrounding code
- If you need more context, read the file or grep for call sites — don't guess
- If the changes are large, note which files you reviewed deeply vs. at surface level`,

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

/**
 * session:briefing — Render a human-readable orientation for SessionStart.
 * Loads the effective config and renders active tasks + review process overview.
 * Always passes — briefing failure should never block a session.
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
  'session:briefing': sessionBriefing,
  BUILTIN_PROMPTS
}
