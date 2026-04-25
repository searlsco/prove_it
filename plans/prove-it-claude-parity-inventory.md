# Claude Parity Target and Legacy Behavior Inventory

Issue: #19 — Codify Claude parity target and legacy behavior inventory

## Purpose

This document is the source-of-truth parity inventory for the **Claude Parity Cutover** from the **Legacy Runtime** (`.claude/prove_it`) to the **Clean Runtime** backed by strict `.prove_it` configuration. It uses the terms from [`UBIQUITOUS_LANGUAGE.md`](../UBIQUITOUS_LANGUAGE.md): Claude Code is the **Harness**, the **Claude Adapter** translates **Claude Hooks** into normalized **Workflow Stages**, the **Workflow Engine** evaluates the **Effective Config**, and **Effects** are rendered back through the Claude hook protocol.

The current behavioral oracle is `lib/dispatcher/claude.js` plus its characterization tests. The target is **Parity** in prove_it product behavior, not byte-for-byte compatibility with every Legacy Runtime implementation detail.

## Non-negotiable cutover decision

`.prove_it/config.json` is the future Claude **Project Config** and source of truth. `.prove_it/config.local.json` is the future Claude **Local Config**. The clean Claude path must not maintain `.claude/prove_it/config.json` or `.claude/prove_it/config.local.json` as a second runtime source.

This is a hard break from **Claude Legacy Config**. Do not build a one-time migration command, a dual-read compatibility mode, or a permanent compiler from `.claude/prove_it` into `.prove_it`. Old `.claude/prove_it` files may be test fixtures or comparison artifacts only.

## Reference branch rule

The `feat/prove-it-pi-phase0-phase1` branch may be used as a reference or cherry-pick candidate for adapter seams only, such as:

- Claude dispatcher registration data (`lib/adapters/claude/hooks.js` on that branch).
- Claude protocol/effect renderer extraction (`lib/adapters/claude/protocol.js`, `effects.js`).
- Claude-owned path, file-history, and plan helper seams.
- Clean-runtime config/profile/runtime experiments.
- Manual adapter comparison ideas.

Never wholesale-merge the branch. The current Legacy Runtime dispatcher remains the Claude behavior oracle; the research branch is not product truth.

## Target implementation issue map

| Issue | Primary inventory coverage |
| --- | --- |
| #20 Route Claude hooks through clean-runtime adapter activation | Config source-of-truth, stage routing, hard-break dispatch boundary |
| #21 Render Claude SessionStart from clean runtime | Session Start, context injection, environment injection, session baseline |
| #22 Run strict Claude PreToolUse config guard end-to-end | Pre Tool config guard, target-path extraction, Claude hard-block rendering |
| #23 Run strict Claude PreToolUse script tasks end-to-end | Pre Tool Script Task execution, ordering, first-failure stop |
| #24 Port Claude Bash prove_it signal interception to shared lifecycle | Bash command interception for Signals, signal parser/state update |
| #25 Run strict Claude Stop completion verification with hard blocking | Completion Verification, Claude Stop protocol, Done Signal preserve/clear |
| #26 Port core when conditions needed by Claude defaults | `when` conditions, source/test globs, churn, modified-since-last-run |
| #27 Record post-tool observations in clean session state | Post Tool, Post Tool Failure, command results, file edits, observations |
| #28 Support clean-runtime async and parallel task lifecycle | async tasks, parallel batches, harvesting, cancellation integration |
| #29 Add reviewer task abstraction with active-harness backend | Reviewer Tasks, reviewer prompt/config/verdict semantics, active harness backend |
| #30 Port reviewer backchannel appeal suspension and reset behavior | appeals, backchannels, suspension, failure reset |
| #31 Port session control disable enable and cancel | disable, enable, cancel, disabled-session hook behavior |
| #32 Port phase and plan-file behavior onto clean runtime | phase state, plan block injection, plan-mode tool mapping |
| #33 Port TaskCompleted auto-signaling behavior | TaskCompleted event, auto-signal, plan-to-stop flow |
| #34 Express current Claude defaults as clean prove_it profile | default tasks, reviewer suite, clean profile/default config |
| #35 Cut Claude dispatch over to clean runtime and retire legacy config loading | final cutover, legacy config quarantine/removal, doctor diagnostics |
| #36 Document Claude hard break parity behavior and worktree implications | user docs, hard-break notes, future Worktree implications |

## Stage mapping target

| Current Claude source | Clean-runtime term | Target owner |
| --- | --- | --- |
| `SessionStart` Claude Hook | **Session Start** Workflow Stage | Core pipeline + Claude Adapter rendering |
| `PreToolUse` Claude Hook | **Pre Tool** Workflow Stage | Core policy/task evaluation + Claude Adapter hard-block rendering |
| `PostToolUse` Claude Hook | **Post Tool** Workflow Stage | Core observation/task evaluation + Claude Adapter context rendering |
| `PostToolUseFailure` Claude Hook | **Post Tool Failure** Workflow Stage | Core observation/task evaluation + Claude Adapter context rendering |
| `Stop` Claude Hook | **Completion Verification** Workflow Stage via **Claude Stop** | Core verification + Claude Adapter hard-block rendering |
| `TaskCompleted` Claude Hook | Adapter event that can update **Session State** / **Signal** | Claude Adapter mechanic, core signal APIs |
| `Bash` command interception | **Command Interception** | Claude Adapter command detection + core signal/session-control APIs |
| `pre-commit`, `pre-push` | **Git Workflow** | Core Git Workflow + install artifacts |

## Classification legend

- **Core Platform Capability**: Product behavior that belongs in the harness-neutral **Workflow Engine** and should work for every capable **Adapter**.
- **Claude Adapter mechanic**: Claude-specific event mapping, protocol shape, path extraction, environment integration, or hook registration.
- **Clean profile/default**: Built-in **Profile** or default `.prove_it` workflow behavior, not hard-coded dispatcher behavior.
- **Intentionally removed**: A hard-break behavior that should not be preserved without a new explicit decision.

## Behavior inventory

