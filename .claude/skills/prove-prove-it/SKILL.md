---
name: prove-prove-it
description: >
  End-to-end test of a reviewer prompt through the real dispatcher pipeline.
  Builds a temp project with prove_it installed via the local shim, simulates
  multi-turn hook dispatches, and verifies the reviewer fires and produces
  correct verdicts. Use when you want to prove a reviewer actually works
  before shipping it.
---

# Prove a reviewer works end-to-end

Test that a reviewer prompt fires through the real dispatcher pipeline —
not just that the prompt produces good output when you run `claude -p`
in isolation.

## Arguments

`<prompt_ref>`—the skill name to test (e.g. `prove-coverage`,
`prove-shipworthy`). If omitted, test all reviewer skills.

## What "end-to-end" means

The dispatcher pipeline has multiple stages. Each can fail independently:

```
hook event (stdin JSON)
  → config loading
    → hook entry matching (event + matcher)
      → when-condition evaluation (linesChanged, variablesPresent, etc.)
        → template variable expansion (files_changed_since_last_run, session_diff, etc.)
          → agent check invocation (claude -p with expanded prompt)
            → verdict parsing (PASS/FAIL)
```

Testing `claude -p` with a hand-expanded prompt only tests the last two steps.
This skill tests all of them.

## Method

### Phase 1: Build a sample project with prove_it installed

Use the local shim so the dispatcher resolves to your working tree:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
export PATH="$REPO_ROOT/test/bin:$PATH"
which prove_it   # should show test/bin/prove_it
```

Create a temp project with real git state and prove_it config:

```bash
tmpdir=$(mktemp -d)
cd "$tmpdir"
git init && git config user.email "t@t" && git config user.name "T"
mkdir -p src test script
echo '#!/bin/bash
exit 0' > script/test && chmod +x script/test
```

Write the prove_it config. Use the real `buildConfig()` output or write a
focused config that isolates the reviewer you're testing:

```javascript
// For testing prove-coverage specifically:
{
  "enabled": true,
  "sources": ["src/**/*.js", "test/**/*.js"],
  "hooks": [{
    "type": "claude",
    "event": "Stop",
    "tasks": [{
      "name": "coverage-review",
      "type": "agent",
      "promptType": "skill",
      "prompt": "prove-coverage",
      "when": { "linesChanged": 500 }
    }]
  }]
}
```

Write realistic production code and commit a baseline so `git diff HEAD`
works. The reviewer is an LLM—toy code won't exercise its judgment. Write
something with enough surface area that "should this have tests?" is a real
question (service classes, validation logic, stateful modules).

### Phase 2: Simulate multi-turn dispatches through the hook harness

Use the hook harness's `invokeHook` to send PreToolUse events through the
real dispatcher—the same code path Claude Code uses:

```javascript
const { invokeHook, isolatedEnv } = require('<repo>/test/integration/hook-harness')

// Each invokeHook call simulates one Claude Code tool invocation
const result = invokeHook('claude:PreToolUse', {
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: {
    file_path: '<tmpdir>/src/auth.js',
    content: '<realistic code content>'
  },
  session_id: 'test-session',
  cwd: '<tmpdir>'
}, {
  projectDir: '<tmpdir>',
  cwd: '<tmpdir>',
  env: isolatedEnv('<tmpdir>')
})
```

Or use the CLI directly to simulate each turn:

```bash
echo '{
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "'"$tmpdir"'/src/auth.js",
    "content": "'"$(cat "$tmpdir/src/auth.js")"'"
  },
  "session_id": "test-session",
  "cwd": "'"$tmpdir"'"
}' | CLAUDE_PROJECT_DIR="$tmpdir" prove_it hook claude:PreToolUse
```

**For threshold-based reviewers** (`linesChanged`), the dispatcher
uses git refs to track churn. It runs `git diff --numstat <ref>` filtered
to the configured source globs and sums additions + deletions. This diffs the
ref against the working tree, so it captures both committed and uncommitted
changes. To simulate enough churn, either commit source file changes to the
test repo between dispatches or leave them uncommitted.

**Observe the threshold building:**
- First dispatch: bootstraps the ref at HEAD (0 churn, reviewer skipped)
- Commit source changes to the test repo
- Next dispatch: churn exceeds threshold, reviewer fires

### Phase 3: Design the test matrix

Every reviewer needs at least three end-to-end scenarios:

| Scenario | Setup | Expected |
|----------|-------|----------|
| **Clear FAIL** | Production code, no test files | Reviewer fires, returns FAIL, dispatcher denies |
| **Clear PASS** | Production code with real tests | Reviewer fires, returns PASS, dispatcher allows |
| **Sneaky FAIL** | Test files exist but are stubs/TODOs | Reviewer fires, returns FAIL, dispatcher denies |

The sneaky case is the most important—it's easy to write a prompt that
catches "zero tests." The hard part is catching tests that exist but don't
test anything.

**For threshold-based reviewers**, also test:
- **Under threshold**: Dispatcher allows without firing the reviewer at all
- **At threshold**: Reviewer fires
- **Post-reset accumulation**: After reviewer fires, counter resets, fires again after re-accumulating

### Phase 4: Verify the full output chain

For each scenario, check:

1. **Exit code**: 0 for allow, 0 for deny (dispatcher always exits 0)
2. **stdout JSON**: Parse it. For PreToolUse:
   - Allow: `hookSpecificOutput.permissionDecision === "allow"`
   - Deny: `hookSpecificOutput.permissionDecision === "deny"`
3. **Verdict text**: The reviewer's PASS/FAIL reason should be in the output
4. **Git refs**: Check that `refs/worktree/prove_it/<task-name>` advanced correctly after a pass

```javascript
const output = JSON.parse(result.stdout)
const decision = output.hookSpecificOutput?.permissionDecision
// "allow" when reviewer passes or hasn't fired yet
// "deny" when reviewer fails
```

### Phase 5: Clean up

```bash
rm -rf "$tmpdir"
```

## Principles

**Test through the real dispatcher, not around it.** The point is to prove
the full pipeline works: config loading → when-condition → template expansion
→ agent invocation → verdict. If you skip any stage, you're not proving what
you think you're proving.

**Use the local shim.** `PATH="$REPO_ROOT/test/bin:$PATH"` ensures the
dispatcher, builtins, and all transitive `prove_it` calls resolve to your
working tree. Without this, you're testing the installed Homebrew version.

**Simulate real git changes.** For threshold-based reviewers, commit actual
source file changes to the test repo. The dispatcher counts churn via
`git diff --numstat` filtered to source globs.

**Test FAIL first.** A reviewer that always passes is useless. Prove it can
deny before proving it can allow.

**The sneaky case is the whole point.** Anyone can write a prompt that catches
"zero tests." The hard part is catching "tests that exist but don't test
anything."

**Observe, don't assume.** Parse dispatcher JSON output and verify exit codes.
Don't trust that the reviewer fired—prove it by seeing the deny in stdout
or checking git refs under `refs/worktree/prove_it/`.

## Reporting

After all scenarios, present a table with the full dispatcher output:

```
| Scenario        | Threshold | Reviewer fired? | Verdict | Decision |
|----------------|-----------|-----------------|---------|----------|
| Under threshold | 300/500   | No              |—      | allow    |
| No tests        | 500/500   | Yes             | FAIL    | deny     |
| Real tests      | 500/500   | Yes             | PASS    | allow    |
| Stub tests      | 500/500   | Yes             | FAIL    | deny     |
```

Quote the raw dispatcher JSON output for each scenario so the reader can
verify without expanding tool calls.
