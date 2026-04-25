# prove_it Harness-Neutral Clean Redesign Brief

## Executive summary

This brief captures what we learned from the multi-adapter exploration branch and proposes a clean redesign path for making prove_it a harness-neutral methodology engine with adapter-specific enforcement for Claude, pi, Codex, and future agent harnesses.

The key conclusion is that prove_it should not be modeled as “Claude hooks generalized.” prove_it should define a product methodology above any one harness: agents make claims about completion, and prove_it makes those claims accountable through deterministic verification gates where possible and explicit remediation loops where hard blocking is unavailable.

Pi should be treated as the first clean-room proving-ground adapter. Claude should be treated as an existing behavioral reference and fast-follow adapter, not as the source of truth or compatibility substrate. Codex and other harnesses are deferred until Pi and Claude stabilize and should be modeled through the same adapter capability contract.

The current exploration branch proved many technical slices, but it also accumulated enough transitional code that a clean implementation branch from main is preferable. This document is intended to be the source of truth for that clean, Pi-first implementation.

## Product intent

prove_it exists because coding agents are prone to prematurely declaring victory. Its purpose is to make the primary agent prove its claims through checks, reviewer tasks, tests, and evidence-oriented workflows.

The product is not primarily a hook runner. It is a methodology engine that supervises agent work.

The core product behavior is:

1. The primary agent performs a coherent coding task.
2. prove_it supervises the session and tracks work.
3. The agent must not casually claim that work is done.
4. When the agent believes a coherent task is complete, the agent declares completion through a prove_it signal.
5. That signal activates heavier verification workflows.
6. If verification fails, prove_it forces or remediates continued work.
7. The signal persists across failures so the agent keeps re-running the relevant checks until they pass.
8. A successful verification clears the signal.
9. Only after verification passes may the agent honestly claim completion.

The important invariant is:

> prove_it does not remove agent judgment. It makes the agent’s consequential claims accountable.

## Lessons from the exploration branch

### What the branch proved

- pi can load a prove_it package containing an extension, bundled skills, and a vendored runtime.
- pi can hard-block tool calls through its `tool_call` lifecycle event.
- pi can enforce config guards on both redesign-native and legacy compatibility config paths.
- pi tool payloads use different path shapes than Claude, especially `input.path`; shared runtime logic must treat this as first-class.
- pi can observe successful and failed tool results through `tool_result`.
- pi can track source edits, test edits, command results, and post-tool conditions through lifecycle events.
- pi can run Stop-equivalent workflows after `agent_end`.
- pi can queue remediation follow-up messages when Stop-equivalent checks fail.
- pi-backed reviewer tasks can run through pi rather than Claude or Codex.
- pi-backed reviewers should defer to pi’s configured default model/provider unless a task explicitly sets a model.
- A self-contained pi package can be made portable by vendoring the runtime closure and testing it for drift.
- A redesign-native config model can compile into the existing executable runtime as an interim transition seam.
- Example repos can demonstrate Claude-only, pi-only, and multi-adapter shapes.
- A manual Claude-vs-pi comparison matrix can be partially automated.

### What the branch revealed as product concerns

- pi does not currently appear to expose a hard synchronous Stop-blocking primitive equivalent to Claude’s Stop hook.
- pi completion-verification failures therefore require a remediation loop after `agent_end`; this is a documented capability-profile difference, not a reason to label Pi experimental by default.
- Agent-initiated `done` signals are part of prove_it’s intended workflow. Treating signals as user-owned only would diverge from prove_it’s product intent.
- Signal semantics need to be centralized above adapters so pi, Claude, and future adapters render the same methodology in harness-native ways.
- Prompt guidance alone is not the product guarantee. Enforcement happens when agent declarations trigger workflow gates.
- Adapter capability differences should be explicit rather than hidden behind claims of perfect parity.
- The current implementation branch mixed research, redesign, docs rewrite, runtime bridging, and packaging into one large change set, making it valuable as a reference but risky as a final implementation path.