### 1. Session Start

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Parses Claude hook input and degrades malformed JSON to non-blocking output. | Claude Adapter mechanic | Claude Adapter owns wire input parsing and circuit-breaker rendering. | `test/integration/config_error_circuit_breaker.integration.test.js`; `test/protocol.test.js` | Add a focused malformed `SessionStart` characterization if current coverage is only generic. |
| Records a lazy **Session Baseline** with git HEAD/status once per `session_id`. | Core Platform Capability | Core **Session State** should capture baseline through a Changed Files Provider / git state provider. | `test/session.test.js`; indirect coverage in `test/integration/config_behavior.integration.test.js` | Add explicit Claude `SessionStart` baseline characterization, including non-git project behavior. |
| Honors `PROVE_IT_DISABLED` env var with silent no-op. | Core Platform Capability + Claude Adapter mechanic | Core session/global control decides disabled; Claude Adapter exits silently. | `test/integration/core_hooks.integration.test.js`; `test/integration/config_behavior.integration.test.js` | None critical. |
| Honors session disabled sentinel. On `SessionStart` startup/resume, still exports `PROVE_IT_SESSION_ID` and emits a reminder `systemMessage`; other hooks silently no-op. | Core Platform Capability + Claude Adapter mechanic | Core **Session Control** state; Claude Adapter renders env-file export and reminder. | `test/disable.test.js`; `test/integration/disable.integration.test.js` | Add characterization for `SessionStart` disabled on `startup` vs `resume` vs `clear`/`compact`. |
| Honors ignored paths from global config. | Core Platform Capability | Clean global `.prove_it` config should keep ignored worktree/project support or an equivalent capability. | `test/config.test.js`; `test/integration/config_behavior.integration.test.js` | Decide whether ignored paths remain global-only; add clean config test. |
| Loads Legacy Runtime config from defaults, global `~/.claude/prove_it/config.json`, ancestor `.claude/prove_it/config.json`, and cwd `.claude/prove_it/config.local.json`. | Intentionally removed, with clean replacement | Replace with strict clean profile/global/project/local `.prove_it` Effective Config. Do not read Claude Legacy Config. | `test/config.test.js`; `test/integration/config_behavior.integration.test.js` | Add explicit negative Claude clean-runtime test: `.claude/prove_it` present but ignored. |
| Invalid config disables hooks, logs once, emits prominent `additionalContext` and `systemMessage` on `SessionStart`. | Core Platform Capability + Claude Adapter mechanic | Config validation failures should produce a diagnostics Effect; Claude Adapter renders context/system message. | `test/integration/config_error_circuit_breaker.integration.test.js`; `test/validate.test.js` | Add strict `.prove_it` validation failure parity test for Claude. |
| If no tasks exist, still exports `PROVE_IT_SESSION_ID` on `startup`/`resume`; otherwise exits silently. | Claude Adapter mechanic + Core Session State | Keep env export so `prove_it enable/disable/cancel` commands can work in Claude. | `test/integration/empty_hooks_bail.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js` | Add explicit no-task `SessionStart` env-file test. |
| Cleans async result directory on `source: startup` and prunes old sessions. | Core Platform Capability | Workflow Engine/session storage owns stale async cleanup; adapter supplies session id and source. | `test/integration/async_task.integration.test.js`; `test/dispatcher.test.js`; `test/session.test.js` | Add prune behavior characterization if retention rules are ported. |
| Runs matching `SessionStart` tasks filtered by `source`. Script task output becomes `additionalContext`; task failure is non-blocking and becomes context/system message. | Core Platform Capability + Claude Adapter mechanic | Core Session Start pipeline; Claude Adapter renders context injection. | `test/dispatcher.test.js`; `test/integration/core_hooks.integration.test.js`; `test/integration/session_start_types.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js` | Add source-specific characterization for `clear` and `compact`. |
| `env` tasks run only on `startup`/`resume`, parse command output as env vars, append shell exports to `CLAUDE_ENV_FILE`, and report var names in context. | Core Environment Injection capability + Claude Adapter mechanic | Core task result can emit Environment Injection Effects; Claude Adapter writes Claude Env File syntax. | `test/env_check.test.js`; `test/integration/env_check.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js` | Add clean-runtime env task parity test before porting. |
| Collects `briefing` strings from enabled tasks across all hooks and includes them on Session Start. | Clean profile/default + Core Context Injection | Preserve as profile-rendered methodology/task briefing behavior, not as Claude-only hidden scan if possible. | `test/briefing.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js` | Add characterization that disabled tasks' briefings are excluded and inherited tasks are included. |
| Default `session-briefing` task runs `$(prove_it prefix)/libexec/briefing`. | Clean profile/default | Express as strict profile Session Start default if retained. | `test/briefing.test.js`; `test/init.test.js`; `test/libexec.test.js` | Decide whether briefing is a Script Task or built-in profile renderer in clean runtime. |
| Claude hook output uses `hookSpecificOutput.hookEventName = "SessionStart"`, optional `additionalContext`, optional top-level `systemMessage`. | Claude Adapter mechanic | Claude Protocol Renderer owns exact JSON. | `test/protocol.test.js`; `test/integration/hook_contract.integration.test.js` | None. |

