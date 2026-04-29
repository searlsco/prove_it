# Claude parity acceptance harness

This is the acceptance artifact for the Claude Parity Cutover. Its target is:

> Justin can use Claude Code with prove_it and get equivalent product behavior, backed by strict `.prove_it/config.json`, not `.claude/prove_it/config.json`.

Use Workflow Engine terms when evaluating results: Claude Code is the Harness, the Claude Adapter translates Claude hook events into Clean Runtime stages, and strict `.prove_it/config.json` is the Project Config source of truth. `.claude/settings.json` is only an Adapter Artifact that registers hook commands.

## Quick automated validation

From the prove_it repository checkout:

```bash
node --test --test-reporter=spec \
  test/claude_parity_acceptance.test.js \
  test/claude_clean_runtime_route.test.js \
  test/claude_clean_observations.test.js \
  test/claude_reviewer_backend.test.js \
  test/integration/claude_clean_pre_tool_script.integration.test.js \
  test/integration/claude_clean_signal_interception.integration.test.js \
  test/integration/claude_clean_stop.integration.test.js \
  test/integration/claude_clean_phase_plan.integration.test.js \
  test/integration/claude_clean_task_completed.integration.test.js \
  test/integration/git_dispatcher.integration.test.js \
  test/cancel.test.js \
  test/disable.test.js \
  test/redesign_config.test.js \
  test/redesign_engine.test.js

./script/test_fast
./script/test

git diff --check
```

If JavaScript files changed, also run:

```bash
npx standard <changed js files>
```

## Fresh-project non-interactive acceptance harness

Run this from a local prove_it checkout. It uses `test/bin/prove_it` so the acceptance Harness exercises the working tree rather than a Homebrew install.

```bash
set -euo pipefail

export PROVE_IT_REPO="/path/to/prove_it"
export PATH="$PROVE_IT_REPO/test/bin:$PATH"

work="$(mktemp -d)"
cd "$work"
git init
mkdir -p script src test
cat > script/test_fast <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo fast ok
SH
cat > script/test <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo full ok
SH
chmod +x script/test_fast script/test

prove_it init --adapter claude

test -f .prove_it/config.json
test -f .prove_it/ownership.json
test -f .claude/settings.json
test ! -f .claude/prove_it/config.json

node <<'NODE'
const assert = require('node:assert')
const fs = require('node:fs')
const cfg = JSON.parse(fs.readFileSync('.prove_it/config.json', 'utf8'))
const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'))
assert.equal(cfg.profile, 'claude')
assert.equal(cfg.adapters.claude.enabled, true)
assert.match(JSON.stringify(settings), /prove_it hook claude:SessionStart/)
assert.match(JSON.stringify(settings), /prove_it hook claude:PreToolUse/)
assert.match(JSON.stringify(settings), /prove_it hook claude:Stop/)
assert.doesNotMatch(JSON.stringify(settings), /agent_workflows|git_workflows|profile_version/)
NODE

mkdir -p .claude/prove_it
printf '{ invalid legacy json' > .claude/prove_it/config.json
printf '{ invalid legacy local json' > .claude/prove_it/config.local.json

prove_it doctor | tee doctor.txt
grep -q 'Strict .prove_it effective config' doctor.txt
grep -q 'Strict .prove_it adapters enabled: claude' doctor.txt
grep -q 'Stale legacy Claude config present: .claude/prove_it/config.json' doctor.txt
grep -q 'Stale legacy Claude config present: .claude/prove_it/config.local.json' doctor.txt
grep -q 'legacy .claude/prove_it config is not a fallback runtime source\|Stale legacy Claude config ignored by normal hooks' doctor.txt

prove_it explain > explain.json
node <<'NODE'
const assert = require('node:assert')
const fs = require('node:fs')
const explained = JSON.parse(fs.readFileSync('explain.json', 'utf8'))
assert.equal(explained.source_layers[0].name, 'claude-parity')
assert.equal(explained.effective.profile, 'claude')
assert.deepEqual(explained.effective.agent_workflows.pre_tool.slice(0, 2), [
  'protect_prove_it_config',
  'test_first'
])
assert.ok(explained.lineage.agent_workflows.pre_tool.length > 0)
assert.doesNotMatch(JSON.stringify(explained), /invalid legacy json|invalid legacy local json|\.claude\/prove_it/)
NODE
```

