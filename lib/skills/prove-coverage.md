---
name: prove-coverage
description: Review code changes for test coverage adequacy
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - WebFetch
  - WebSearch
  - Task
  - NotebookEdit
disable-model-invocation: true
---

Review the code changes below for test coverage adequacy.

The standard: does the change contain logic—conditionals, computations, state
transitions, error handling, validation—that could break if reverted? If so, a test
must exist that would catch the reversion. Bug fixes and defensive guards especially
need regression tests—they encode behavior that was previously wrong.

Distinguish between decisions and declarations:
- DECISIONS need tests: if/else, switch, guard, ternary, computed values, state
  machines, error handling, event handlers, data transformations. If it branches
  or computes, test it.
- DECLARATIONS do not need tests: simple property assignments, view composition,
  layout/styling, framework wiring, and configuration expressed in code. Examples:
  `player.allowsPiP = true`, SwiftUI view bodies (HStack, VStack, modifiers like
  .padding(), .font()), dependency injection wiring, setting framework options.
  A test for a declaration just restates the assignment—it proves nothing.

If the project has test infrastructure (test scripts, test directories, test frameworks),
the coverage standard applies regardless of project age or "greenfield" status.
Do not waive coverage requirements because a project is new.

Exempt from testing: comments, whitespace, log messages, non-code config files
(build settings, .plist, .entitlements, CI config, dependency lockfiles, .gitignore),
pure removals (deleted code, removed features, dropped exports), and declarative
code as described above.

Before failing, verify by reading the actual test files on disk. Tests must specifically
exercise the changed behavior—a test file merely existing for the module is not enough.
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
{{git_status}}