### 2. Pre Tool / PreToolUse

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Filters tasks by Claude tool-name `matcher` using full-regex semantics with exact split fallback on invalid regex. | Core pipeline matching + Claude Adapter input normalization | Core task selection should operate on normalized tool name; Claude Adapter supplies `tool_name`. | `test/dispatcher.test.js`; `test/command_matching.test.js` | Add invalid-regex integration characterization if not already present. |
| Filters Bash tasks by `triggers` regex against `tool_input.command`. | Core Platform Capability + Claude Adapter input normalization | Keep command-trigger matching for Command Interception / task gating. | `test/dispatcher.test.js`; `test/integration/core_hooks.integration.test.js` | Add multiple trigger and invalid trigger integration tests if port changes matcher code. |
| Tracks file edits and gross churn for built-in edit tools plus `fileEditingTools` before user tasks run. Resolves realpaths, supports `file_path` and `notebook_path`, checks source globs, records per-session edits, increments gross written lines. | Core Platform Capability with Claude Adapter path extraction | Core Observation recording; Claude Adapter normalizes Claude tool payload paths. | `test/dispatcher.test.js`; `test/integration/gross_churn.integration.test.js`; `test/integration/config_behavior.integration.test.js`; `test/git.test.js` | Add characterization for `MultiEdit`, `NotebookEdit`, custom file editing tools, and absolute symlink paths if not already explicit. |
| Intercepts valid `prove_it signal <done|stuck|idle> [--message ...]` Bash commands before matching user tasks can deny. Records Signal, logs SET, returns context without denying. Unknown signal types fall through to CLI. | Core Signal lifecycle + Claude Adapter Command Interception | Signal parser/state update belongs in core; Bash command detection and Claude pass-context rendering belong in Claude Adapter. | `test/integration/signal.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js`; `test/redesign_signal_lifecycle.test.js` | Add exact command-shape characterization for path-prefixed `prove_it`, extra shell syntax, and `idle`. |
| Intercepts valid `prove_it phase <plan|implement|refactor|...>` Bash commands, records phase, logs SET, emits system message telling Claude to continue. Unknown phase types fall through. | Phase is a Platform Capability for Claude parity; Bash detection is Claude Adapter mechanic | Port because issue #32 depends on parity, but keep phase separate from mandatory core methodology. | `test/integration/phase.integration.test.js`; `test/dispatcher.test.js`; `test/session.test.js` | Add clean-runtime phase tests before porting; decide public clean config/state shape. |
| `EnterPlanMode` sets phase to `plan` and still allows matching tasks to run. | Claude Adapter mechanic + phase state capability | Claude Adapter maps Claude plan-mode tool to phase state. | `test/integration/phase.integration.test.js`; `test/integration/plan_mode.integration.test.js`; `test/dispatcher.test.js` | Add test for matching EnterPlanMode task failure semantics if port changes flow. |
| `ExitPlanMode` may inject signal and phase blocks into plan files when any configured task is `when: { signal: "done" }`; then matching tasks still run. | Platform phase/plan capability + Claude Adapter tool mapping | Keep plan-file injection for Claude parity; adapter owns Claude `ExitPlanMode` payload and plan discovery. | `test/integration/plan_mode.integration.test.js`; `test/plan.test.js`; `test/dispatcher.test.js` | Add characterization for missing plans dir, ambiguous plan text, and write failures as graceful no-ops. |
| Backchannel bypass allows writes under `.claude/prove_it/sessions/<session>/backchannel/<task>/...` before matching tasks can deny. | Core appeal/backchannel capability + Claude Adapter path mechanic | Core can mark backchannel paths/suspensions; Claude Adapter path guard renders allow. Clean path should move under `.prove_it` session state if filesystem backchannels remain. | `test/integration/claude_enforcement_characterization.integration.test.js`; `test/integration/backchannel_bypass.integration.test.js`; `test/arbiter.test.js` | Add realpath/symlink/macOS alias characterization before changing path code. |
| Config guard default script denies edits to protected `.claude/prove_it` config files through edit tools or Bash redirects. | Core Platform Capability + clean profile/default; old path intentionally removed | Future default protects `.prove_it/config.json` and `.prove_it/config.local.json`; `.claude/prove_it` protection only if legacy artifacts still exist in the worktree and an explicit transition policy says so. | `test/integration/claude_enforcement_characterization.integration.test.js`; `test/libexec.test.js`; `test/pi_adapter.test.js`; `test/target_paths.test.js` | Add Claude clean-runtime config-guard test for `.prove_it` paths and negative test that `.claude/prove_it` is not config input. |
| Default `test-first` script blocks too many untested source edits. | Clean profile/default + Core Pre Tool policy | Express as profile task or methodology policy; keep Script Task execution generic. | `test/integration/test_first.integration.test.js`; `test/test_first_state_machine.test.js`; `test/libexec.test.js` | Add profile-default coverage after clean profile is built. |
| Default `verify-assumptions` plan-exit task injects a blocking reminder via echo on `ExitPlanMode`. | Clean profile/default | Keep only if profile wants Claude plan discipline; likely profile task, not core invariant. | `test/init.test.js`; `test/integration/plan_mode.integration.test.js` | Add explicit characterization of task output/decision on `ExitPlanMode`. |
| PreToolUse failure emits Claude `permissionDecision: "deny"`; pass/context emits no permissionDecision and uses `additionalContext`. | Claude Adapter mechanic | Claude Protocol Renderer owns the difference between hard block and context pass. | `test/protocol.test.js`; `test/integration/hook_contract.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js` | None. |

### 3. Post Tool / PostToolUse

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Runs `PostToolUse` tasks matched by tool name after successful tool calls. | Core Platform Capability + Claude Adapter event mapping | Core Post Tool pipeline with normalized tool result input. | `test/integration/post_tool_use.integration.test.js`; `test/dispatcher.test.js` | Add characterization for failing PostToolUse script decision shape if not covered elsewhere. |
| Provides `tool_input` and `tool_response` to Script/Reviewer Tasks via stdin/context. | Core Observation + Claude Adapter input normalization | Core task context should include normalized Observation; adapter supplies Claude raw fields. | `test/integration/post_tool_use.integration.test.js`; `test/integration/script_check.integration.test.js` | Add explicit assertion on script stdin for `tool_response` content. |
| Logs Bash command results at infrastructure level when `tool_name === "Bash"`. | Core Observation; Claude Adapter identifies Bash command | Keep command outcome observation separate from task pipeline. | `test/session.test.js`; indirect `test/integration/config_behavior.integration.test.js` | Add explicit PostToolUse Bash command-result characterization. |
| Harvests passing async results on non-Stop hooks and includes context; holds blocking async failures until Completion Verification. | Core async lifecycle | Workflow Engine owns async harvest policy. | `test/integration/async_task.integration.test.js`; `test/dispatcher.test.js` | None critical. |
| Emits `hookSpecificOutput.hookEventName = "PostToolUse"`, optional `additionalContext`, no top-level decision. | Claude Adapter mechanic | Claude Protocol Renderer owns exact shape. | `test/integration/post_tool_use.integration.test.js`; `test/protocol.test.js`; `test/integration/hook_contract.integration.test.js` | None. |
| Default async `nag-testing-antipatterns` reviewer runs when test files were edited. | Clean profile/default + Reviewer Task Platform Capability | Express as clean profile Reviewer Task if retained. | `test/init.test.js`; `test/integration/async_task.integration.test.js`; `test/integration/agent_check.integration.test.js` | Add clean profile characterization for this default before port. |

