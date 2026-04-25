# prove_it Harness-Neutral Clean Redesign Issue Drafts

GitHub issue creation was attempted against `davemo/prove_it`, but the repository currently has GitHub Issues disabled. These drafts are ready to create once issues are enabled or a different target repository is chosen.

When creating issues, create them in this order and replace draft blockers with the real issue numbers.

---

## Draft 1: Characterize current Claude enforcement before redesign extraction

## What to build

AFK slice. Add characterization coverage for current Claude enforcement before any redesign extraction starts. The tests should prove the current external behavior of config guarding, Stop blocking, signal handling, backchannel bypass, SessionStart context/env injection, and Bash signal interception.

## Acceptance criteria

- [ ] Current main test commands pass before refactor work begins.
- [ ] Claude PreToolUse protected config edits are covered by behavior tests.
- [ ] Claude Stop done-gated failure blocking is covered by behavior tests.
- [ ] `done` signal persistence after failed Stop and clearing after successful Stop are covered by tests.
- [ ] Backchannel bypass, SessionStart context/env injection, and Bash `prove_it signal` interception are covered by tests.
- [ ] No runtime architecture changes are introduced in this slice.

## Blocked by

None - can start immediately

---

## Draft 2: Decide redesign public policy defaults

## What to build

HITL slice. Resolve the product policy decisions that affect the redesign defaults before implementation hardens around them: agent-owned completion signals, strict/user-only modes, legacy compatibility stance, pi support maturity, `/prove` scope, TDD/phase scope, reviewer harness preference, and adapter experimental labeling.

## Acceptance criteria

- [ ] Decide whether agent-initiated `done` declarations remain mandatory after each coherent coding task.
- [ ] Decide whether a strict/user-only signal mode is required for teams that do not want agents to set signals.
- [ ] Decide whether the new major-version path hard-breaks legacy config shapes or keeps legacy mode explicit and separate.
- [ ] Decide whether pi remediation-after-agent-end is acceptable as experimental support.
- [ ] Decide whether `/prove` is shared methodology or remains skill-level.
- [ ] Decide whether TDD/phase is core methodology or profile-level default behavior.
- [ ] Decide whether reviewers prefer the active harness by default and what degradation threshold marks an adapter experimental.

## Blocked by

None - can start immediately

---

## Draft 3: Render shared completion methodology in the existing Claude session briefing

## What to build

AFK slice. Add a shared methodology data/renderer path and use it in the existing Claude session briefing so completion-accountability guidance comes from one source instead of duplicated prose.

## Acceptance criteria

- [ ] Structured methodology data exists for `done`, `stuck`, and `idle` signal meanings.
- [ ] Completion-accountability rules are represented in shared data, including declare-on-coherent-task, verification activation, completion-language restrictions, preserve-on-fail, and clear-on-pass.
- [ ] Existing Claude session briefing renders its obligations from the shared methodology source.
- [ ] Tests prove Claude guidance changes when shared methodology data changes and prevent adapter guidance drift.
- [ ] The methodology module has no Claude settings path, pi extension API, or Codex dependency.

## Blocked by

- Blocked by Draft 1
- Blocked by Draft 2

---

## Draft 4: Surface adapter capability diagnostics through CLI output

## What to build

AFK slice. Add machine-readable adapter capability declarations for Claude and pi, validate them, and surface user-visible diagnostics that explain enforcement differences such as pi's remediation-based Stop behavior.

## Acceptance criteria

- [ ] Capability names and enforcement strengths are defined and validated.
- [ ] Claude declares hard pre-tool blocking and hard Stop blocking.
- [ ] Pi declares hard pre-tool blocking, post-tool observation, prompt injection, model-callable tools, session state, and post-agent remediation, but not hard Stop blocking.
- [ ] Behavior-selection helpers can distinguish hard block, observe-only, and remediation strategies.
- [ ] Existing doctor/config-style CLI output can show capability diagnostics without changing install behavior.
- [ ] Tests cover validation errors, behavior selection, and degraded pi Stop diagnostic wording.