Expected result:

- `prove_it init --adapter claude` creates strict `.prove_it/config.json` with `profile: "claude"`.
- `.claude/settings.json` contains Claude Adapter hook commands only; it is not workflow policy.
- `prove_it doctor` reports strict config, Claude activation health, and stale legacy Claude config as ignored.
- `prove_it explain` shows the Claude parity profile, effective Pipelines, lineage, and task shadowing when any task is shadowed by global/project/local config.
- Stale `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json` are ignored by normal Claude and Git dispatch.

### Optional non-interactive hook probes

These commands exercise adapter-owned Claude hook rendering without starting interactive Claude Code.

SessionStart methodology and `CLAUDE_ENV_FILE` export:

```bash
CLAUDE_PROJECT_DIR="$PWD" CLAUDE_ENV_FILE="$PWD/claude.env" \
  prove_it hook claude:SessionStart <<'JSON' > session-start.json
{"session_id":"accept-session","source":"startup"}
JSON

grep -q 'PROVE_IT_SESSION_ID="accept-session"' claude.env
node <<'NODE'
const assert = require('node:assert')
const out = require('./session-start.json')
assert.match(out.hookSpecificOutput.additionalContext, /prove_it methodology:/)
assert.match(out.hookSpecificOutput.additionalContext, /prove_it signal done/)
NODE
```

PreToolUse strict config guard:

```bash
CLAUDE_PROJECT_DIR="$PWD" prove_it hook claude:PreToolUse <<'JSON' > pretool-config.json
{"session_id":"accept-session","tool_name":"Write","tool_input":{"file_path":".prove_it/config.json"}}
JSON
node <<'NODE'
const assert = require('node:assert')
const out = require('./pretool-config.json')
assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
assert.match(out.hookSpecificOutput.permissionDecisionReason, /\.prove_it\/config\.json/)
NODE
```

Stale legacy config paths are not Clean Runtime protected config by default:

```bash
CLAUDE_PROJECT_DIR="$PWD" prove_it hook claude:PreToolUse <<'JSON' > pretool-legacy-config.json
{"session_id":"accept-session","tool_name":"Write","tool_input":{"file_path":".claude/prove_it/config.json"}}
JSON
# Expected: no deny decision solely because this is a legacy config path.
```

Git dispatch source of truth:

```bash
CLAUDECODE=1 CLAUDE_PROJECT_DIR="$PWD" prove_it hook git:pre-commit
# Expected: runs git_workflows.pre_commit from strict .prove_it/config.json.
# Expected: stale .claude/prove_it config remains ignored.
```

Git activation is Git 2.54 config-hook based. `prove_it init --adapter claude` configures prove_it-owned `hook.prove-it-pre-commit` / `hook.prove-it-pre-push` entries when the local Git supports config hooks and active strict `git_workflows` exist. No strict `.git/hooks/*` fallback is expected.

## Manual Claude Code checklist

Use `./script/agent` when validating from the prove_it source tree. It prepends `test/bin/prove_it` so every hook, libexec script, and transitive `prove_it` invocation uses local source.

1. **Start Claude Code in the fresh project**
   - Command: `cd "$work" && PATH="$PROVE_IT_REPO/test/bin:$PATH" claude`
   - Expected: SessionStart context mentions prove_it methodology, Done/Stuck/Idle Signals, configured Tasks, and reviewer/backchannel process.
   - Expected: startup/resume exports `PROVE_IT_SESSION_ID` through `CLAUDE_ENV_FILE`.