### 4. Post Tool Failure / PostToolUseFailure

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Runs `PostToolUseFailure` tasks matched by tool name after failed tool calls. | Core Platform Capability + Claude Adapter event mapping | Core Post Tool Failure pipeline with normalized error Observation. | `test/integration/post_tool_use.integration.test.js`; `test/dispatcher.test.js` | Add failure-task blocking/pass semantics test if behavior changes. |
| Provides `tool_input` and `error` in task context; Bash command failures are logged as command observations. | Core Observation + Claude Adapter input normalization | Core should record failure Observation; adapter supplies Claude error field. | `test/integration/post_tool_use.integration.test.js`; `test/session.test.js` | Add explicit Bash failure command-result characterization. |
| Same async policy as Post Tool: passing results can surface, failures wait for Stop. | Core async lifecycle | Preserve in Workflow Engine. | `test/integration/async_task.integration.test.js` | None critical. |
| Emits `hookSpecificOutput.hookEventName = "PostToolUseFailure"`, optional `additionalContext`, no `decision`. | Claude Adapter mechanic | Claude Protocol Renderer owns exact shape. | `test/integration/post_tool_use.integration.test.js`; `test/protocol.test.js` | None. |

### 5. Completion Verification / Claude Stop

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Runs matching Stop tasks in order; first non-skipped failure hard-blocks Claude Stop with `decision: "block"`. Pass emits `decision: "approve"`. | Core Completion Verification + Claude Adapter hard-block rendering | Core emits pass/fail verification Effect; Claude Adapter renders hard block/approve. | `test/integration/core_hooks.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js`; `test/protocol.test.js` | None. |
| `when: { signal: "done" }` gates tasks on active Done Signal; successful Stop clears Done Signal; failed Stop preserves it. Stuck/idle settlement differs by signal lifecycle rules. | Core Signal lifecycle | Centralize in shared signal lifecycle above adapters. | `test/integration/signal.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js`; `test/redesign_signal_lifecycle.test.js`; `test/session.test.js` | Add clean Claude Stop tests for `stuck` and `idle` settlement if not explicit. |
| Harvests async results before sync tasks. Blocking async failures block Stop; passing/skipped results are logged and consumed. Multiple failures are consumed one at a time so surviving failures can block later Stops. | Core async lifecycle | Workflow Engine owns harvest ordering and failure persistence. | `test/integration/async_task.integration.test.js`; `test/dispatcher.test.js` | None. |
| Spawns `async: true` tasks fire-and-forget on non-SessionStart hooks. SessionStart ignores async and runs synchronously. | Core async lifecycle + profile validation | Preserve in task runner; validate async/parallel constraints. | `test/integration/async_task.integration.test.js`; `test/dispatcher.test.js`; `test/validate.test.js` | None. |
| Forks `parallel: true` tasks, awaits batch after serial loop, fail-fast kills sibling children, cleans orphaned result files. SessionStart ignores parallel and runs synchronously. | Core parallel task capability | Workflow Engine/task runner owns parallel batch semantics. | `test/integration/parallel_task.integration.test.js`; `test/integration/parallel_fork.integration.test.js`; `test/dispatcher.test.js`; `test/validate.test.js` | Add timeout/cancellation characterization for parallel children if port rewrites process model. |
| Writes dispatcher PID while running; `prove_it cancel` sentinel causes approve/pass and cleans sentinel/PID. | Core Session Control + Claude Adapter process mechanic | Session Control is core; PID/sentinel process killing is adapter/runtime implementation detail. | `test/cancel.test.js`; `test/integration/cancel.integration.test.js` | Add test for cancel during long parallel batch if process model changes. |
| After successful Stop, saves current git HEAD as `LAST_STOP_HEAD`, resets turn tracking, and resets phase to `unknown` only when a Done Signal was settled. | Core Session State + phase capability | Preserve completion bookkeeping in Workflow Engine/session state. | `test/integration/phase.integration.test.js`; `test/integration/config_behavior.integration.test.js`; `test/session.test.js`; `test/git.test.js` | Add explicit `LAST_STOP_HEAD` integration test if not already direct. |
| Crashed tasks log `BOOM` and are treated as skipped/pass with warning rather than failing closed. | Core task settlement policy | Decide deliberately; current parity target should preserve unless product policy changes. | `test/integration/core_hooks.integration.test.js`; `test/integration/git_dispatcher.integration.test.js` | Add clean-runtime task-crash policy test. |
| Quiet tasks suppress pass/skip output and pass logs, but failures still surface. | Core task settlement policy | Preserve in task result settlement. | `test/integration/core_hooks.integration.test.js`; `test/dispatcher.test.js` | None. |
| Default Stop tasks include fast tests on source edits, full tests in parallel when Done Signal and source edits, plus default reviewers. | Clean profile/default + Core Completion Verification | Express through the clean profile/default `.prove_it` pipelines, not hard-coded adapter behavior. | `test/init.test.js`; `test/integration/config_behavior.integration.test.js`; `test/integration/async_task.integration.test.js`; `test/integration/parallel_task.integration.test.js` | Add strict profile snapshot/behavior tests before replacing Legacy Runtime defaults. |

