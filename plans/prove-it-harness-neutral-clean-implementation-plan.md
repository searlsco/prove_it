# prove_it Harness-Neutral Clean Redesign Implementation Plan

> Source brief: `plans/prove-it-harness-neutral-clean-redesign-brief.md`  
> Starting point: fresh branch from `main`  
> Research reference only: `feat/prove-it-pi-phase0-phase1`

## Ground rules

1. Start implementation from `main`, not from the research branch.
2. Treat `feat/prove-it-pi-phase0-phase1` as a proof archive. Use `git show`/`git diff` for reference, and only cherry-pick after a clean boundary and matching tests already exist on the implementation branch.
3. Do not make Claude the product source of truth. Claude is the mature reference adapter; shared semantics belong in methodology/workflow modules.
4. Keep the new major-version config path workflow-first and strict. Legacy `.claude/prove_it` config remains compatibility context for the existing product line, not the primary model for the redesign.
5. Every phase should land as small vertical slices with characterization tests first when existing behavior is being moved.
6. Pi support must be honest about enforcement strength: hard pre-tool blocking is available; hard Stop parity is not currently identified, so Stop failures use post-agent remediation.

## Current `main` baseline

The current codebase is Claude-first:

- The CLI dispatches only `claude:<Event>` and `git:<event>` hook specs.
- Effective config is legacy hook-shaped config loaded from `.claude/prove_it` paths.
- `lib/dispatcher/claude.js` owns too many concerns: hook protocol, session baseline, config loading, signal interception, phase interception, path extraction, file edit tracking, command-result logging, async harvesting, task execution, task settlement, and Claude output rendering.
- Session storage is filesystem-backed and Claude-path-aware in places.
- Task execution is reusable in spirit but currently coupled to legacy task shape and hook-event vocabulary.
- Signal semantics exist operationally, but the product methodology is not represented as structured shared data.

The clean plan should first extract stable semantics, then move enforcement behavior behind adapter boundaries.

## Target architecture

### Deep modules to build or reshape

1. **Methodology module**
   - Owns signal meanings, completion accountability rules, stuck/idle rules, clear-on-pass and preserve-on-fail semantics, reviewer/backchannel accountability, and evidence-oriented guidance.
   - Produces structured methodology data plus adapter-renderable guidance.
   - Does not mention Claude settings files, pi extension APIs, or Codex.

2. **Adapter capability module**
   - Defines the capability schema and validation.
   - Represents enforcement strength explicitly, including hard block, observe-only, and remediation-after-agent-end strategies.
   - Provides diagnostics for degraded behavior, especially pi Stop enforcement.

3. **Harness-neutral event/effect module**
   - Normalizes adapter lifecycle input into shared stages such as session start, pre-tool, post-tool, post-tool-failure, and stop/agent-end.
   - Emits shared effects such as allow, block, approve, fail, inject context, update state, record observation, queue remediation, and no-op.
   - Provides path/command extraction helpers that account for Claude-style `file_path`/`notebook_path` and pi-style `path`/`input.path` payloads.

4. **Config/profile module**
   - Implements strict new public config with `schema_version`, `profile_version`, `project`, `globs`, `tasks`, `agent_workflows`, `git_workflows`, and `adapters`.
   - Owns built-in profile bundles, task registry resolution, pipeline patching, validation, and lineage/explanation.
   - Keeps the new major-version path separate from legacy hook-shaped compatibility.

5. **Workflow engine module**
   - Evaluates effective config and normalized events.
   - Runs tasks through isolated task-runner ports.
   - Applies conditions and signal lifecycle transitions.
   - Emits harness-neutral effects rather than Claude protocol JSON.

6. **Runtime state module/ports**
   - Defines state operations needed by the workflow engine: read/write signal, phase, session baseline, command observations, file edits, async task results, disabled/cancel sentinels, and reviewer continuity.
   - Allows Claude to keep filesystem-backed state while pi can use session custom entries plus any necessary runtime bridge.