2. **Session env diagnostics**
   - Add a strict `session_env` task under `agent_workflows.session_start` that prints `FOO=bar`; restart/resume Claude.
   - Expected: `FOO` is exported through `CLAUDE_ENV_FILE` and context reports the variable names.
   - Repeat with a missing `CLAUDE_ENV_FILE`, a failing command, and unparseable output.
   - Expected: diagnostics are visible but non-blocking; Claude is not prevented from starting.

3. **Config guard and test-first behavior**
   - Ask Claude to edit `.prove_it/config.json` or `.prove_it/config.local.json`.
   - Expected: PreToolUse hard-blocks the edit.
   - Ask Claude to edit `.claude/prove_it/config.json`.
   - Expected: it is not treated as Clean Runtime protected config unless explicitly configured elsewhere.
   - Ask Claude to implement a source change before writing/running a failing test.
   - Expected: Claude parity `test_first` guidance remains active.
   - Ask Claude to exit plan mode with unverified assumptions.
   - Expected: `verify_assumptions` runs on `ExitPlanMode` and surfaces the blocking guidance.
   - If `adapters.claude.file_editing_tools` lists a custom editor tool, use that tool and confirm edits are observed.

4. **Signal lifecycle**
   - Run `prove_it signal done`, `prove_it signal stuck`, and `prove_it signal idle` from Claude Bash.
   - Expected: Signals are intercepted and recorded in clean Session State.
   - With Done active, ask Claude to stop.
   - Expected: Done-gated Completion Verification runs.
   - With Stuck active, continue work.
   - Expected: approach review gates the next relevant lifecycle.
   - Run `prove_it cancel` with no active work, then signal Done later.
   - Expected: cancel does not create a future bypass.
   - Run `prove_it disable`, `prove_it enable`, and `prove_it cancel` as escape hatches.
   - Expected: they remain session-scoped and do not edit Project Config.

5. **Completion verification / Stop behavior**
   - Stop before a Done Signal.
   - Expected: Done-gated verification does not run.
   - Edit a source file, run `prove_it signal done`, then stop.
   - Expected: relevant fast/full tests and Done reviewer tasks run.
   - Make `script/test` fail, signal Done, then stop.
   - Expected: Claude Stop is blocked with actionable remediation; Done Signal remains active.
   - Fix the failure and stop again.
   - Expected: passing verification clears Done Signal and phase.
   - Confirm async/parallel task results are harvested/enforced.
   - Confirm `output: "failures_only"` suppresses routine pass noise while preserving failures and crashes.

6. **Reviewer behavior**
   - Trigger Done, Stuck/Approach, coverage, and testing-pattern reviewer defaults.
   - Expected: reviewer tasks use the active Claude Harness only.
   - Expected: Claude sessions do not run Codex-shaped reviewers.
   - Configure `context_files` on a reviewer task.
   - Expected: included files are passed to the reviewer; missing or unsafe files fail clearly.
   - Trigger a failed reviewer with appeals enabled.
   - Expected: the Claude backchannel lifecycle works and the next review cycle can consume the appeal.

7. **Phase / plan / TaskCompleted behavior**
   - Run `prove_it phase plan`, `prove_it phase implement`, and `prove_it phase refactor`.
   - Expected: shared clean phase state updates.
   - Enter and exit Claude plan mode.
   - Expected: plan guidance/injection behavior is present where Claude exposes the required plan tooling; it remains Claude Adapter-owned.
   - Complete a Claude task whose subject matches Done-signal guidance.
   - Expected: TaskCompleted auto-signaling sets Done Signal when Done-gated Tasks exist, but it does not bypass Completion Verification.

8. **Git workflows**
   - Confirm Git 2.54 config hook activation with `git config --local --get-regexp '^hook\.prove-it-'`.
   - Run `CLAUDECODE=1 prove_it hook git:pre-commit` and `CLAUDECODE=1 prove_it hook git:pre-push`.
   - Expected: strict `.prove_it/git_workflows` drive dispatch.
   - Expected: stale `.claude/prove_it` config is ignored.
   - Expected: no strict `.git/hooks/*` fallback is required or created.