### Bugs or mismatches discovered

- pi initially allowed some config edits Claude blocked because pi built-in edit payloads used `input.path`.
- shared path-sensitive logic needed to recognize pi-style `path` fields across guarding, conditions, templates, edit tracking, and backchannel bypass.
- backchannel bypass needed realpath-aware canonicalization to handle macOS path aliases.
- pi signal/phase tools needed explicit schemas to avoid empty or undefined invocations.
- pi blocked tool calls could hang in the interactive TUI when the extension emitted a verbose notification and also returned a block result.
- default redesign config protection needed to include legacy compatibility config paths while those artifacts remain present.
- a missing import in legacy validation code was caught by prove_it’s own reviewer flow.

## Methodology invariants

The clean redesign should codify these invariants in a shared methodology layer, not in adapter-specific prose.

### Completion accountability

- The primary agent is expected to declare completion when it believes a coherent coding task is complete.
- Completion declaration must activate verification workflows.
- The agent must not declare completion after every edit, every file, or every test command.
- The agent must not use completion language such as “done,” “finished,” “complete,” or “ready to ship” unless it has declared completion and the resulting checks have passed.
- If work is incomplete, blocked, or intentionally intermediate, the agent should say so instead of declaring completion.

### Signals

- `done` means the primary agent believes a coherent unit of work is complete and ready for full verification.
- `stuck` means the primary agent is blocked, looping, or needs intervention.
- `idle` means the primary agent is between tasks or intentionally not in an active completion-verification loop.
- Signals are agent accountability state, not merely user commands.
- Users may override signal state, but normal workflow expects the agent to set signals according to the methodology.
- Signals persist when verification fails.
- Signals clear when the relevant verification workflow passes.

### Reviewer accountability

- Reviewer tasks are independent evaluation tasks, separate from the primary agent.
- Reviewer failures should give concrete reasons and create a remediation path.
- Reviewer backchannels are for honest appeals or additional context, not manipulation.
- Reviewer state should survive failure cycles enough to preserve continuity.

### Evidence orientation

- prove_it should prefer demonstrated evidence over claims.
- The `/prove` workflow is a manual form of the same methodology: run the thing, capture evidence, try to break it, and report honestly.
- The automatic workflow should reinforce the same value: tests, reviewers, scripts, and artifacts should prove claims rather than accept them.

## Harness capability model

Adapters should declare their enforcement capabilities explicitly. The workflow engine can then decide how to map methodology semantics onto each harness.

Potential capabilities:

- hard pre-tool blocking
- post-tool observation
- post-tool result modification
- hard stop blocking
- post-agent remediation
- session start context injection
- model-callable tools
- slash commands or command palette actions
- shell command interception
- shell environment injection
- session state persistence
- reviewer subagents
- packaged skills
- custom UI notifications
- custom status/footer rendering
- tool argument mutation
- command result capture
- background task execution

### Claude capability profile

Claude currently supports:

- hard pre-tool blocking through hooks
- hard Stop blocking through hooks
- session start context injection
- shell command interception for `prove_it signal` and `prove_it phase`
- environment-file integration
- Claude skills
- reviewer subprocesses through `claude -p`
- file-history access for session diffs
- hook-driven git workflow support

Claude is the strongest adapter for hard synchronous enforcement.

### pi capability profile

pi currently supports:

- hard pre-tool blocking through `tool_call`
- post-tool observation through `tool_result`
- session start and before-agent-start prompt injection
- custom model-callable tools
- slash commands
- session custom entries for state persistence
- `agent_end` for Stop-equivalent checks
- follow-up user messages for remediation
- extension and package distribution
- bundled skills
- reviewer subprocesses through pi invocation

pi currently lacks an identified hard Stop blocker equivalent to Claude’s Stop hook. Its Stop behavior should therefore be modeled as remediation-after-agent-end until pi exposes a stronger primitive.

### Codex capability profile

Codex should not be guessed into the architecture as a special case. The clean implementation should define a generic adapter contract first, then assess Codex against it.