## Blocked by

- Blocked by Draft 2

---

## Draft 5: Normalize Claude lifecycle input and render equivalent Claude protocol output

## What to build

AFK slice. Introduce normalized lifecycle event and effect objects for a narrow Claude hook path, then render them back to the current Claude hook protocol without changing observable output.

## Acceptance criteria

- [ ] Normalized lifecycle stages exist for session start, pre-tool, post-tool, post-tool-failure, stop, pre-commit, and pre-push.
- [ ] Normalized input includes adapter id, raw event, normalized stage, session id, project/root directory, tool details, command, target paths, and source/resume metadata.
- [ ] Harness-neutral effects exist for no-op, allow/approve, block/fail, context injection, env updates, state updates, observations, and remediation.
- [ ] A narrow Claude hook path routes through normalized event/effect objects.
- [ ] Claude protocol rendering remains compatible with existing output assertions.
- [ ] Core event/effect modules do not import Claude protocol helpers.

## Blocked by

- Blocked by Draft 1

---

## Draft 6: Use shared target-path extraction for config-guard parity

## What to build

AFK slice. Add shared target-path extraction and canonicalization so protected-path/config-guard logic works with Claude payloads and pi-shaped payloads before the pi adapter exists.

## Acceptance criteria

- [ ] Shared path extraction handles Claude `tool_input.file_path`.
- [ ] Shared path extraction handles Claude `tool_input.notebook_path`.
- [ ] Shared path extraction handles pi/generic `input.path` and `path` shapes.
- [ ] Absolute, relative, and realpath-aware path comparisons are tested.
- [ ] Protected config paths under both `.prove_it` and legacy `.claude/prove_it` can be matched through the shared helper.
- [ ] Config-guard behavior tests cover both Claude and pi-shaped payload families.

## Blocked by

- Blocked by Draft 5

---

## Draft 7: Centralize signal lifecycle while preserving Claude prove_it signal

## What to build

AFK slice. Centralize signal lifecycle rules and state access while preserving the current Claude `prove_it signal` behavior and filesystem-backed session state.

## Acceptance criteria

- [ ] A state port interface covers signal reads/writes and the session state operations needed by the workflow engine.
- [ ] A filesystem-backed implementation wraps the current session storage without changing external behavior.
- [ ] Shared signal lifecycle functions implement set, preserve-on-fail, clear-on-pass, and phase reset after successful `done` verification where current behavior requires it.
- [ ] Claude Bash interception for `prove_it signal` routes through the shared lifecycle.
- [ ] Claude Stop settlement routes signal preserve/clear through the shared lifecycle.
- [ ] Tests cover missing session ids, corrupted state tolerance, failed Stop preserve, and successful Stop clear.

## Blocked by

- Blocked by Draft 3
- Blocked by Draft 5

---

## Draft 8: Explain a strict .prove_it workflow config end to end

## What to build

AFK slice. Implement enough of the strict `.prove_it` workflow-first config/profile model to inspect and explain an effective repo configuration end to end.

## Acceptance criteria

- [ ] New config path resolution supports global `~/.prove_it/config.json`, project `.prove_it/config.json`, and local `.prove_it/config.local.json`.
- [ ] Strict schema validation covers `schema_version`, `profile_version`, `project`, `globs`, `tasks`, `agent_workflows`, `git_workflows`, and `adapters`.
- [ ] Built-in profile defaults are represented as structured profile data with pinned `profile_version`.
- [ ] Task registry and workflow pipeline validation reject unknown fields and invalid task references.
- [ ] Pipeline patching supports `prepend`, `append`, `remove`, and `replace_tasks`.
- [ ] A CLI inspection/explain path reports effective pipelines, source layers, lineage, and task shadowing.
- [ ] Legacy `.claude/prove_it` loading remains separate from this new path.

## Blocked by

- Blocked by Draft 2

---