## Retained vs retired behavior

| Area | Retained Claude parity behavior | Retired Legacy Runtime config / intentional difference | Clean replacement |
|---|---|---|---|
| Source of truth | Workflow Engine reads strict `.prove_it/config.json`; `prove_it explain` shows profile, layers, lineage, and task shadowing. | `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json` are ignored by normal Claude and Git dispatch. | Move retained intent manually into strict `.prove_it/config.json`. |
| Adapter activation | `.claude/settings.json` registers Claude hook commands. | `.claude/settings.json` is not workflow policy. | Keep workflow policy under `.prove_it/`. |
| Session env | Startup/resume can export vars through `CLAUDE_ENV_FILE`; failures are non-blocking diagnostics. | Legacy `type: "env"` tasks are invalid. | `session_env` tasks in `agent_workflows.session_start`. |
| Config protection | `.prove_it/config.json` and `.prove_it/config.local.json` edits hard-block. | Stale `.claude/prove_it` files are not Clean Runtime protected config by default. | `config_guard.protected_paths`. |
| Test-first / assumptions | Claude parity profile includes `test_first` and `verify_assumptions`. | Legacy task-level `briefing` is invalid. | Profile SessionStart context and strict script tasks. |
| Output policy | Failure output is preserved; routine pass noise can be suppressed. | Legacy task `quiet` is invalid. | `output: "failures_only"`. |
| Enable/disable tasks | Pipelines choose which Tasks run. | Task-level `enabled` is invalid strict config. | pipeline `remove` / task shadowing instead of `enabled: false`. |
| Reviewer context | Reviewer Tasks use active Claude Harness and include safe context files. | `ruleFile`, `promptType`, top-level reviewer tool defaults, `taskAllowedTools`, and `taskBypassPermissions` are invalid. | `context_files`, `prompt: "skill:..."`, and `provider_options.allowed_tools` / `provider_options.bypass_permissions`. |
| Script task inputs | Scripts receive params, task-local environment, and timeout. | Top-level `taskEnv` and legacy `timeout` are invalid. | `params`, task-local `env`, and `timeout_ms`. |
| File edit observations | Claude Adapter can recognize configured edit tools. | Top-level `fileEditingTools` is invalid. | `adapters.claude.file_editing_tools`. |
| Signals and Stop | Done/Stuck/Idle Signals, Done-gated verification, Stop hard blocks, async/parallel harvesting, and phase clearing are retained for Claude. | Pi does not claim Claude hard Stop behavior; Codex is not implemented. | Harness-specific Capability Profiles. |
| TaskCompleted / plan mode | Claude `TaskCompleted`, `EnterPlanMode`, and `ExitPlanMode` behavior remains represented where Claude exposes the required hook data. | Core does not claim these are harness-neutral primitives. | Claude Adapter-owned mechanics over shared Signal/Phase state. |
| Git workflows | Git dispatch reads strict `.prove_it/git_workflows`. | Legacy `.git/hooks/*` fallback is not expected for strict Clean Runtime Git workflows. | Git 2.54 config hooks calling `prove_it hook git:*`. |

## Troubleshooting

