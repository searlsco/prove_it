# Ubiquitous Language

## Product model

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **prove_it** | A methodology and workflow engine that makes coding agents prove consequential claims through configured verification. | Claude hook tool, Pi plugin, orchestrator agent |
| **Methodology** | The product rules for accountable agent behavior, especially completion, evidence, remediation, and reviewer use. | Prompt text, vibes, policy blob |
| **Workflow Engine** | The harness-neutral runtime that evaluates config, runs tasks, applies signal lifecycle rules, and emits effects. | Harness, adapter, dispatcher |
| **Clean Runtime** | The new strict `.prove_it` implementation of the Workflow Engine and adapter contract. | Redesign, Pi runtime, strict mode |
| **Legacy Runtime** | The old Claude-first `.claude/prove_it` implementation used as behavior reference during clean-runtime cutover. | Current runtime, compatibility mode |
| **Parity** | Equivalent prove_it product behavior across a cutover, even when adapter mechanics differ. | Byte-for-byte compatibility, lowest-common-denominator support |
| **Platform Capability** | A prove_it feature that should eventually work across adapters when a harness can support it. | Claude feature, plugin feature |

## Actors and execution environments

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Harness** | The host agent environment where the primary coding session runs, such as Claude Code, Pi, or Codex. | Runtime, provider, model |
| **Adapter** | The harness-specific integration that translates harness events into Workflow Engine events and renders effects back to the harness. | Harness, plugin, hook set |
| **Primary Agent** | The main coding agent performing the user's work inside a harness session. | Reviewer, subagent, prove_it |
| **Reviewer** | A secondary evaluation task that independently inspects the Primary Agent's work and returns a verdict. | Primary agent, subagent only, checker |
| **Active Harness** | The harness currently hosting the Primary Agent for a session. | Default model, reviewer backend |
| **Worktree** | A distinct checkout/workspace whose prove_it state, config, and evidence may need isolation. | Branch, repo, project only |

## Configuration and installation

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Project Config** | The shared strict repo config stored at `.prove_it/config.json`. | Claude config, local config |
| **Local Config** | Developer-local overrides stored at `.prove_it/config.local.json`. | Project config, user config |
| **Effective Config** | The resolved configuration after profile, global, project, and local layers are merged. | Raw config, loaded config |
| **Profile** | A versioned built-in methodology bundle containing default tasks and workflows. | Defaults, schema |
| **Schema Version** | The version of the public config file shape. | Profile version, config version |
| **Profile Version** | The pinned version of the built-in methodology/profile semantics. | Schema version, package version |
| **Ownership Manifest** | A `.prove_it` record of generated artifacts that prove_it may safely update or remove. | Lockfile, install state |
| **Adapter Artifact** | A harness-native generated file or package reference used to activate an adapter. | Workflow config, shared config |
| **Global CLI** | The `prove_it` command available on `PATH`, historically installed with Homebrew for Claude hooks. | Runtime, adapter package |
| **Adapter Package** | A harness-native distribution unit, such as `@davemo/pi-prove-it`, that loads adapter code. | CLI, Homebrew formula |

## Workflows and lifecycle

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Workflow Stage** | A normalized lifecycle point where prove_it may run a pipeline. | Hook, event name |
| **Pipeline** | The ordered task sequence configured for one Workflow Stage. | Hook group, checklist |
| **Task** | A named unit of workflow work that returns pass, fail, block, approve, or remediation information. | Hook, script only, check only |
| **Script Task** | A task that runs a local command through the task runner port. | Shell snippet, command task |
| **Reviewer Task** | A task that asks a Reviewer to evaluate work independently. | Agent check, subagent prompt |
| **Session Start** | The Workflow Stage for briefing, context injection, environment setup, and session bootstrap. | Claude SessionStart |
| **Pre Tool** | The Workflow Stage before a tool call where hard blocking guards can run. | Claude PreToolUse, Pi tool_call |
| **Post Tool** | The Workflow Stage after a successful tool call where observations may be recorded. | Claude PostToolUse |
| **Post Tool Failure** | The Workflow Stage after a failed tool call where failure observations may be recorded. | Claude PostToolUseFailure |
| **Completion Verification** | The Workflow Stage that verifies an active `done` signal before completion is accepted. | Stop, agent_end, turn_end |
| **Git Workflow** | A workflow triggered by a Git lifecycle point such as pre-commit or pre-push. | Agent workflow, Claude hook |