7. **Adapter modules**
   - Claude adapter owns Claude hook registration, hook protocol output, env-file integration, path quirks, file-history access, shell interception, and Claude reviewer defaults.
   - Pi adapter owns extension lifecycle mapping, model-callable tools, slash commands, session custom entries, prompt/status rendering, follow-up remediation, pi reviewer defaults, and package integration.
   - Codex is deferred until capability discovery is complete.

8. **Distribution module**
   - Separates runtime semantics from installation and packaging.
   - Owns adapter-aware install/init/deinit/uninstall, package artifacts, runtime vendoring strategy for pi, and drift checks.

## Branch setup

Recommended implementation branch creation:

```bash
git switch main
git pull --ff-only
git switch -c feat/harness-neutral-clean-redesign
```

Keep the current planning branch as documentation only. Keep `feat/prove-it-pi-phase0-phase1` available locally for lookup:

```bash
git show feat/prove-it-pi-phase0-phase1:<path>
git diff main...feat/prove-it-pi-phase0-phase1 -- <path>
```

Avoid merge commits or wholesale cherry-picks from the research branch.

## Phase 0: Baseline safety and characterization

### Goal

Create a safe starting point on `main` and lock down existing Claude behavior before extracting it.

### Implementation slices

1. Create the fresh implementation branch from `main`.
2. Run the current fast and full test commands and record the baseline.
3. Add missing characterization tests around existing behavior before moving code:
   - Claude PreToolUse config guard blocks protected config edits.
   - Claude Stop blocks failed done-gated tasks.
   - Signal `done` persists after failed Stop and clears after successful Stop.
   - Bash `prove_it signal <type>` interception records state without relying on direct CLI execution.
   - Backchannel writes are allowed and config writes are blocked.
   - SessionStart injects session env/context without blocking.
4. Add a small research-reference note in developer docs or the plan pointing to the branch but warning against merging it.

### Acceptance criteria

- Current main tests pass before refactor work begins.
- Existing Claude enforcement behavior is covered by tests that would fail if the dispatcher extraction regresses it.
- No runtime architecture changes are made in this phase.

## Phase 1: Methodology extraction

### Goal

Represent prove_it’s product methodology as structured shared data instead of adapter prose.

### Implementation slices

1. Add structured signal definitions for `done`, `stuck`, and `idle`.
2. Add completion-accountability rules:
   - Agent declares completion only for a coherent task.
   - Completion declaration activates verification workflows.
   - Completion language is disallowed unless declared and verified.
   - Failed verification preserves the signal.
   - Passing verification clears the signal.
3. Add reviewer-accountability and evidence-orientation definitions.
4. Add renderer functions for adapter-neutral guidance blocks.
5. Add Claude guidance rendering from the same source, but do not migrate all Claude hook behavior yet.
6. Add pi guidance rendering from the same source without requiring pi runtime yet.

### Acceptance criteria

- Signal semantics are represented as structured data.
- Guidance for Claude and pi renders from the same methodology source.
- Tests prevent drift between shared methodology data and adapter-rendered guidance.
- The module has no adapter file path or protocol dependencies.

### Research branch reference

Useful for comparison only:

- `UBIQUITOUS_LANGUAGE.md`
- pi prompt/status wording in `lib/adapters/pi/state.js`
- extension prompt suffix behavior in `lib/adapters/pi/extension.js`

Do not copy wording that says pi signals are user-only by default; that conflicts with the brief.

## Phase 2: Adapter capability model

### Goal

Make harness capability differences explicit and machine-readable.

### Implementation slices

1. Define capability names and enforcement strengths.
2. Add adapter capability declarations for Claude and pi.
3. Add capability validation with actionable errors for unknown or contradictory declarations.
4. Add behavior-selection helpers for hard block vs remediation.
5. Add diagnostics explaining degraded enforcement, especially pi’s Stop behavior.
6. Surface capability diagnostics through doctor/config inspection without changing existing install behavior yet.

### Acceptance criteria