### 6. TaskCompleted auto-signaling

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| If any configured Claude task is Done-Signal gated and Claude emits `TaskCompleted` whose `task_subject` matches the signal-task pattern, set Done Signal unless already done. | Claude Adapter mechanic using core Signal API | Keep as Claude Adapter behavior because `TaskCompleted` is a Claude Hook. The Signal state transition is core. | `test/integration/task_completed.integration.test.js`; `test/dispatcher.test.js` | Add clean-runtime test that behavior depends on Effective Config's Done-gated tasks, not Legacy Runtime hooks. |
| Emits no hook output and exits after auto-signal handling. | Claude Adapter mechanic | Preserve Claude protocol no-op. | `test/integration/task_completed.integration.test.js` | None. |
| End-to-end plan flow: ExitPlanMode injects signal step, TaskCompleted marks done, Stop runs Done-gated task. | Mixed: phase/plan capability + Claude Adapter events + core signal | Preserve for Claude parity, but keep Claude tool/event names out of core. | `test/integration/task_completed.integration.test.js`; `test/integration/plan_mode.integration.test.js` | Add characterization for multiple concurrent sessions. |

### 7. Bash command interception

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| `prove_it signal ...` command is intercepted in PreToolUse before the shell command runs, preventing user tasks from denying it. | Claude Adapter Command Interception + core Signal lifecycle | Claude Adapter parses Bash command; Workflow Engine/session state applies Signal. | `test/integration/signal.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js`; `test/redesign_signal_lifecycle.test.js` | Add quoting/compound-command characterization before parser rewrite. |
| `prove_it phase ...` command is intercepted similarly. | Claude Adapter Command Interception + phase state capability | Keep for Claude; Pi may expose a different tool/command. | `test/integration/phase.integration.test.js` | Add parser unit coverage for path-prefixed command and shell wrappers. |
| Intercepted commands emit context/system messages but no hard permission decision. Unknown commands fall through to actual CLI execution. | Claude Adapter mechanic | Preserve Claude render behavior. | `test/integration/signal.integration.test.js`; `test/integration/phase.integration.test.js` | None. |
| Session-scoped CLI commands (`disable`, `enable`, `cancel`) require `PROVE_IT_SESSION_ID`, which SessionStart exports via Claude Env File. | Core Session Control + Claude Adapter env mechanic | Preserve with Claude Env File or another Claude-native session context channel. | `test/disable.test.js`; `test/cancel.test.js`; `test/integration/disable.integration.test.js`; `test/integration/cancel.integration.test.js` | Add end-to-end `SessionStart` → `! prove_it disable` env dependency test if not covered. |

### 8. Signal lifecycle

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Valid Signals are accountability state: Done, Stuck, Idle, with optional message. | Core Platform Capability | Keep centralized in shared signal lifecycle. | `test/redesign_signal_lifecycle.test.js`; `test/session.test.js`; `test/integration/signal.integration.test.js` | None. |
| Done Signal activates heavier Completion Verification and persists across failed verification. | Core Platform Capability | Preserve as methodology invariant. | `test/integration/signal.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js`; `UBIQUITOUS_LANGUAGE.md` | None. |
| Successful Completion Verification clears Done Signal. | Core Platform Capability | Preserve. | `test/integration/signal.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js` | None. |
| Phase resets to unknown only when Done Signal settlement succeeds. | Core phase/session state capability | Preserve for Claude parity. | `test/integration/phase.integration.test.js` | None. |
| Signals are stored per `session_id` under prove_it session state. | Core State Port + adapter storage | Keep behind State Port; Claude storage path is adapter/runtime detail. | `test/session.test.js`; `test/redesign_signal_lifecycle.test.js` | Add worktree/session isolation tests for clean `.prove_it` state layout. |

### 9. Phase and plan behavior

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Phase state supports plan/implement/refactor/unknown and is usable in `when: { phase: ... }`. | Platform Capability for Claude parity | Port to clean runtime as optional workflow/session state capability, not mandatory methodology invariant. | `test/integration/phase.integration.test.js`; `test/dispatcher.test.js`; `test/session.test.js` | Add strict config schema for phase conditions. |
| Plan mode tool hooks set phase and inject plan-file blocks. | Claude Adapter mechanic + phase/plan capability | Claude Adapter owns `EnterPlanMode`/`ExitPlanMode`; core owns plan block intent if generalized. | `test/integration/plan_mode.integration.test.js`; `test/plan.test.js` | Add clean-runtime adapter test for Claude plan-mode payload. |
| `libexec/inject-plan` can insert configured blocks by marker/position. | Clean profile/default Script Task + core Script Task execution | Retain as profile task if plan guidance remains default. | `test/integration/inject-plan.integration.test.js`; `test/libexec.test.js` | Decide whether plan injection belongs in profile defaults or separate opt-in. |
| Signal plan marker is exact command string and TaskCompleted pattern is permissive. | Claude Adapter mechanic + plan default | Preserve only for Claude TaskCompleted auto-signal parity. | `test/dispatcher.test.js`; `test/integration/task_completed.integration.test.js` | None. |

### 10. Async and parallel tasks

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| `async: true` is fire-and-forget; worker writes context/result files under session async dir; next hooks harvest. | Core Platform Capability | Workflow Engine/task runner should own async lifecycle behind State Port/task execution ports. | `test/integration/async_task.integration.test.js`; `test/dispatcher.test.js`; `test/session.test.js` | Add clean State Port abstraction tests if moving off filesystem. |
| Passing async results can appear on Post Tool context; blocking failures are deferred to Completion Verification. | Core Platform Capability | Preserve policy. | `test/integration/async_task.integration.test.js` | None. |
| `parallel: true` forks child tasks and awaits during same hook; mutually exclusive with async. | Core Platform Capability | Preserve. | `test/integration/parallel_task.integration.test.js`; `test/integration/parallel_fork.integration.test.js`; `test/validate.test.js` | None. |
| SessionStart warns/ignores async/parallel and runs synchronously. | Core task validation/settlement policy | Preserve or replace with strict config error only by explicit break. | `test/integration/async_task.integration.test.js`; `test/integration/parallel_task.integration.test.js`; `test/validate.test.js` | If changing to hard validation, document as intentional break. |

