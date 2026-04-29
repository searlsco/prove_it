# Adapter capabilities and Clean Runtime examples

prove_it is a methodology/workflow engine. The Clean Runtime evaluates strict `.prove_it/config.json` as the Workflow Engine source of truth. Claude Code and Pi are Harnesses; the Claude Adapter and Pi Adapter translate harness-native events into normalized Workflow Stages and render Workflow Engine Effects back to each Harness.

Adapter mechanics differ by Harness capability, but product behavior should be described in Workflow Engine terms: Project Config, Tasks, Pipelines, Signals, Completion Verification, Session State, Evidence, Hard Blocks, and Remediation.

Codex is deferred for future capability discovery and is not documented here as an implemented adapter.

## Strict setup

Use explicit adapters for new projects:

```bash
prove_it init --adapter claude
prove_it init --adapter pi
prove_it init --adapter pi --adapter claude
```

These commands write shared config and ownership records under `.prove_it/`:

- `.prove_it/config.json` — strict Workflow Engine Project Config.
- `.prove_it/config.local.json` — developer-local strict overrides.
- `.prove_it/ownership.json` — manifest for prove_it-owned artifacts.
- `.prove_it/.gitignore` — excludes local clean-runtime overrides.

Adapter-native files activate their Harnesses:

- Claude: `.claude/settings.json` registers hooks that call `prove_it hook claude:*`.
- Pi: `.pi/settings.json` or `pi install -l npm:@davemo/pi-prove-it` activates the Pi package.
- Git: Git 2.54+ local config entries such as `hook.prove-it-pre-commit.command = prove_it hook git:pre-commit` activate strict `git_workflows` when they are present.

`.claude/settings.json`, `.pi/settings.json`, and Git hook config entries are activation artifacts, not workflow config. Git workflow policy remains in `.prove_it/config.json` under `git_workflows`.

Inspect the effective Project Config with:

```bash
prove_it explain
```

Check installation, stale legacy config, and adapter capability diagnostics with:

```bash
prove_it doctor
```

## Claude parity behavior

`prove_it init --adapter claude` writes strict `.prove_it/config.json` with `profile: "claude"` and Claude-native `.claude/settings.json` hook registrations. Normal `prove_it hook claude:<Event>` dispatch uses strict `.prove_it/config.json` and clean Session State.

The Claude Parity Cutover is a hard break from Claude Legacy Config:

- `.claude/prove_it/config.json` is ignored by normal Claude and Git hook dispatch.
- `.claude/prove_it/config.local.json` is ignored by normal Claude and Git hook dispatch.
- `prove_it doctor` reports stale legacy Claude configs as ignored.
- There is no `.claude/prove_it` → `.prove_it` migration command.
- There is no supported dual-runtime compatibility mode.
- Legacy Claude characterization paths are quarantined behind a test-only oracle guard and are not user-facing runtime behavior.

Claude parity currently covers the product behaviors Justin should be able to validate manually:

- **Session Start briefing / methodology context** — Claude receives Workflow Engine context at Session Start, including Signals, configured Tasks, and methodology guidance.
- **Protected `.prove_it` config edits** — Pre Tool config guards hard-block writes to `.prove_it/config.json` and `.prove_it/config.local.json`.
- **Test-first guidance** — the Claude profile includes TDD-forward guidance and test-first enforcement where configured.
- **Done/Stuck Signal behavior** — `prove_it signal done`, `stuck`, and `idle` update Session State; passing Completion Verification clears Done, while failing verification preserves it.
- **Done-gated fast/full tests** — fast tests run on Completion Verification when relevant; full tests run for Done-signaled source edits according to the Claude profile.
- **Reviewer Tasks** — Done, Stuck/Approach, coverage, and testing-pattern Reviewer Tasks run from Workflow Engine Pipelines with Claude as the reviewer provider.
- **Backchannel appeals** — failed Claude Reviewer Tasks create adapter-owned backchannel files that Claude can use to appeal a verdict before the next review cycle.
- **Phase / plan-file behavior** — `prove_it phase ...` updates phase state, and Claude plan-file mechanics inject Done/phase instructions when plan tooling exposes the required data.
- **TaskCompleted auto-signaling** — Claude `TaskCompleted` can set a Done Signal automatically when the task subject matches the Done-signal guidance and Done-gated Tasks exist.
- **Disable/enable/cancel controls** — session-scoped `prove_it disable`, `prove_it enable`, and `prove_it cancel` work through clean Session State and Claude effect rendering.

Git-specific activation is intentionally Git 2.54+ only: strict init configures prove_it-owned `hook.prove-it-pre-commit` / `hook.prove-it-pre-push` config entries for active Git workflows, doctor reports missing or unsupported config hook activation, and strict deinit removes only those prove_it-owned Git config entries. There is no strict `.git/hooks/*` shim fallback.