- Claude declares hard pre-tool blocking and hard Stop blocking.
- Pi declares hard pre-tool blocking, post-tool observation, session prompt injection, model-callable tools, session state, and post-agent remediation, but not hard Stop blocking.
- Tests cover capability validation, behavior selection, and diagnostic text.
- Workflow code can query capabilities without importing adapter implementation files.

### Research branch reference

Useful for comparison only:

- `lib/redesign/adapters.js`
- `test/redesign_adapters.test.js`
- pi extension lifecycle tests

## Phase 3: Harness-neutral event and effect contracts

### Goal

Define the shared vocabulary between adapters and the workflow engine before extracting the engine.

### Implementation slices

1. Define normalized lifecycle stages:
   - `session_start`
   - `pre_tool`
   - `post_tool`
   - `post_tool_failure`
   - `stop`
   - git stages separately: `pre_commit`, `pre_push`
2. Define normalized input shape:
   - adapter id
   - raw event name
   - normalized stage
   - session id
   - project/root directory
   - tool name
   - tool input/output/error
   - command
   - target path(s)
   - source/resume metadata
3. Define path extraction helpers that support:
   - Claude `tool_input.file_path`
   - Claude `tool_input.notebook_path`
   - pi `input.path`
   - generic `path`
   - absolute and relative path normalization
   - realpath-aware comparisons where needed
4. Define harness-neutral effects:
   - no-op
   - allow/approve
   - block/fail
   - inject context
   - set env
   - update state
   - record observation
   - queue remediation
5. Add adapter-specific renderers for Claude protocol output while preserving current emitted JSON.

### Acceptance criteria

- Unit tests cover normalized Claude events and generic/pi-shaped payloads.
- Claude protocol rendering remains byte-for-byte compatible where tests currently assert output.
- Core effect definitions do not import Claude protocol helpers.
- Path extraction fixes cover the known `input.path` class of bugs before pi work begins.

### Research branch reference

Useful for comparison only:

- `lib/core/input.js`
- `lib/core/result.js`
- path-shape fixes in `lib/core/engine.js`
- Claude adapter protocol helpers

## Phase 4: Centralize signal lifecycle and runtime state ports

### Goal

Move signal lifecycle rules and state operations out of adapter code while preserving the existing filesystem-backed Claude implementation.

### Implementation slices

1. Define a state port interface used by the workflow engine.
2. Implement a filesystem-backed state adapter wrapping existing session storage.
3. Move signal transitions into a shared lifecycle function:
   - set signal
   - preserve signal on failed verification
   - clear signal on successful verification
   - reset phase after successful `done` verification where current behavior requires it
4. Move phase transitions behind the same state boundary, but keep phase as secondary to the core methodology until product questions are resolved.
5. Move command-result and edit tracking behind state/observation functions.
6. Add realpath-aware backchannel bypass support in shared path-sensitive logic.

### Acceptance criteria

- Existing `prove_it signal` Claude behavior is unchanged.
- Failed Stop preserves `done`; successful Stop clears it.
- State tests cover missing session id, corrupted state files, and migration-safe reads.
- Adapter code calls shared lifecycle/state functions rather than duplicating signal rules.

### Research branch reference

Useful for comparison only:

- `lib/adapters/pi/state.js`
- session changes in the research branch
- realpath-aware backchannel bypass fixes

## Phase 5: Config/profile foundation for the new major-version path

### Goal

Introduce the strict workflow-first public config model without forcing legacy config concepts into the redesign.

### Implementation slices

1. Add schema validation for the new config shape.
2. Add config path resolution for:
   - global: `~/.prove_it/config.json`
   - project: `.prove_it/config.json`
   - local: `.prove_it/config.local.json`
3. Add built-in profile bundles with pinned `profile_version`.
4. Add task registry validation.
5. Add pipeline patch operations:
   - `prepend`
   - `append`
   - `remove`
   - `replace_tasks`
6. Add lineage/explanation output for effective config.
7. Add strict unknown-field errors.
8. Add hard errors for invalid task references and invalid workflow references.
9. Keep the legacy loader intact for the existing Claude product path until the clean engine can run the new path.

### Acceptance criteria