## Signals and completion accountability

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Signal** | Agent accountability state that declares the Primary Agent's current workflow intent. | User command, flag only |
| **Done Signal** | The signal meaning the Primary Agent believes a coherent unit of work is complete and ready for verification. | Finished, ship it, stop |
| **Stuck Signal** | The signal meaning the Primary Agent is blocked, looping, or needs intervention. | Failure, done failure |
| **Idle Signal** | The signal meaning the Primary Agent is intentionally between completion-verification loops. | Disabled, no-op |
| **Claim** | A consequential statement by the Primary Agent that work is complete or verified. | Status update, final answer |
| **Evidence** | Demonstrated proof such as passing checks, logs, artifacts, reviews, or manual verification notes. | Assertion, summary |
| **Remediation** | Follow-up work requested after verification fails when a harness cannot hard-block completion. | Retry, warning, failure only |
| **Hard Block** | An adapter effect that prevents a guarded tool call or completion from proceeding. | Deny text, remediation |
| **Observe Only** | An adapter capability that can record an event but cannot modify or block it. | Pass, disabled |

## State and observations

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Session State** | Per-session prove_it state such as signal, baseline, remediation status, observations, and control flags. | Config, cache |
| **State Port** | The adapter-provided storage boundary used by the Workflow Engine to read and write Session State. | Database, session implementation |
| **Observation** | A recorded fact about agent activity, such as command output, tool result, file edit, or reviewer result. | Log line, task result only |
| **Session Baseline** | The initial project state captured for later comparison during a session. | Git status only, snapshot only |
| **Changed Files Provider** | An adapter capability that reports files changed during or since a session point. | File history, git diff only |
| **Command Interception** | Adapter handling of a Primary Agent command before the harness executes it, such as `prove_it signal done`. | Shell parsing, task execution |
| **Session Control** | User or adapter controls that disable, enable, or cancel prove_it behavior for a session. | Config toggle, signal |

## Adapter capabilities

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Capability Profile** | A machine-readable declaration of what an adapter can enforce, observe, inject, or render. | Support tier, experimental flag |
| **Effect** | A harness-neutral outcome emitted by the Workflow Engine for an adapter to render. | Protocol JSON, hook output |
| **Effect Renderer** | Adapter code that translates Effects into harness-native output or API calls. | Workflow Engine, protocol only |
| **Protocol Renderer** | The subset of an Effect Renderer that emits a harness's wire format, such as Claude hook JSON. | Workflow Engine, config renderer |
| **Environment Injection** | An adapter capability that sets environment variables or shell context for future harness commands. | Env task, secret handling |
| **Context Injection** | An adapter capability that adds instructions or status context to the Primary Agent's session. | Prompt only, methodology itself |
| **Adapter-Owned Mechanic** | A harness-specific implementation detail that should not leak into the core product model. | Core feature, methodology |

## Claude adapter terms

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Claude Parity Cutover** | The hard-break move that ports existing Claude product behavior onto the Clean Runtime and `.prove_it` config. | Config migration, Claude MVP, partial fast-follow, dual-runtime support |
| **Claude Adapter** | The adapter that maps Claude Code hooks, settings, env files, Bash tools, and Stop decisions to prove_it. | Legacy dispatcher, Claude runtime |
| **Claude Hook** | A Claude Code lifecycle callback used by the Claude Adapter as a harness event source. | Workflow Stage, pipeline |
| **Claude Stop** | Claude Code's hard completion gate that the Claude Adapter uses for hard-blocking Completion Verification. | Agent end, turn end |
| **Claude Settings** | Harness-native configuration under `.claude/settings.json` that installs prove_it hook commands. | Project Config, `.claude/prove_it` config |
| **Claude Env File** | The `CLAUDE_ENV_FILE` mechanism used by Claude Code hooks to export variables into the session shell. | Local config, secret store |
| **Claude File History** | Claude-specific session/file snapshot data used to reconstruct edits or changed files. | Core state, git history |
| **Claude Legacy Config** | The retired `.claude/prove_it` task configuration used by the Legacy Runtime. | Project Config, clean config |