### 11. Reviewers

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| `type: "agent"` tasks run Reviewer subprocesses, distinct from Primary Agent. | Core Reviewer Task + Claude Adapter reviewer backend | Core defines Reviewer Task contract; Claude Adapter/backend invokes Claude safely. | `test/reviewer.test.js`; `test/integration/agent_check.integration.test.js`; `test/integration/reviewer.integration.test.js` | Add clean active-harness reviewer abstraction tests before port. |
| Reviewer prompts support inline text, `promptType: "skill"`, templates, rule files, diffs, tool context, and test output context. | Core Reviewer Task + profile assets | Keep prompt rendering in core/template layer; skill installation/resolution is adapter/distribution-owned. | `test/template.test.js`; `test/integration/template.integration.test.js`; `test/integration/reviewer_prompt.integration.test.js`; `test/skills.test.js`; `test/prove-*.test.js` | Add strict profile skill-name mapping tests. |
| Reviewer model defaults vary by hook; task model overrides; top-level model applies when configured by user; `maxAgentTurns`, `allowedTools`, and bypass permissions are passed. | Core Reviewer Task config + Claude Adapter backend | Preserve config semantics in strict schema/profile, but use clean names. | `test/init.test.js`; `test/integration/config_behavior.integration.test.js`; `test/integration/reviewer_max_turns.integration.test.js`; `test/integration/reviewer_shim.integration.test.js` | Add characterization for default model when no user model is set in clean config. |
| Verdict classification maps reviewer output to pass/fail/skip/error. | Core Reviewer Task | Preserve classifier behavior. | `test/integration/classify_verdict.integration.test.js`; `test/reviewer.test.js` | None. |
| Default reviewers: coverage async on high churn, done-review parallel on Done Signal, UI design parallel when rule file exists, approach-review parallel on Stuck Signal, testing-antipatterns async on test edits. | Clean profile/default + Core Reviewer Task | Express in profile/default config. | `test/init.test.js`; `test/integration/async_task.integration.test.js`; `test/integration/parallel_task.integration.test.js` | Add profile snapshot tests for all default reviewer pipelines. |

### 12. Appeals and backchannels

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Failing Script Tasks go through arbiter appeal flow; repeated failures can create task backchannel/suspension state. | Core Platform Capability | Preserve as core task-failure appeal/backchannel model if still product policy. | `test/arbiter.test.js`; `test/integration/backchannel_bypass.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js` | Add end-to-end repeated failure → suspension → reset characterization before port. |
| Writes to backchannel paths are allowed before normal PreToolUse denial. | Claude Adapter mechanic + core appeal state | Claude Adapter owns file path allowlist rendering; core owns backchannel location/state. | `test/integration/backchannel_bypass.integration.test.js`; `test/integration/claude_enforcement_characterization.integration.test.js` | Add realpath-aware tests for clean `.prove_it` path. |
| Passing Script Tasks reset failure counts and clean backchannel files. | Core Platform Capability | Preserve in task settlement. | `test/arbiter.test.js`; indirect integration coverage | Add explicit integration test for cleanup after pass. |

### 13. Disable, enable, and cancel

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| `prove_it disable` writes a session disabled sentinel and prints instructions; requires `PROVE_IT_SESSION_ID`. | Core Session Control + Claude Adapter env integration | Preserve as session control API/CLI. | `test/disable.test.js`; `test/integration/disable.integration.test.js` | Add clean state path test. |
| `prove_it enable` clears disabled sentinel idempotently. | Core Session Control | Preserve. | `test/disable.test.js`; `test/integration/disable.integration.test.js` | None. |
| Disabled sessions no-op hooks; SessionStart emits reminder and env export. | Core Session Control + Claude Adapter rendering | Preserve. | `test/integration/disable.integration.test.js` | Add source variants as noted. |
| `prove_it cancel` writes a cancel sentinel and kills current dispatcher PID if available; dispatcher approves/pass with cancellation message after current task checkpoint. | Core Session Control + process mechanic | Preserve command semantics; process-kill implementation can remain adapter/runtime-specific. | `test/cancel.test.js`; `test/integration/cancel.integration.test.js` | Add cancellation during async/parallel/reviewer if process model changes. |

### 14. Git workflows and git hooks

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Git dispatcher runs only when `CLAUDECODE` is present; human commits are instant no-ops. | Claude Adapter / current product policy | Decide explicitly for clean runtime. For Claude parity, preserve unless Git Workflows become harness-neutral outside Claude sessions. | `test/integration/core_hooks.integration.test.js` | Add clean-runtime policy test for non-Claude git invocation. |
| Reads Legacy Runtime `hooks.git.pre-commit` / `pre-push` tasks, runs Script/Reviewer Tasks, fail-fast exits 1, pass exits 0. | Core Git Workflow; Legacy config shape intentionally removed | Express as `.prove_it` `git_workflows.pre_commit` / `pre_push` pipelines. | `test/integration/git_dispatcher.integration.test.js`; `test/integration/core_hooks.integration.test.js`; `test/integration/git.integration.test.js` | Add strict `.prove_it` git workflow tests before port. |
| Git tasks share `when`, taskEnv, sources, model, max turns, churn advancement, sticky failures, and quiet logging. | Core Platform Capability | Preserve in Workflow Engine task settlement. | `test/integration/git_dispatcher.integration.test.js`; `test/integration/git.integration.test.js`; `test/git.test.js` | None. |
| Project `init` installs or merges `.git/hooks/pre-commit` and `.git/hooks/pre-push` shims that call `prove_it hook git:<event>`. | Adapter/installation artifact + Git Workflow activation | Clean init should own generated Git hook artifacts via Ownership Manifest. | `test/init.test.js`; `test/integration/init.integration.test.js`; `test/integration/doctor.integration.test.js` | Add `.prove_it/ownership.json` git hook ownership tests. |

