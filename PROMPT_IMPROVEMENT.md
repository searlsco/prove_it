# prove_it Internal System Prompts

This document catalogs every internal system prompt in prove_it, how each is used, and its broader architectural context. Use it as input for prompt engineering improvements.

## Architecture Overview

prove_it uses Claude Code [hooks](https://code.claude.com/docs/en/hooks) to enforce verifiability-first development. There are three hook scripts, each triggered by different Claude Code events:

| Hook | Event | File |
|------|-------|------|
| Session Start | `SessionStart` | `lib/hooks/prove_it_session_start.js` |
| Edit Gate | `PreToolUse` | `lib/hooks/prove_it_edit.js` |
| Stop | `Stop` | `lib/hooks/prove_it_stop.js` |
| Done | `PreToolUse` | `lib/hooks/prove_it_done.js` |

Prompts serve two distinct purposes:
1. **Context injection** — text appended to Claude's context to shape behavior (SessionStart stdout, Stop `reason`)
2. **Reviewer agent instructions** — prompts sent to an external reviewer CLI (`claude -p {prompt}`) that returns PASS/FAIL verdicts

## Prompt Catalog

---

### 1. Session Start Reminder

**File:** `lib/hooks/prove_it_session_start.js:92-102`
**Event:** SessionStart
**Mechanism:** Written to stdout, which Claude Code appends to context
**Audience:** The primary Claude agent (the one doing work)

```
prove_it active: verifiability-first workflow.

Before claiming done:
- Run ./script/test (or the configured test command)
- Verify to the last mile - if you can run it, run it
- Never say 'Try X to verify' - that's handing off your job
- If you can't verify something, mark it UNVERIFIED explicitly

The user should receive verified, working code - not a verification checklist.
```

**Context:** This is the only prompt that runs unconditionally at session start. It's the foundation — every other prompt is triggered conditionally. It shapes the entire session's behavior by establishing the anti-pattern ("Try X to verify") and the expected pattern ("run it yourself").

---

### 2. Soft Stop Reminder

**File:** `lib/hooks/prove_it_stop.js / prove_it_done.js:150-155`
**Function:** `softStopReminder()`
**Event:** Stop (when tests pass and work is allowed to stop)
**Mechanism:** Included in `decision: "approve"` response `reason` field
**Audience:** The primary Claude agent

```
prove_it: Tests passed. Before finishing, verify:
- Did you run every verification command yourself, or did you leave "Try X" for the user?
- If you couldn't run something, did you clearly mark it UNVERIFIED?
- Is the user receiving completed, verified work - or a verification TODO list?
```

**Context:** This fires when Claude tries to stop and tests pass — the "approve" path. Even though work is allowed to stop, this reminder is injected as the reason. It reinforces the session-start principles at the critical moment when the agent is wrapping up. The three questions are designed to be a self-assessment checklist.

---

### 3. Default Coverage Review Prompt

**File:** `lib/hooks/prove_it_stop.js / prove_it_done.js:157-173`
**Variable:** `DEFAULT_COVERAGE_PROMPT`
**Event:** Stop (after fast tests pass)
**Mechanism:** Injected into `getCoverageReviewerPrompt()` wrapper, sent to reviewer CLI
**Audience:** A separate reviewer agent (spawned via `claude -p` or configured CLI)
**Overridable:** Yes, via `hooks.stop.reviewer.prompt` in config

```
Check that code changes have corresponding test coverage.

For each changed source file:
- Verify corresponding test files were also modified
- Check that tests actually exercise the changed behavior
- Watch for lazy testing: `assert true`, empty test bodies, tests that don't call the code

Be skeptical of:
- Source changes with no test changes
- New functions/methods without test cases
- Bug fixes without regression tests

Be lenient for:
- Documentation-only changes
- Config file changes
- Refactors where existing tests still apply
- Test-only changes
```

**Context:** This is the "job description" portion of the coverage reviewer prompt. It only fires when:
1. The Stop event fires
2. Fast tests pass
3. The stop reviewer is enabled
4. There are diffs since the last review (otherwise auto-PASS)

The prompt is designed with a skeptical-by-default, lenient-for-good-reasons stance. It specifically calls out "lazy testing" patterns.

---

### 4. Coverage Reviewer Prompt Wrapper

**File:** `lib/hooks/prove_it_stop.js / prove_it_done.js:175-205`
**Function:** `getCoverageReviewerPrompt(userPrompt, diffs)`
**Event:** Stop
**Mechanism:** Assembles the full prompt sent to the reviewer CLI

```
You are a code reviewer. A coding agent is trying to stop work.

## Changes since last review

### {file}
\```diff
{diff}
\```

## Your task

{DEFAULT_COVERAGE_PROMPT or user override}

## Rules

- If no changes to review, return PASS
- Only FAIL for clear violations - when in doubt, PASS
- If diffs not provided above, run: git diff --stat

## Response format

Return EXACTLY one of:
- PASS
- FAIL: <reason>

One line only. Be concise.
```

**Context:** This wrapper assembles the full prompt from three pieces:
1. **Role instruction** — "You are a code reviewer" with context about what the agent is doing
2. **Diffs** — actual file diffs computed from Claude Code's file-history snapshots (not git diff — this captures in-session changes that may not be staged)
3. **Task + rules + format** — the job description plus response contract

The "when in doubt, PASS" rule is important — it prevents false positives from blocking flow. The diffs section is optional; if no diffs exist, the reviewer auto-PASSes without being invoked.

---

### 5. Default Code Review Prompt

**File:** `lib/hooks/prove_it_stop.js / prove_it_done.js:207-229`
**Variable:** `DEFAULT_CODE_PROMPT`
**Event:** PreToolUse (when `git commit` is intercepted)
**Mechanism:** Injected into `getCodeReviewerPrompt()` wrapper, sent to reviewer CLI
**Audience:** A separate reviewer agent
**Overridable:** Yes, via `hooks.done.reviewer.prompt` in config

```
Review staged changes for three things:

## 1. Test coverage
- Source changes should have corresponding test changes
- New functions/methods need test cases
- Bug fixes need regression tests
- Be lenient for: docs, config, refactors where existing tests apply

## 2. Problems the tests may have missed
- Logic errors, edge cases, incorrect assumptions
- Anything that looks wrong but wouldn't cause a test failure

## 3. Dead code
- Unused functions, variables, or imports being added
- Code that can never execute
- Commented-out code that should be deleted

FAIL if ANY of these three checks fail. PASS only if all three pass.

Do NOT flag:
- Style issues or naming preferences
- Documentation gaps
- Existing dead code (only flag NEW dead code in this diff)
```

**Context:** This is the more comprehensive reviewer — it runs on commit, not stop. It checks three things (coverage, correctness, dead code) vs. the stop reviewer's single check (coverage only). The "Do NOT flag" section prevents false positives from style concerns. The "only flag NEW dead code" rule scopes the review to changes in this commit.

---

### 6. Code Reviewer Prompt Wrapper

**File:** `lib/hooks/prove_it_stop.js / prove_it_done.js:231-258`
**Function:** `getCodeReviewerPrompt(userPrompt, stagedDiff)`
**Event:** PreToolUse (commit)
**Mechanism:** Assembles the full prompt sent to the reviewer CLI

```
You are a code reviewer. A coding agent is about to commit.

## Staged changes (about to be committed)

\```diff
{stagedDiff}
\```

## Your task

{DEFAULT_CODE_PROMPT or user override}

## Rules

- If no changes staged, return PASS
- Only FAIL for real problems - when in doubt, PASS
- If diff not provided above, run: git diff --cached

## Response format

Return EXACTLY one of:
- PASS
- FAIL: <reason>

One line only. Be concise.
```

**Context:** Similar structure to the coverage wrapper but uses `git diff --cached` (staged changes) rather than file-history diffs. This is appropriate because commits operate on the git staging area. The diff is included inline to avoid the reviewer needing to run git commands, reducing latency and failure modes.

---

### 7. Test Script Missing Message

**File:** `lib/hooks/prove_it_stop.js / prove_it_done.js:338-361`
**Function:** `testScriptMissingMessage(testCmd, projectDir)`
**Event:** PreToolUse or Stop
**Mechanism:** Shown as error output to Claude agent
**Audience:** The primary Claude agent

```
prove_it: Test script not found.

The test command '{testCmd}' does not exist.

Options:

1. SET UP TESTING:
   - Run: prove_it init
   - Update script/test to run your full test suite (linter, formatter, etc.)
   - Create script/test_fast for just unit tests (faster feedback)

2. IGNORE THIS DIRECTORY (add to ~/.claude/prove_it/config.json):
   "ignoredPaths": ["{displayPath}"]

3. DISABLE VERIFICATION for this project:
   echo '{"enabled":false}' > .claude/prove_it.json

4. DISABLE GLOBALLY via environment:
   export PROVE_IT_DISABLED=1
```

**Context:** This is an error-recovery prompt. It fires when prove_it is active but no test script exists. Rather than silently failing, it gives the agent four concrete remediation paths ordered from most-recommended (set up testing) to least (disable globally). The `displayPath` uses `~` for home directory to keep paths readable.

---

### 8. Beads Enforcement Denial

**File:** `lib/hooks/prove_it_edit.js:211-224`
**Event:** PreToolUse (Edit, Write, NotebookEdit, or Bash write operations)
**Mechanism:** Returned as `permissionDecisionReason` with `permissionDecision: "deny"`
**Audience:** The primary Claude agent

```
prove_it: No bead is tracking this work.

Before making code changes, select or create a bead to track this work:

  bd ready              # Show tasks ready to work on
  bd list               # Show all tasks
  bd show <id>          # View task details
  bd update <id> --status in_progress   # Start working on a task
  bd create "Title"     # Create a new task

Once you have an in_progress bead, this operation will be allowed.

Tip: If this is exploratory work, you can disable beads enforcement in
.claude/prove_it.local.json by setting beads.enabled: false
```

**Context:** This is a hard deny — the operation is blocked, not just warned about. The prompt teaches the agent how to unblock itself (create or claim a bead). The "Tip" at the bottom provides an escape hatch for exploratory work. This only fires in repos with `.beads/` initialized.

---

### 9. Config File Modification Block

**File:** `lib/hooks/prove_it_stop.js / prove_it_done.js:457-461` and `lib/hooks/prove_it_edit.js:211` (similar)
**Event:** PreToolUse (Edit, Write, or Bash redirect targeting prove_it config files)
**Mechanism:** `permissionDecision: "deny"`
**Audience:** The primary Claude agent

```
prove_it: Cannot modify .claude/prove_it*.json

These files are for user configuration. To modify them, run the command directly in your terminal (not through Claude).
```

**Context:** Prevents Claude from modifying its own enforcement configuration. Without this, an agent could weaken or disable prove_it's rules. This is a security boundary — the config is user-controlled, not agent-controlled.

---

## Prompt Flow Diagram

```
SessionStart
  └─> [1] Session Start Reminder (stdout → context)

Claude works...

Stop (Claude tries to finish)
  ├─ Tests fail → BLOCK (with test output)
  └─ Tests pass
       ├─ Reviewer enabled + diffs exist
       │    └─> [4] Coverage Reviewer Prompt ([3] inside)
       │         ├─ PASS → APPROVE with [2] Soft Stop Reminder
       │         └─ FAIL → BLOCK
       └─ No reviewer / no diffs
            └─> APPROVE with [2] Soft Stop Reminder

PreToolUse: git commit
  ├─ Test script missing → [7] Missing Script Message
  ├─ Tests run at hook time
  │    └─ Tests fail → BLOCK
  ├─ Tests pass + reviewer enabled + staged diff exists
  │    └─> [6] Code Reviewer Prompt ([5] inside)
  │         ├─ PASS → ALLOW commit through
  │         └─ FAIL → BLOCK
  └─ Tests pass, no reviewer → ALLOW commit through

PreToolUse: Edit/Write (beads repo)
  ├─ No in_progress bead → [8] Beads Denial
  └─ Bead active → ALLOW

PreToolUse: modify prove_it config
  └─> [9] Config Block
```

## Design Observations

**What works well:**
- The "when in doubt, PASS" rule in reviewer prompts prevents false positive blocking
- Inline diffs reduce reviewer latency and failure modes
- Error messages include concrete remediation steps
- The two-tier reviewer system (coverage on stop, full review on commit) balances thoroughness vs. speed

**Potential improvement areas:**
- The session start reminder and soft stop reminder overlap in messaging — both say "don't leave Try X for the user"
- Reviewer prompts have no examples of PASS decisions (only FAIL examples appear in the test prompt)
- The coverage prompt says "Watch for lazy testing" but doesn't give examples of what lazy testing looks like beyond the three patterns listed
- The code review prompt's "dead code" section could be more precise about what constitutes "can never execute" vs. "currently unused but reachable"
- No prompt explicitly tells the reviewer how to handle partial coverage (e.g., 3 of 5 new functions have tests)
- The reviewer gets raw diffs with no file context (e.g., what the module does, what the test file tests) — adding brief file-level context could improve judgment