## Pi adapter terms

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Pi Adapter** | The adapter that maps Pi extension lifecycle events, tools, session entries, and follow-up messages to prove_it. | Pi harness, package only |
| **Pi Package** | The `@davemo/pi-prove-it` distribution package that loads the Pi Adapter and vendored runtime. | Homebrew package, global CLI |
| **Pi Signal Tool** | The model-callable `prove_it_signal` tool used by the Primary Agent in Pi to set prove_it signals. | Slash command, user-only signal |
| **Pi Remediation Loop** | The Pi completion-failure flow that queues a follow-up turn because Pi lacks Claude-style hard Stop blocking. | Stop block, failure log |
| **Turn End** | The Pi lifecycle point currently used to run and deliver completion remediation reliably. | Agent end only, Stop |
| **Agent End Settlement** | The Pi fallback lifecycle behavior that preserves signal settlement semantics around agent completion. | Primary completion mechanism |

## Relationships

- A **Harness** hosts one active **Primary Agent** per session.
- An **Adapter** connects exactly one **Harness** family to the **Workflow Engine**.
- The **Workflow Engine** evaluates the **Effective Config** and emits **Effects**.
- An **Effect Renderer** belongs to an **Adapter** and renders **Effects** into harness-native behavior.
- A **Project Config** defines **Tasks** and **Pipelines** for normalized **Workflow Stages**.
- A **Done Signal** activates **Completion Verification** for the current session.
- Failed **Completion Verification** preserves the **Done Signal** and produces either a **Hard Block** or **Remediation** depending on the adapter **Capability Profile**.
- Passing **Completion Verification** clears the **Done Signal**.
- A **Reviewer** is not the **Primary Agent**; it is invoked by a **Reviewer Task**.
- **Claude Settings** are an **Adapter Artifact**, not the **Project Config**.
- **Claude Legacy Config** is a cutover reference, not the Clean Runtime source of truth.
- A **Worktree** may eventually have distinct **Project Config**, **Session State**, and **Evidence** boundaries.

## Example dialogue

> **Dev:** "If Claude Code runs `prove_it hook claude:Stop`, is Claude the **Workflow Engine**?"
>
> **Domain expert:** "No. Claude Code is the **Harness**, the **Claude Adapter** translates the hook into **Completion Verification**, and the **Workflow Engine** evaluates the `.prove_it` **Project Config**."
>
> **Dev:** "If Pi can't hard-block completion like **Claude Stop**, does that mean Pi is unsupported?"
>
> **Domain expert:** "No. The **Pi Adapter** has a different **Capability Profile**: failed **Completion Verification** becomes a **Pi Remediation Loop** instead of a **Hard Block**."
>
> **Dev:** "For Justin's Claude workflow, do we keep `.claude/prove_it` around as a second config model?"
>
> **Domain expert:** "No. The **Claude Parity Cutover** ports product behavior into the **Clean Runtime** so `.prove_it/config.json` is the source of truth."
>
> **Dev:** "What about worktrees?"
>
> **Domain expert:** "Treat **Worktree** support as a future **Platform Capability**: state and evidence boundaries should be modeled in core, while each **Adapter** handles harness-specific mechanics."

## Flagged ambiguities

- "Harness" and "runtime" were used interchangeably; use **Harness** for the host agent environment and **Workflow Engine** or **Clean Runtime** for prove_it code.
- "Adapter" and "package" were blurred in Pi discussion; use **Adapter** for integration logic and **Pi Package** for distribution.
- "Generic harness" was used to mean the shared Node.js prove_it core; use **Workflow Engine** or **Clean Runtime** because Pi, Claude, and Codex are the actual harnesses.
- "Claude parity" can imply byte-for-byte legacy compatibility; use **Parity** to mean equivalent product behavior backed by `.prove_it`, not preservation of `.claude/prove_it` internals.
- "Legacy feature" risks dismissing behavior Justin depends on; classify each behavior as **Platform Capability**, **Adapter-Owned Mechanic**, or retired only after explicit decision.
- "Stop" is Claude-specific but often used as a universal concept; use **Completion Verification** in core and **Claude Stop** only for Claude's hard-blocking lifecycle event.
- "Agent" was used for both the main coding model and reviewers; use **Primary Agent** for the main actor and **Reviewer** for secondary evaluators.
- "Homebrew" was discussed as if it were runtime architecture; treat it as one distribution mechanism for the **Global CLI**, not as part of the product model.
- "Worktree" should not mean just Git branch; use **Worktree** for an isolated workspace boundary that may require separate state, evidence, and adapter activation.