## Draft 9: Execute one .prove_it pre_tool script workflow through the shared engine

## What to build

AFK slice. Build the smallest usable shared workflow engine path: a normalized `pre_tool` event reads the strict `.prove_it` config, runs one script task, and emits a harness-neutral allow or block effect.

## Acceptance criteria

- [ ] Engine entrypoint accepts a normalized event, effective config, adapter capabilities, state port, task runner port, and testable dependencies.
- [ ] A `.prove_it` `pre_tool` workflow can reference a script task by name.
- [ ] The engine runs the script task through an isolated runner port.
- [ ] Passing script tasks emit an allow effect.
- [ ] Failing script tasks emit a block effect with an actionable reason.
- [ ] Tests exercise the engine without Claude hook JSON or Claude protocol rendering.

## Blocked by

- Blocked by Draft 5
- Blocked by Draft 6
- Blocked by Draft 8

---

## Draft 10: Execute signal-gated Stop verification with capability-based outcomes

## What to build

AFK slice. Extend the shared engine to run signal-gated Stop verification and select hard-block or remediation outcomes based on adapter capabilities while preserving signal lifecycle semantics.

## Acceptance criteria

- [ ] A `done` signal activates signal-gated Stop verification workflows.
- [ ] Passing Stop verification clears the `done` signal.
- [ ] Failed Stop verification preserves the `done` signal.
- [ ] Adapters with hard Stop blocking receive a fail/block effect.
- [ ] Adapters without hard Stop blocking receive a remediation effect suitable for post-agent follow-up.
- [ ] Tests cover both Claude-like hard-block capabilities and pi-like remediation capabilities.

## Blocked by

- Blocked by Draft 4
- Blocked by Draft 7
- Blocked by Draft 9

---

## Draft 11: Route Claude PreToolUse and Stop through the shared engine

## What to build

AFK slice. Route the real Claude PreToolUse and Stop dispatch paths through the shared engine and Claude effect renderer while preserving existing hard enforcement behavior.

## Acceptance criteria

- [ ] Claude PreToolUse dispatch uses normalized input and shared engine execution for applicable workflows.
- [ ] Claude Stop dispatch uses shared engine execution for applicable workflows.
- [ ] Claude protocol JSON output is owned by the Claude adapter/effect renderer.
- [ ] Existing Claude config guard, done-gated Stop, async harvesting, and signal behavior remain externally unchanged.
- [ ] Claude-specific paths and protocol concerns do not leak into the workflow engine.
- [ ] Existing Claude behavior tests pass or are replaced with equivalent external behavior tests.

## Blocked by

- Blocked by Draft 6
- Blocked by Draft 10

---

## Draft 12: Initialize and deinitialize a Claude-enabled .prove_it repo safely

## What to build

AFK slice. Add adapter-aware repo initialization and teardown for Claude using shared `.prove_it` config plus Claude-native owned artifacts.

## Acceptance criteria

- [ ] `prove_it init` can create shared `.prove_it/config.json` for the new config model.
- [ ] `prove_it init` can enable the Claude adapter and create required Claude-native project artifacts.
- [ ] Generated artifacts include ownership markers or manifests that identify prove_it-managed files.
- [ ] `prove_it deinit` removes shared and Claude-native artifacts only when they are prove_it-owned.
- [ ] Adapter selection is explicit and scriptable in non-interactive tests.
- [ ] Doctor/config inspection can explain that the Claude adapter is enabled for the repo.

## Blocked by

- Blocked by Draft 8
- Blocked by Draft 11

---

## Draft 13: Load a pi extension that injects methodology and blocks protected tool calls

## What to build

AFK slice. Add the minimal pi adapter/extension lifecycle that injects shared methodology guidance and hard-blocks protected tool calls through the shared pre-tool workflow.

## Acceptance criteria