- New config validates independently of legacy `.claude/prove_it` config.
- Built-in defaults are profile-driven.
- Workflow stages are task-name pipelines, not inline hook task blobs.
- Effective config explanation reports source layers and overridden/shadowed tasks.
- Tests cover global/project/local layering, unknown fields, invalid references, patch ordering, task shadowing, and profile pinning.

### Research branch reference

Useful for comparison only:

- `lib/redesign/config.js`
- `lib/redesign/profile.js`
- `test/redesign_config.test.js`
- `test/redesign_runtime.test.js`

Reimplement cleanly. Do not copy any compiler-to-legacy seam as the long-term architecture.

## Phase 6: Workflow engine effects

### Goal

Extract task orchestration into a harness-neutral engine that consumes normalized events and effective config, then emits effects.

### Implementation slices

1. Create an engine entrypoint that accepts:
   - normalized event
   - effective config
   - adapter capabilities
   - state port
   - task runner port
   - clock/logger dependencies
2. Move task matching and condition evaluation into engine-owned code using normalized stages.
3. Keep script/reviewer execution behind task runner ports.
4. Move async/parallel settlement behind engine abstractions while preserving current behavior.
5. Move command-result logging, file-edit tracking, and run-result settlement into observations/effects.
6. Implement Stop behavior using capability selection:
   - hard Stop block when supported
   - remediation effect when hard Stop is unavailable
7. Implement signal clear/preserve in engine settlement.
8. Keep git workflows separate from agent workflows.

### Acceptance criteria

- Pre-tool workflows emit allow/block effects.
- Stop workflows emit approve/fail/remediate effects based on capabilities.
- Session start emits context/env/state effects.
- Signal lifecycle is consistent across hard-block and remediation paths.
- Existing task-runner tests still pass.
- New engine tests can run without Claude hook JSON.

### Research branch reference

Useful for comparison only:

- `lib/core/engine.js`
- `lib/core/events.js`
- `test/core_events.test.js`
- `test/redesign_runtime_execution.integration.test.js`

Treat the research engine as a sketch, not a final design; it still carries too much transitional legacy coupling.

## Phase 7: Claude adapter migration

### Goal

Make Claude an adapter over the shared methodology and workflow engine while preserving the mature current behavior.

### Implementation slices

1. Move Claude protocol JSON rendering behind a Claude adapter module.
2. Move Claude hook registration/settings generation behind the adapter.
3. Move Claude env-file handling behind the adapter.
4. Move Claude path display and project path helpers behind the adapter.
5. Move Claude file-history/session JSONL access behind the adapter.
6. Route `prove_it hook claude:<Event>` through the adapter into the shared engine.
7. Preserve Bash interception for `prove_it signal` and `prove_it phase` as Claude-native shell integration, but call shared lifecycle functions.
8. Preserve TaskCompleted auto-signaling only if it still aligns with shared methodology.
9. Keep existing Claude tests green; rewrite tests only where they were asserting implementation placement instead of external behavior.

### Acceptance criteria

- Current Claude behavior remains intact.
- Claude hook protocol output is adapter-owned.
- Claude-specific filesystem paths do not leak into the workflow engine.
- Existing Claude integration tests pass or are replaced with equivalent behavior tests.
- The adapter can report its capabilities and diagnostics.

### Research branch reference

Useful for comparison only:

- `lib/adapters/claude/effects.js`
- `lib/adapters/claude/env.js`
- `lib/adapters/claude/file_history.js`
- `lib/adapters/claude/hooks.js`
- `lib/adapters/claude/paths.js`
- `lib/adapters/claude/protocol.js`
- Claude adapter tests

## Phase 8: Adapter-aware install/init/deinit/uninstall

### Goal

Separate shared workflow config from adapter-native installation artifacts.

### Implementation slices

1. Add adapter registry for install/init/deinit/uninstall operations.
2. Add shared `.prove_it` project initialization for the new config model.
3. Add Claude project artifacts through the Claude adapter.
4. Add ownership manifests/signatures for generated adapter artifacts.
5. Add non-interactive adapter selection flags before adding interactive prompts.
6. Add interactive prompts only after deterministic non-interactive paths are tested.
7. Add deinit/uninstall safety checks so prove_it removes only owned artifacts.
8. Keep legacy install/init commands available or gated according to the major-version compatibility decision.