Open questions for Codex:

- Can Codex block tool calls synchronously?
- Can Codex block session completion synchronously?
- Can Codex inject session-start methodology context?
- Can Codex expose model-callable tools or commands?
- Can Codex persist adapter-specific session state?
- Can Codex run reviewer subagents or subprocesses in an isolated way?
- Can Codex observe tool results and command outcomes?

## Adapter contract

Adapters should translate harness-native lifecycle events into prove_it workflow stages and translate prove_it effects back into harness-native behavior.

The adapter contract should include:

- identity and display metadata
- capability declaration
- install and uninstall operations
- project initialization and deinitialization operations
- lifecycle event mapping
- state read/write hooks
- methodology rendering hooks
- task execution constraints
- reviewer backend options
- remediation strategy
- diagnostics provider

The workflow engine should not know about Claude file paths, pi session custom entries, or Codex-specific APIs. Those belong inside adapters.

## Proposed shared module architecture

### Methodology module

A deep, testable module that defines prove_it’s harness-neutral behavioral rules:

- signal meanings
- completion declaration semantics
- stuck/idle semantics
- clear-on-pass and preserve-on-fail semantics
- reviewer failure/backchannel semantics
- evidence-oriented guidance
- adapter-neutral instruction blocks

This module should produce structured methodology data and renderable guidance, not hardcoded Claude or pi prose.

### Workflow engine module

A deep module that evaluates effective config and executes workflows:

- workflow stages
- pipelines
- tasks
- task conditions
- task result settlement
- state transitions
- cancellation
- async and parallel task coordination
- result/effect production

This module should emit harness-neutral effects such as allow, block, pass, fail, inject context, update state, or remediate.

### Adapter capability module

A deep module that represents harness capabilities and enforcement strengths:

- capability schema
- capability validation
- capability-driven behavior selection
- diagnostics for degraded parity

This module should make pi’s post-agent remediation model explicit rather than hidden.

### Config/profile module

A deep module for the public config model:

- schema version
- profile version
- project/global/local layers
- task registry
- agent workflows
- git workflows
- adapter configuration
- profile-driven defaults
- pipeline patching
- strict validation
- lineage/explanation

The public config should remain workflow-first, not hook-first.

### Adapter modules

Each adapter should own all harness-specific details.

Claude adapter owns:

- Claude hook registration
- Claude hook protocol output
- Claude shell/environment integration
- Claude skills installation
- Claude session/file-history access
- Claude-specific reviewer process defaults

pi adapter owns:

- pi extension lifecycle mapping
- pi custom tools and commands
- pi session custom entry state
- pi system prompt/status rendering
- pi package metadata
- pi reviewer subprocess behavior
- pi remediation loop

Codex adapter should be added only after its capability profile is understood.

### Distribution module

Distribution should be separated from runtime semantics:

- CLI installation
- adapter package installation
- project initialization
- package artifacts
- vendored runtime or package dependency strategy
- drift checks

## Public config model direction

The clean redesign should use a new major-version public config model, not carry legacy shapes forward as first-class runtime concepts.

Desired properties:

- snake_case field names
- task registry
- normalized workflow stages
- separate `agent_workflows` and `git_workflows`
- profile-driven built-in defaults
- constrained pipeline customization through prepend, append, remove, and replace operations
- minimal adapter overrides
- strict validation for unknown fields
- hard errors for invalid workflow/task references
- inspection tooling that explains lineage and effective behavior

Canonical redesign config locations:

- user-level global config under `.prove_it` in the user home
- repo project config under `.prove_it`
- repo local overrides under `.prove_it`

Legacy `.claude/prove_it` files remain part of the old/current Claude-oriented product line and may be useful for comparison, but the clean major-version runtime does not support them as compatibility artifacts.

## Adapter behavior targets

### Claude target behavior

Claude is a fast-follow adapter for the clean redesign. It should preserve existing mature behavior where that behavior aligns with shared methodology, but the existing Claude implementation is a comparison oracle rather than a compatibility substrate:

- hard pre-tool config guard
- hard Stop enforcement
- agent-initiated `prove_it signal done` through shell command
- signal preserved on failure and cleared on success
- done-gated reviewers and full tests on Stop
- async reviewers harvested on later Stop
- backchannel creation and cleanup
- session briefing at startup
- TDD/phase guidance through existing mechanisms
- reviewer subprocesses with safe permission defaults

Claude behavior is a reference implementation of hard enforcement, but any observed Claude quirk that conflicts with methodology should not become product truth.

### pi target behavior

Pi is the first clean-room proving-ground adapter and should implement the methodology using pi-native primitives:

- hard tool-call blocking for config guards and other pre-tool policies
- model-callable `prove_it_signal` for agent completion declarations
- slash commands as user override/debug controls, not the primary workflow path
- session custom entries for signal state
- prompt injection that mirrors shared methodology guidance
- post-tool tracking through `tool_result`
- Stop-equivalent checks on `agent_end`
- follow-up remediation when checks fail
- signal preserved on failure and cleared on success
- pi-backed reviewers that use pi’s configured defaults unless explicitly overridden
- documentation that Pi completion enforcement is remediation-based after `agent_end` until a hard Stop primitive exists

Pi should not be described as perfectly equivalent to Claude where harness capabilities differ, but Pi is first-class for this redesign and should not be labeled experimental merely because completion enforcement is remediation-based.

### Codex target behavior

Codex should be added through the same adapter contract after capability discovery. It should not force changes to core methodology. If Codex lacks hard blocking at key lifecycle points, it should be modeled similarly to pi with explicit degraded enforcement semantics.

## Proposed clean implementation phases

### Phase 1: Minimal Pi pre-tool config-guard vertical slice

Build the smallest end-to-end clean-runtime path: strict `.prove_it` config, normalized Pi `tool_call`, minimal workflow/effect evaluation, and a Pi adapter response that blocks protected `.prove_it` config edits.

Acceptance criteria:

- Pi-shaped path payloads such as `input.path` are first-class.
- `.prove_it/config.json` and `.prove_it/config.local.json` edits are blocked through Pi `tool_call`.
- The slice does not read legacy `.claude/prove_it` config.
- Stop/remediation, reviewers, phase, package distribution, and Claude migration are out of scope.

### Phase 2: Methodology extraction

Build shared methodology data and renderable guidance.

Acceptance criteria:

- Signal semantics are represented as structured data.
- Completion accountability and evidence-oriented proving are adapter-renderable.
- No user-only signal authority mode is introduced.
- Phase is not required by core methodology.

### Phase 3: Capability profiles

Build adapter capability declarations and diagnostics.

Acceptance criteria:

- Pi and Claude declare concrete enforcement capabilities.
- Pi reports remediation-based completion verification after `agent_end`.
- Capability differences are diagnostics, not broad experimental labels.

### Phase 4: Strict config/profile foundation

Build the redesign config model cleanly.

Acceptance criteria:

- Strict `.prove_it` schema validation.
- Profile-driven defaults.
- Workflow-first public config.
- Task registry and pipeline patching.
- No legacy runtime compatibility.

### Phase 5: Workflow engine effects

Build or refactor the engine around harness-neutral effects.

Acceptance criteria:

- Pre-tool workflows emit allow/block effects.
- Completion workflows can emit hard-block or remediation effects based on capability profiles.
- Task execution is isolated from adapter protocols.

### Phase 6: Pi completion loop

Extend the Pi adapter beyond pre-tool blocking.

Acceptance criteria:

- Pi supports agent-owned `done`, `stuck`, and `idle` where appropriate.
- Pi runs completion verification after `agent_end`.
- Failed completion verification queues remediation and preserves `done`.
- Successful completion verification clears `done`.
- Phase remains out of scope for the MVP.

### Phase 7: Pi package

Package the Pi adapter after the runtime behavior works.

Acceptance criteria:

- Package identity is `@davemo/pi-prove-it`.
- Package is portable and drift-tested.
- Bundled skills/guidance align with shared methodology.

### Phase 8: Claude fast-follow adapter

Map the clean engine to Claude after the Pi-first contract is proven.

Acceptance criteria:

- Current Claude behavior remains a comparison target where it aligns with methodology.
- Claude adapter owns hook protocol and Claude-specific paths.
- No legacy config runtime bridge is introduced.

### Phase 9: Examples and docs

Rebuild public docs around the new product model.

Acceptance criteria:

- Docs explain prove_it as a methodology/workflow engine.
- Examples cover Pi-first and Claude fast-follow shapes.
- Capability profiles distinguish hard blocking from remediation.
- Human review is described as downstream/external, not a core gate.

### Phase 10: Codex discovery and adapter planning

Research Codex after Pi and Claude stabilize.

Acceptance criteria:

- Codex capability matrix is documented.
- Adapter feasibility is known.
- Implementation slices are planned only after capability discovery.

## What to salvage from the exploration branch

The exploration branch should be treated as a reference implementation and proof archive. The following are candidates for cherry-picking or reimplementing cleanly:

- pi extension lifecycle bridge
- pi package scaffold
- pi bundled skills and skill sync workflow
- vendored runtime closure and anti-drift tests
- reviewer backend abstraction
- pi-subagent default model/provider behavior
- adapter-owned Claude path/protocol/effect modules
- `.prove_it` layout support
- redesign config/profile test cases
- example matrix and adapter comparison checklist
- path-shape parity fixes for pi-style `input.path`
- realpath-aware backchannel bypass logic
- config guard coverage for `.prove_it` and `.claude/prove_it`
- manual adapter comparison integration tests
- doctor/config inspection ideas
- ubiquitous language document

## What not to carry forward blindly

- Treating Claude behavior as product truth rather than methodology reference.
- Treating pi signals as user-owned only by default.
- Claiming pi has hard Stop parity with Claude while it only remediates after `agent_end`.
- Letting adapter-specific paths leak into core workflow logic.
- Keeping redesign config as a compiler into legacy config forever.
- Rewriting all public docs before the architecture and terminology are stable.
- Carrying generated session/backchannel artifacts in examples.
- Hiding capability degradation behind generic “multi-adapter” language.

## Resolved public policy defaults

The redesign defaults that block early implementation are resolved in `plans/prove-it-harness-neutral-clean-policy-defaults.md`.

Summary:

1. Pi is the first clean-room proving-ground adapter; Claude is fast-follow; Codex is deferred.
2. Agent-initiated `done` remains mandatory after each coherent coding task in the default methodology.
3. There is no user-only signal authority mode in this redesign scope.
4. The new major-version `.prove_it` path is strict and has no legacy runtime compatibility.
5. Pi completion verification is remediation-based after `agent_end` until a hard Stop blocker exists; Pi is not experimental by default.
6. Adapter differences are reported through capability profiles, not broad experimental labels.
7. Evidence-oriented proving is core methodology; `/prove` as a command name is adapter/distribution UX.
8. TDD is the default methodology profile, not a universal core invariant.
9. Phase state is out of scope for the Pi-first MVP.
10. Reviewers use the active harness only in this redesign scope.
11. Human review is downstream/external, not a core prove_it gate.
12. The working Pi package identity is `@davemo/pi-prove-it`.

## Remaining product questions

None for the Pi-first MVP. Codex launch status is deferred by policy.

## Recommended next step

Start a fresh implementation branch from main using this brief as the architectural source of truth. Preserve the exploration branch for reference and selectively cherry-pick only after each clean module boundary is established and tested.

The first clean implementation slice should be a minimal Pi pre-tool config-guard vertical slice: strict `.prove_it` config, normalized Pi `tool_call`, minimal workflow/effect handling, and a Pi adapter response that blocks protected `.prove_it` config edits. This proves the clean-room adapter contract before broader methodology, completion-remediation, reviewers, packaging, or Claude fast-follow work.