- [ ] A pi extension skeleton registers lifecycle handlers in tests using a fake pi context.
- [ ] Pi session start or before-agent-start injects methodology guidance rendered from the shared methodology source.
- [ ] Pi `tool_call` normalizes payloads and runs the shared pre-tool workflow.
- [ ] Protected config edits are blocked during pi tool calls.
- [ ] Pi-style target paths, including `input.path`, are recognized.
- [ ] Tests verify pi pre-tool blocking without requiring a live pi session.

## Blocked by

- Blocked by Draft 4
- Blocked by Draft 6
- Blocked by Draft 8
- Blocked by Draft 9

---

## Draft 14: Support pi-native done signaling and post-agent remediation

## What to build

AFK slice. Add pi-native completion signaling and post-agent remediation so pi can implement the same methodology despite lacking a known hard Stop blocker.

## Acceptance criteria

- [ ] Pi exposes a model-callable `prove_it_signal` tool using shared signal semantics.
- [ ] The signal tool supports agent-initiated `done` declarations for coherent completed tasks.
- [ ] Pi persists signal and phase state in session entries or equivalent pi-native state.
- [ ] Pi `agent_end` runs Stop-equivalent shared engine verification.
- [ ] Failed verification queues a follow-up remediation message and preserves `done`.
- [ ] Successful verification clears `done`.
- [ ] Tests cover signal persistence, remediation queueing, and successful clear using fake pi context.

## Blocked by

- Blocked by Draft 2
- Blocked by Draft 10
- Blocked by Draft 13

---

## Draft 15: Package pi support with reviewer defaults and runtime drift checks

## What to build

AFK slice. Package pi support into a portable prove_it pi package with bundled skills/runtime vendoring, drift checks, and pi reviewer behavior that respects pi's configured defaults unless explicitly overridden.

## Acceptance criteria

- [ ] Pi package scaffold contains the extension and required package metadata.
- [ ] Shared runtime files needed by the pi package are vendored or otherwise packaged portably.
- [ ] Sync and anti-drift tests detect stale vendored runtime or bundled skills.
- [ ] Bundled prove_it skills are included in the pi package.
- [ ] Pi reviewer backend smoke tests use pi's configured default model/provider unless a task explicitly overrides them.
- [ ] Package/tarball tests verify the package can be built from the repo.

## Blocked by

- Blocked by Draft 14

---

## Draft 16: Publish Claude/pi examples and honest enforcement docs

## What to build

AFK slice. Publish examples and documentation that teach prove_it as a methodology/workflow engine with adapter-specific enforcement strengths for Claude and pi.

## Acceptance criteria

- [ ] Docs explain prove_it as a methodology/workflow engine rather than only a hook runner.
- [ ] Claude-only, pi-only, and multi-adapter examples use shared `.prove_it` config and adapter-native artifacts correctly.
- [ ] A comparison matrix distinguishes hard blocking from remediation-based enforcement.
- [ ] Pi Stop-equivalent behavior is documented as remediation-after-agent-end, not hard Stop parity.
- [ ] Terminology is consistent across docs, examples, CLI help, diagnostics, and config names.
- [ ] Generated session/backchannel artifacts are excluded from examples.

## Blocked by

- Blocked by Draft 12
- Blocked by Draft 15

---

## Draft 17: Document Codex capability discovery and adapter feasibility

## What to build

HITL slice. Research Codex against the shared adapter capability schema and document whether a Codex adapter is feasible, experimental, or deferred before any Codex-specific runtime logic is added.

## Acceptance criteria

- [ ] Codex lifecycle primitives are documented from evidence rather than assumptions.
- [ ] Capability matrix covers pre-tool blocking, Stop/session-end blocking, prompt injection, model-callable tools, state persistence, reviewer execution, and tool-result observation.
- [ ] Enforcement gaps and degraded semantics are explicit.
- [ ] Recommendation states whether Codex should be first-class, experimental, or deferred.
- [ ] Follow-on implementation slices are proposed only after capability discovery.
- [ ] No Codex-specific logic is added to the workflow engine in this slice.

## Blocked by

- Blocked by Draft 4