Claude-specific mechanics remain adapter-owned: Claude hook names, hook JSON schemas, `.claude/settings.json`, `CLAUDE_ENV_FILE`, Claude Stop hard blocks, Claude file history, and Claude backchannel paths.

See [`example/claude-fast-follow/`](../example/claude-fast-follow/) for a Claude parity example. The directory name is historical; the README describes the completed hard-break behavior. To validate a project against the cutover target, use the [Claude parity acceptance harness](claude-parity-acceptance.md).

## Pi behavior

`prove_it init --adapter pi` writes strict `.prove_it/config.json` with `profile: "pi"`. Install the Pi package in a project or globally:

```bash
pi install -l npm:@davemo/pi-prove-it
# or: pi install npm:@davemo/pi-prove-it
```

A project-local `.pi/settings.json` can declare it directly:

```json
{
  "packages": ["npm:@davemo/pi-prove-it"]
}
```

Pi is first-class. Its behavior differs by Capability Profile, not by an experimental support label. The Pi methodology profile currently provides:

- methodology prompt injection before the Primary Agent starts;
- hard pre-tool config guard blocking through Pi `tool_call`;
- model-callable `prove_it_signal` for shared Done/Stuck/Idle Signal semantics;
- Pi Session State integration;
- fast/full script Completion Verification defaults when `./script/test_fast` or `./script/test` exist;
- Completion Verification from Pi `turn_end`, with `agent_end` settlement as a fallback;
- remediation follow-up when Completion Verification fails, preserving the active Done Signal until verification passes.

Pi Completion Verification is remediation from `turn_end`, not Claude-style hard Stop blocking. When verification fails, prove_it asks Pi to continue and remediate; it does not claim that Pi has a hard Stop primitive. The Pi profile does not include Claude-only reviewer/backchannel, TaskCompleted, or plan-file mechanics.

See [`example/pi-strict/`](../example/pi-strict/) for the smallest Pi-first strict `.prove_it` project.

## Multi-adapter behavior

A multi-adapter project can enable both Pi and Claude:

```bash
prove_it init --adapter pi --adapter claude
pi install -l npm:@davemo/pi-prove-it
```

Multi-adapter init currently writes `profile: "strict"` so Pi does not inherit Claude-only default mechanics. The generated Project Config enables both adapters, and adapter-native activation files connect each Harness to the same Workflow Engine model.

This does not imply cross-harness reviewers, shared session artifacts, or prove_it-managed human approval. Human review is downstream/external to prove_it core; treat it as code-review, release, or team policy after prove_it reports its machine-verifiable status.

See [`example/multi-adapter/`](../example/multi-adapter/) for a strict `.prove_it` example with Pi and Claude activation artifacts.

## Capability comparison matrix

| Capability | Pi | Claude |
|---|---|---|
| Context / prompt injection | available before `before_agent_start` | available through Claude Session Start context |
| Pre-tool config guard | hard block via Pi `tool_call` | hard block via Claude `PreToolUse` |
| Post-tool observation | observe-only via Pi `tool_result` | observable through Claude post-tool hooks |
| Model-callable / command Signals | model-callable `prove_it_signal` | command interception for `prove_it signal ...` |
| Session State | Pi session state entries | Claude adapter-owned filesystem-backed Session State |
| Completion Verification | remediation after `turn_end` | hard block via Claude `Stop` |
| Protocol rendering | Pi extension return values and remediation messages | Claude Adapter owns Claude hook JSON output |

A hard block prevents the guarded action or completion in that Harness. Remediation means the Harness has reached a post-turn or completion lifecycle point, so prove_it queues or asks for follow-up work instead of claiming hard enforcement.

## Retired legacy config

`.claude/prove_it/config.json` and `.claude/prove_it/config.local.json` are Claude Legacy Config from the Legacy Runtime. They are not Clean Runtime input, they are not merged into the Effective Config, and they are not a fallback when strict `.prove_it/config.json` is missing.

If they remain in a repository, `prove_it doctor` reports them as stale and ignored. Move any retained workflow intent manually into `.prove_it/config.json`.

## Future Platform Capability: worktrees

Worktree support is future Platform Capability work, not part of the Claude Parity Cutover. The intended direction is isolated boundaries for:

- Project Config and Local Config per Worktree;
- Session State per active Harness session and Worktree;
- Evidence, reviewer logs, and backchannel files scoped to the correct Worktree;
- adapter activation artifacts that do not bleed across checkouts.

Do not treat current adapter-specific paths as the final Worktree boundary model.

## What is not implemented here

- Codex support is deferred.
- A legacy config migration command is not implemented.
- A dual-runtime compatibility mode is not supported.
- Human review is downstream/external to prove_it core, not a built-in prove_it gate.