### 15. Config guard and config loading

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Legacy config defaults cascade from code defaults → global `~/.claude/prove_it` → ancestor `.claude/prove_it` configs → cwd `.claude/prove_it/config.local.json`; hooks merge by task name. | Intentionally removed, with clean replacement | Replace with profile/global/project/local `.prove_it` Effective Config, strict schema, pipeline patching, lineage/explain. | `test/config.test.js`; `test/defaults.test.js`; `test/redesign_config.test.js` | Add Claude Adapter test that uses clean Effective Config only. |
| Legacy generated config includes `initSeed` for upgrade/merge conflict behavior. | Intentionally removed unless clean Ownership Manifest/profile needs equivalent | Clean config should use schema/profile/ownership concepts, not Legacy Runtime seed semantics. | `test/init.test.js`; `test/conflict.test.js`; `test/upgrade.test.js` | Decide if clean project config has any seed/managed-block mechanism; test Ownership Manifest instead. |
| Legacy guard protects `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json`. | Old path intentionally removed; capability retained for `.prove_it` | Future guard protects `.prove_it/config.json` and `.prove_it/config.local.json`. | `test/integration/claude_enforcement_characterization.integration.test.js`; `test/libexec.test.js`; `test/target_paths.test.js` | Add explicit Claude `.prove_it` guard test. |
| Invalid Legacy Runtime config logs once per session and keeps hooks non-blocking except git dispatcher exits 1. | Core diagnostics + adapter-specific severity | Preserve diagnostics policy for clean config or intentionally tighten strict config failures. | `test/integration/config_error_circuit_breaker.integration.test.js`; `test/integration/git_dispatcher.integration.test.js` | Add strict `.prove_it` invalid config behavior tests for every Claude stage. |

### 16. Default tasks and clean profile target

Current Legacy Runtime defaults are generated by `lib/config.js` and `lib/defaults.js`. The clean target should express retained defaults as a versioned **Profile**, not as hidden Claude dispatcher behavior.

| Current default | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| Global install default: `enabled: true`, `maxAgentTurns`, `taskEnv.TURBOCOMMIT_DISABLED = 1`. | Clean profile/default or global config default | Represent as clean global config/profile defaults with strict schema. | `test/defaults.test.js`; `test/init.test.js`; `test/integration/config_behavior.integration.test.js` | Add clean global config tests. |
| Project default sources/tests globs and placeholder warning. | Clean profile/default + init UX | Preserve or redesign in strict config docs. | `test/init.test.js`; `test/validate.test.js` | Add clean init TODO/diagnostic test if retained. |
| Session briefing on SessionStart. | Clean profile/default | Keep if profile wants Claude orientation. | `test/briefing.test.js`; `test/init.test.js` | Add strict profile test. |
| Lock config on PreToolUse. | Core Platform Capability + clean profile/default | Protect `.prove_it` paths by default. | `test/libexec.test.js`; `test/pi_adapter.test.js` | Add Claude strict guard test. |
| Test-first on PreToolUse. | Clean profile/default | Retain as default methodology profile if still desired. | `test/integration/test_first.integration.test.js`; `test/test_first_state_machine.test.js` | Add clean profile test. |
| Verify assumptions and inject TDD plan on ExitPlanMode. | Clean profile/default, Claude plan-mode adapter mapping | Retain only as Claude/profile behavior. | `test/integration/plan_mode.integration.test.js`; `test/integration/inject-plan.integration.test.js` | Add profile decision test. |
| Fast tests on Stop when sources modified and source files edited. | Core Completion Verification + clean profile/default | Express as profile Completion Verification task. | `test/integration/config_behavior.integration.test.js`; `test/init.test.js` | Add clean profile Stop behavior test. |
| Full tests parallel on Done Signal and source edits. | Core Completion Verification + clean profile/default | Express as Done-gated profile task. | `test/integration/signal.integration.test.js`; `test/integration/parallel_task.integration.test.js`; `test/init.test.js` | Add clean profile Done-gated full-test test. |
| Default reviewer suite. | Core Reviewer Tasks + clean profile/default | Express as profile Reviewer Tasks. | `test/init.test.js`; reviewer integration tests | Add profile snapshot/behavior tests. |

### 17. Installation and adapter artifacts

| Legacy behavior | Classification | Clean target | Characterization tests | Missing before risky port |
| --- | --- | --- | --- | --- |
| `prove_it install` writes Claude Settings hook groups to `~/.claude/settings.json` for SessionStart, PreToolUse, PostToolUse, PostToolUseFailure, Stop, TaskCompleted. | Claude Adapter Artifact | Preserve hook registration as adapter activation, but it should dispatch into clean runtime using `.prove_it` Effective Config. | `test/integration/doctor.integration.test.js`; `test/init.test.js`; `test/claude_adapter.test.js` | Add clean install/update tests for Claude hook groups and Ownership Manifest if global ownership exists. |
| `prove_it install` writes global Legacy Config to `~/.claude/prove_it/config.json`. | Intentionally removed | Do not create or read global Claude Legacy Config for clean runtime. Use clean global `.prove_it` config if needed. | `test/init.test.js`; `test/config.test.js` | Add negative install test: no `.claude/prove_it/config.json` for clean Claude activation. |
| `prove_it install` installs Claude skills under `~/.claude/skills`, removes retired skills, prompts on conflicts. | Claude Adapter Artifact / distribution | Keep skill installation as Claude Adapter/distribution artifact if Reviewer Tasks use Claude skills. | `test/skills.test.js`; `test/init.test.js`; `test/conflict.test.js` | Add clean adapter skill artifact tests. |
| `prove_it init` legacy path writes `.claude/prove_it/config.json`, `.claude/prove_it/config.local.json`, `.claude/rules/*.md`, script stubs, git shims. | Legacy config intentionally removed; some artifacts retained as adapter/profile artifacts | Clean init writes `.prove_it/config.json`, `.prove_it/config.local.json`, `.prove_it/ownership.json`; Claude Settings remain adapter artifacts; rule files/skills need explicit clean location decision. | `test/init.test.js`; `test/integration/init.integration.test.js`; `test/redesign_init.test.js` | Add clean Claude init test that does not write `.claude/prove_it`. |
| `prove_it doctor` verifies Claude Settings hook groups, git shims, config currentness, strict adapters. | Core diagnostics + Claude Adapter diagnostics | Keep diagnostics but point source-of-truth checks at `.prove_it` for clean runtime. | `test/integration/doctor.integration.test.js` | Add doctor failure for stale `.claude/prove_it` assumption in clean mode. |
| `script/agent` prepends `test/bin/prove_it` so hooks use local source during development. | Development artifact | Preserve only as repo development workflow, not product runtime behavior. | `AGENTS.md`; `.claude/prove_it/config.json` local-shim-check | None for product cutover. |