### Acceptance criteria

- `prove_it init` can create shared `.prove_it` config and selected adapter artifacts.
- `prove_it deinit` removes prove_it-owned shared and adapter artifacts safely.
- Adapter selection is explicit and scriptable.
- Generated Claude settings still invoke the local runtime correctly.
- Config inspection/doctor can explain enabled adapters and installed artifacts.

### Research branch reference

Useful for comparison only:

- `lib/redesign/init.js`
- `lib/redesign/install.js`
- `lib/redesign/deinit.js`
- `lib/redesign/uninstall.js`
- `lib/redesign/adapters.js`
- redesign command wrapper tests

## Phase 9: Pi adapter and package

### Goal

Implement pi as a capability-constrained peer adapter using pi-native primitives.

### Implementation slices

1. Add pi extension skeleton with lifecycle handlers.
2. Map pi `session_start`/`before_agent_start` to methodology prompt injection and state restoration.
3. Map pi `tool_call` to pre-tool engine execution and hard blocking where supported.
4. Map pi `tool_result` to post-tool observation and command/edit result tracking.
5. Map pi `agent_end` to Stop-equivalent engine execution.
6. Implement remediation follow-up messages for failed Stop-equivalent verification.
7. Implement model-callable `prove_it_signal` using shared signal semantics. The tool description must allow agent-initiated completion declarations for coherent completed tasks.
8. Implement phase update tool/command only to the extent phase remains part of the product model.
9. Persist pi signal/phase state in session entries and synchronize with shared runtime state as needed.
10. Add pi-backed reviewer execution that uses pi’s configured defaults unless a task explicitly overrides the model/provider.
11. Add package scaffold, bundled skills, runtime vendoring strategy, sync scripts, and anti-drift tests.
12. Document pi enforcement limitations clearly.

### Acceptance criteria

- Pi blocks protected config edits during tool calls.
- Pi recognizes pi-style target paths including `input.path`.
- Pi tracks source edits, test edits, command results, and post-tool failures.
- Agent-initiated `done` declarations are supported through pi-native tooling.
- Failed Stop-equivalent verification queues remediation and preserves `done`.
- Successful Stop-equivalent verification clears `done`.
- Pi reviewers use pi defaults unless explicitly overridden.
- Pi package is portable and drift-tested.
- Docs label pi Stop enforcement as remediation-based, not hard-block equivalent.

### Research branch reference

Useful for comparison only:

- `lib/adapters/pi/bridge.js`
- `lib/adapters/pi/extension.js`
- `lib/adapters/pi/runtime.js`
- `lib/adapters/pi/state.js`
- `lib/adapters/pi/remediation.js`
- `pi-package/`
- pi package tests
- pi bridge/extension/state tests

Avoid copying the research branch’s user-only signal wording.

## Phase 10: Examples, docs, and comparison matrix

### Goal

Rebuild public documentation around prove_it as a methodology/workflow engine with adapter-specific enforcement.

### Implementation slices

1. Add or update a ubiquitous language document once terminology has stabilized.
2. Update README/product docs after core architecture is real, not before.
3. Add Claude-only example.
4. Add pi-only example.
5. Add multi-adapter example.
6. Add manual comparison checklist covering Claude and pi behavior.
7. Add docs for enforcement degradation and experimental adapter labels.
8. Remove generated session/backchannel artifacts from examples.

### Acceptance criteria

- Docs explain prove_it as a methodology/workflow engine, not merely a hook runner.
- Examples use `.prove_it` shared config and adapter-native artifacts correctly.
- The comparison matrix distinguishes hard block from remediation.
- Terminology is consistent across config, docs, CLI help, diagnostics, and examples.

### Research branch reference

Useful for comparison only:

- `example/ADAPTER_COMPARISON.md`
- `example/claude-only/`
- `example/pi-only/`
- `example/basic/` and `example/advanced/` redesign changes
- README rewrite concepts

## Phase 11: Codex discovery and adapter planning

### Goal

Assess Codex against the adapter capability contract before implementing anything Codex-specific.

### Implementation slices

1. Document Codex lifecycle primitives.
2. Fill a capability matrix using the shared capability schema.
3. Identify synchronous blocking, Stop/session-end behavior, prompt injection, model-callable tools, state, and reviewer execution options.
4. Decide whether Codex should be first-class, experimental, or deferred.
5. Write a Codex adapter implementation plan only after capability discovery.

### Acceptance criteria

- Codex capabilities are documented without guesses.
- Enforcement gaps are explicit.
- No Codex-specific logic enters the workflow engine.
- Follow-on implementation slices are planned from real capability data.

## Testing strategy

### Unit tests

- Methodology data and guidance rendering.
- Capability schema, validation, and degradation diagnostics.
- Normalized input/event parsing for Claude, pi-shaped, and generic payloads.
- Effect construction and adapter rendering.
- Config schema validation, layering, profile resolution, pipeline patching, lineage, and invalid references.
- Signal lifecycle transitions.
- State port behavior and error tolerance.
- Path extraction and realpath-aware protected-path checks.

### Integration tests

- Claude hook contract tests for PreToolUse, Stop, SessionStart, PostToolUse, and PostToolUseFailure.
- Existing CLI command behavior during compatibility window.
- New adapter-aware init/deinit/install/uninstall behavior.
- Engine execution against new config model.
- Pi extension lifecycle behavior with fake pi context.
- Pi remediation flow after agent end.
- Reviewer backend selection for Claude and pi.
- Package drift and tarball/portable runtime checks for pi.

### Characterization tests to keep green during extraction

- Config guard blocking.
- Signal command interception.
- Done-gated Stop verification.
- Async reviewer harvesting.
- Backchannel appeal flow.
- Test command result recording.
- SessionStart briefing/env injection.
- Git hook behavior.

## Suggested issue breakdown

1. Extract methodology module and guidance renderers.
2. Add adapter capability schema and diagnostics.
3. Add normalized event/input/effect contracts.
4. Centralize signal lifecycle and state ports.
5. Add strict `.prove_it` config/profile resolver.
6. Build harness-neutral workflow engine over task runner ports.
7. Migrate Claude dispatcher to Claude adapter over shared engine.
8. Add adapter-aware init/deinit/install/uninstall.
9. Add pi extension adapter lifecycle and state.
10. Add pi package, runtime vendoring, and drift tests.
11. Rebuild examples and documentation.
12. Complete Codex capability discovery.

## Decisions needed before or during implementation

These questions should be resolved before the relevant phases become blocking:

1. Should agent-initiated `done` declarations remain mandatory after every coherent coding task?
2. Should there be a strict/user-only signal mode for teams that do not want agents to set signals themselves?
3. Is pi remediation-after-agent-end acceptable as experimental support for the first pi release?
4. Should the new major-version path hard-break legacy config shapes, or should legacy mode remain explicit and separate?
5. Should `/prove` become part of the shared methodology module or remain a skill-level workflow?
6. Is TDD/phase core methodology or just a default profile choice?
7. Should Codex be deferred until Claude and pi stabilize?
8. What package identity should the pi adapter use when published?
9. Should reviewers prefer the active harness whenever possible, or should cross-harness reviewers remain supported?
10. What degradation threshold requires an adapter to be labeled experimental?

## Definition of done for the redesign

- Shared methodology semantics are implemented once and rendered by adapters.
- Adapter capabilities drive enforcement strategy.
- New config is workflow-first, strict, profile-driven, and explainable.
- Workflow execution emits harness-neutral effects.
- Claude behavior remains at least as strong as today.
- Pi behavior is functional, packaged, and honestly documented as remediation-based for Stop-equivalent failures.
- Examples and docs teach the methodology engine model.
- Codex is planned from capability evidence rather than assumptions.