- **Claude hooks run the Homebrew install instead of your checkout** — start Claude with `./script/agent` or put `<prove_it checkout>/test/bin` first on `PATH`.
- **`prove_it doctor` reports stale `.claude/prove_it` configs** — this is expected after the Claude Parity Cutover. They are ignored by normal Claude and Git dispatch. Move retained intent manually into `.prove_it/config.json`; there is no migration command and no dual-runtime compatibility mode.
- **`prove_it explain` does not show `claude-parity`** — check that `.prove_it/config.json` has `profile: "claude"` and `adapters.claude.enabled: true`; re-run `prove_it init --adapter claude` if the generated artifact is still owned by prove_it.
- **Git workflows do not fire** — confirm Git 2.54+ config-hook support and local hook config with `git config --local --get-regexp '^hook\.prove-it-'`. Strict Clean Runtime Git workflows do not use `.git/hooks/*` shim fallback.
- **Session env variables are missing** — verify Claude provided `CLAUDE_ENV_FILE`, the `session_env` task is in `agent_workflows.session_start`, and the command prints JSON, `KEY=value`, or `export KEY=value` lines.
- **Stop did not run full Done verification** — confirm a Done Signal is active, source observations are relevant, and the task `when` conditions match. Stop before Done intentionally skips Done-gated verification.
- **Reviewer tasks appear to call another harness** — strict Claude profile reviewer tasks must use `provider: "claude"`. Codex-shaped reviewers are intentionally not part of Claude parity.
- **A retired field is rejected** — use the clean replacement from the table above. Strict validation rejects legacy compatibility aliases on purpose.

## Automated coverage map

| Acceptance area | Automated coverage |
|---|---|
| Fresh `init --adapter claude`, Adapter Artifact shape, strict profile selection | `test/claude_parity_acceptance.test.js`, `test/redesign_init.test.js`, `test/integration/cli.integration.test.js` |
| `doctor` stale legacy diagnostics and strict activation health | `test/claude_parity_acceptance.test.js`, `test/integration/doctor.integration.test.js` |
| `explain` profile, effective Pipelines, lineage, task shadowing, and no legacy load | `test/claude_parity_acceptance.test.js`, `test/redesign_config.test.js` |
| Normal Claude dispatch reads `.prove_it/config.json`; stale `.claude/prove_it` configs ignored | `test/claude_clean_runtime_route.test.js`, `test/integration/claude_clean_stop.integration.test.js`, `test/integration/claude_clean_task_completed.integration.test.js` |
| Retired legacy fields invalid and clean replacements valid | `test/claude_parity_acceptance.test.js`, `test/redesign_config.test.js` |
| SessionStart methodology, `PROVE_IT_SESSION_ID`, `session_env`, and diagnostics | `test/claude_clean_runtime_route.test.js` |
| PreToolUse config guard, test-first guidance, assumption verification, custom edit tools | `test/integration/claude_clean_pre_tool_script.integration.test.js`, `test/claude_clean_observations.test.js`, `test/redesign_config.test.js` |
| Done/Stuck/Idle Signal interception and cancel lifecycle | `test/integration/claude_clean_signal_interception.integration.test.js`, `test/cancel.test.js`, `test/disable.test.js` |
| Completion verification, Stop pass/fail lifecycle, async/parallel harvesting, output policy | `test/integration/claude_clean_stop.integration.test.js`, `test/redesign_engine.test.js`, `test/redesign_config.test.js` |
| Claude reviewer backend, no Codex-shaped reviewers, context files, backchannel appeals | `test/claude_reviewer_backend.test.js`, `test/redesign_backchannel_lifecycle.test.js`, `test/redesign_config.test.js` |
| Phase, plan mode, and TaskCompleted auto-signaling | `test/integration/claude_clean_phase_plan.integration.test.js`, `test/integration/claude_clean_task_completed.integration.test.js` |
| Git 2.54 config-hook model and strict `.prove_it/git_workflows` dispatch | `test/integration/git_dispatcher.integration.test.js`, `test/redesign_init.test.js` |
| Observation model for Claude file edits and Bash command interception | `test/claude_clean_observations.test.js`, `test/integration/claude_clean_signal_interception.integration.test.js` |

Manual-only behavior is limited to what requires an interactive Claude Code Harness: Claude's live rendering of SessionStart context, interactive Stop hard-block UX, plan-file tool injection UX, and backchannel review/appeal ergonomics. Those behaviors should be checked with the manual checklist above rather than treated as fully automated.