## Intentionally removed behaviors and hard breaks

1. **Claude Legacy Config as runtime input**: `.claude/prove_it/config.json`, `.claude/prove_it/config.local.json`, and `~/.claude/prove_it/config.json` are not maintained as runtime config sources.
2. **Dual runtime state**: do not keep parallel `.claude/prove_it` and `.prove_it` state trees for active clean runtime behavior.
3. **One-time config migration command**: no migration command from Legacy Runtime config to strict `.prove_it` is planned for this cutover.
4. **Legacy `initSeed` upgrade semantics for clean config**: do not preserve unless a separate clean ownership/profile mechanism explicitly needs it.
5. **Claude-specific config paths in core**: `.claude/settings.json`, `CLAUDE_ENV_FILE`, Claude File History, Claude hook protocol, and Claude plan-mode tool names belong in the Claude Adapter, not the Workflow Engine.

Any additional removal must be recorded as a hard break with explicit rationale before implementation.

## Tests that currently serve as the parity oracle

High-value current characterization suites:

- `test/integration/claude_enforcement_characterization.integration.test.js` — compact oracle for config guard, Done Signal Stop blocking/settlement, backchannel bypass, SessionStart context/env, Bash signal interception.
- `test/integration/signal.integration.test.js` and `test/redesign_signal_lifecycle.test.js` — Signal lifecycle.
- `test/integration/phase.integration.test.js`, `test/integration/plan_mode.integration.test.js`, `test/integration/task_completed.integration.test.js`, `test/plan.test.js` — phase, plan, and TaskCompleted behavior.
- `test/integration/post_tool_use.integration.test.js` — Post Tool and Post Tool Failure protocol/task behavior.
- `test/integration/async_task.integration.test.js`, `test/integration/parallel_task.integration.test.js`, `test/integration/parallel_fork.integration.test.js`, `test/dispatcher.test.js` — async/parallel task lifecycle.
- `test/integration/reviewer_prompt.integration.test.js`, `test/integration/agent_check.integration.test.js`, `test/integration/reviewer_max_turns.integration.test.js`, `test/integration/reviewer_shim.integration.test.js`, `test/reviewer.test.js`, `test/template.test.js`, `test/skills.test.js` — Reviewer Task behavior.
- `test/arbiter.test.js`, `test/integration/backchannel_bypass.integration.test.js` — appeals/backchannels.
- `test/disable.test.js`, `test/cancel.test.js`, `test/integration/disable.integration.test.js`, `test/integration/cancel.integration.test.js` — Session Control.
- `test/integration/git_dispatcher.integration.test.js`, `test/integration/git.integration.test.js`, `test/git.test.js`, `test/integration/core_hooks.integration.test.js` — Git Workflow behavior.
- `test/config.test.js`, `test/defaults.test.js`, `test/validate.test.js`, `test/redesign_config.test.js`, `test/redesign_init.test.js`, `test/integration/doctor.integration.test.js`, `test/init.test.js`, `test/integration/init.integration.test.js` — config/default/install/diagnostic behavior.
- `test/protocol.test.js`, `test/integration/hook_contract.integration.test.js`, `test/claude_adapter.test.js` — Claude protocol and adapter seams.

## Missing characterization tests to add before porting risky behavior

Add these before implementing the corresponding port issues:

1. **Clean config source-of-truth negative tests**: Claude clean runtime ignores `.claude/prove_it` even when present; reads `.prove_it/config.json` instead.
2. **Claude `.prove_it` config guard end-to-end**: Pre Tool hard-blocks `.prove_it/config.json` and `.prove_it/config.local.json` through Edit/Write/MultiEdit/NotebookEdit/Bash payloads.
3. **SessionStart edge sources**: `startup`, `resume`, `clear`, and `compact` env/context differences, including disabled session behavior.
4. **Malformed/invalid strict config per stage**: Session Start, Pre Tool, Post Tool, Post Tool Failure, Completion Verification, and Git Workflow diagnostics.
5. **Bash command parser edges**: path-prefixed `prove_it`, quoted messages, compound commands, unknown signal/phase fallthrough, and `idle` signal.
6. **Post Tool Observation logging**: successful and failed Bash command results recorded as Observations with expected fields.
7. **Backchannel realpath parity**: symlink/macOS alias path handling for clean `.prove_it` backchannel paths.
8. **Reviewer backend abstraction**: active-harness Reviewer Task defaults vs explicit task model/max turns/allowed tools in clean config.
9. **Clean profile snapshot/behavior**: retained default tasks and reviewers expressed as profile/default `.prove_it` behavior.
10. **Git Workflow clean config**: `git_workflows.pre_commit` / `pre_push`, CLAUDECODE policy, git shim ownership, and doctor diagnostics.
11. **State/worktree isolation**: Session State, async results, backchannels, signals, and evidence are isolated by session and Worktree under the clean layout.

## Implementation guidance for later issues

- Start with adapter seams, not behavior rewrites. Extract Claude Hook registration and Claude protocol rendering behind the Claude Adapter while keeping tests green.
- Move behavior into the Workflow Engine only after a characterization test names the desired product behavior in Ubiquitous Language terms.
- Keep Claude-specific fields (`tool_name`, `tool_input.file_path`, `CLAUDE_ENV_FILE`, `hookSpecificOutput`, `decision: "block"`) at the adapter boundary.
- Use **Effects** as the handoff: block/pass/context injection/environment injection/remediation/session-state update.
- Treat the current dispatcher as the behavioral oracle until the corresponding clean-runtime test exists and passes.
- If a legacy behavior conflicts with the Methodology or clean architecture, stop and record it as an intentional hard break before removing it.
