# Codex capability discovery

## Executive summary

**Recommendation: plan Codex as an experimental Adapter, not a first-class Adapter yet.** Codex should remain outside launch scope until a tracer-bullet Adapter proves the documented hook semantics in interactive and non-interactive sessions.

Confidence is **medium**. The current Codex CLI and official docs provide concrete lifecycle primitives that are strong enough to justify an experimental Adapter slice: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` hooks; SessionStart/UserPromptSubmit context injection; partial pre-tool blocking; PostToolUse observation; MCP tools; skills/plugins; and `codex exec` for non-interactive reviewer execution. Local probes with Codex CLI `0.125.0` confirmed key behavior.

Evidence limitations:

- Codex hooks are documented as stable, but the hook guide still calls the current lifecycle hooks an MVP and explicitly says some interception paths are incomplete.
- `PreToolUse` can hard-block supported `Bash`, `apply_patch`, and MCP tool calls, but does not intercept every Codex capability or every shell path.
- `Stop` can continue the run by creating a follow-up prompt; it does not reject a completed turn in the same Claude Stop sense.
- Project-local `.codex/` config and hooks depend on Codex trust semantics, which need installer/doctor probes before first-class support.
- No Codex-specific Workflow Engine logic is recommended in this slice.

## Evidence log

### Local CLI evidence

Commands were run on 2026-04-29 in `/Users/davemo/code/prove_it` unless noted.

| Command | Summary |
| --- | --- |
| `which codex` | Found `/Users/davemo/Library/pnpm/codex`. |
| `codex --version` | Reported `codex-cli 0.125.0`. |
| `codex --help` | Shows interactive CLI plus subcommands including `exec`, `review`, `mcp`, `plugin`, `mcp-server`, `app-server`, `sandbox`, `resume`, `fork`, `cloud`, `exec-server`, and `features`. Global flags include `--config`, `--model`, `--sandbox`, `--ask-for-approval`, `--search`, `--cd`, and `--add-dir`. |
| `codex exec --help` | Documents non-interactive execution, stdin prompt support, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `--json`, and `--output-last-message`. Local CLI requires global flags such as `-a/--ask-for-approval` before the `exec` subcommand even though help text is ambiguous. |
| `codex mcp --help` | Confirms MCP server management subcommands: `list`, `get`, `add`, `remove`, `login`, and `logout`. |
| `codex plugin --help` | Confirms plugin marketplace management. |
| `codex mcp-server --help` | Confirms Codex can run as an MCP server over stdio. |
| `codex review --help` | Confirms a non-interactive review mode with `--uncommitted`, `--base`, `--commit`, and custom instructions. |
| `codex debug prompt-input --help` | Confirms a local diagnostic command that renders model-visible prompt input as JSON. |
| `codex features list` | Reported `codex_hooks` as `stable true`, plus stable `multi_agent`, `plugins`, `shell_tool`, `tool_search`, `unified_exec`, and other feature flags. |

### Local probes

1. **Prompt/instruction probe**
   - Created a scratch Git repo with `AGENTS.md` containing a marker.
   - Ran `CODEX_HOME=<temp> codex debug prompt-input 'hello'`.
   - Result: JSON prompt input included permissions instructions, skills instructions, environment context, and the scratch repo `AGENTS.md` content. This supports Codex prompt/context injection through native instruction files.

2. **Hook lifecycle probe**
   - Created a temp `CODEX_HOME/config.toml` with `codex_hooks = true` and `SessionStart`, `UserPromptSubmit`, and `Stop` command hooks that logged stdin JSON.
   - Ran `codex -C <scratch> -s read-only -a never exec --json --skip-git-repo-check 'Reply exactly OK and do not run tools.'`.
   - Result: Codex exited `0`, emitted JSONL events, and invoked hooks with these fields:
     - `SessionStart`: `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `source`, `transcript_path`.
     - `UserPromptSubmit`: previous fields plus `prompt` and `turn_id`.
     - `Stop`: previous fields plus `last_assistant_message`, `stop_hook_active`, and `turn_id`.

3. **PreToolUse blocking probe**
   - Configured a `PreToolUse` hook matching `Bash` to return:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PreToolUse",
         "permissionDecision": "deny",
         "permissionDecisionReason": "probe denied Bash"
       }
     }
     ```
   - Prompted Codex to run `printf PROBE_HOOK`.
   - Result: the hook received `tool_name: "Bash"` and `tool_input.command: "printf PROBE_HOOK"`; the command did not run; Codex reported that the command was blocked by the `PreToolUse` hook.

4. **Stop continuation probe**
   - Configured a `Stop` hook to return `{"decision":"block","reason":"STOP_PROBE_CONTINUE once, then answer SECOND"}` the first time and `{"continue": true}` when `stop_hook_active` was true.
   - Prompted Codex to reply `FIRST`.
   - Result: Codex produced `FIRST`, ran the Stop hook, continued with a new prompt, then produced `SECOND`. This confirms Stop can drive a remediation/continuation loop, not a Claude-style hard rejection of the completed turn.

### Documentation and source references consulted

Official documentation:

- Codex CLI overview: <https://developers.openai.com/codex/cli>
- Command line options: <https://developers.openai.com/codex/cli/reference>
- Non-interactive mode: <https://developers.openai.com/codex/noninteractive>
- Hooks: <https://developers.openai.com/codex/hooks/>
- Configuration reference: <https://developers.openai.com/codex/config-reference/>
- Config basics: <https://developers.openai.com/codex/local-config>
- MCP: <https://developers.openai.com/codex/mcp>
- Skills: <https://developers.openai.com/codex/skills>
- Plugins: <https://developers.openai.com/codex/plugins/build>
- CLI features: <https://developers.openai.com/codex/cli/features/>
- AGENTS.md instructions: <https://developers.openai.com/codex/guides/agents-md>
- Slash commands: <https://developers.openai.com/codex/guides/slash-commands>

Repository docs discovered through web/fetch research:

- `openai/codex` README: <https://github.com/openai/codex>
- `docs/config.md`: <https://github.com/openai/codex/blob/main/docs/config.md>
- `docs/exec.md`: <https://github.com/openai/codex/blob/main/docs/exec.md>
- Hook schemas are referenced by the official hook guide at <https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated>.

Existing prove_it context:

- `UBIQUITOUS_LANGUAGE.md`
- `docs/adapters.md`
- `docs/claude-parity-acceptance.md`
- `plans/prove-it-harness-neutral-clean-redesign-brief.md`
- `plans/prove-it-harness-neutral-clean-implementation-plan.md`
- `lib/adapter_capabilities.js`
- `lib/redesign/effects.js`
- `lib/redesign/events.js`
- `lib/reviewer.js` for historical Codex subprocess reviewer behavior only, not as lifecycle evidence.

## Capability matrix

| Capability concept | Codex evidence | Current assessment | Clean Runtime implication |
| --- | --- | --- | --- |
| Lifecycle event mapping | Official hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`. Local probes confirmed `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `Stop`. | **Supported, with gaps.** Good normalized event candidates exist. | Codex Adapter can map to `session_start`, `pre_tool`, `post_tool`, and completion verification. `PermissionRequest` is Codex-specific approval mediation. `UserPromptSubmit` may be useful for prompt-time context/policy. |
| Pre-tool blocking | Hook docs say `PreToolUse` can deny supported `Bash`, `apply_patch`, and MCP calls using `permissionDecision: "deny"`, legacy `decision: "block"`, or exit code `2`. Local probe confirmed Bash blocking. Docs warn interception is incomplete for richer `unified_exec`, WebSearch, and other non-shell/non-MCP tools. | **Partial hard block.** Hard block for supported tools only; not a complete enforcement boundary. | Use `pre_tool_blocking: hard_block` only with a diagnostic caveat or sub-capabilities. Config guard can be experimental, not parity-grade. |
| Permission/approval blocking | `PermissionRequest` runs before Codex asks for approval and can `allow`, `deny`, or decline. Deny wins across multiple hooks. | **Supported for approval requests.** Not a substitute for all pre-tool blocking because it only runs when Codex would ask approval. | Optional adapter-owned guard for sandbox escalation/network/request-permission cases. |
| Stop/session-end blocking | `Stop` supports `decision: "block"` or exit code `2`, but docs state this does not reject the turn; it tells Codex to continue with a new continuation prompt. Local probe confirmed continuation from `FIRST` to `SECOND`. | **Remediation/continuation, not Claude hard Stop.** Stronger than advisory because Codex continues before final completion, but semantics are not a hard rejection of the completed turn. | Model as `completion_verification: remediation` or a Codex-specific `continuation_remediation`; do not claim Claude parity. |
| SessionStart/prompt injection | `SessionStart` plain text and JSON `hookSpecificOutput.additionalContext` are added as developer context. `UserPromptSubmit` can also add additional context. `AGENTS.md`, `developer_instructions`, `model_instructions_file`, skills, and project docs are native prompt channels. Local `debug prompt-input` confirmed `AGENTS.md` in model-visible context. | **Supported.** Multiple context channels exist. | `context_injection` maps cleanly to SessionStart/UserPromptSubmit, with native AGENTS.md or config files as adapter artifacts. |
| Model-callable tools / signal mechanism | Codex supports MCP servers in CLI/IDE and exposes MCP tools to the model. Plugins can bundle MCP config. Slash commands are user/TUI controls; custom prompts are deprecated in favor of skills. Skills are model-visible instructions, not deterministic state mutations. | **Feasible but unproven for prove_it signals.** MCP is the best evidenced model-callable signal mechanism. Shell command signals are possible through Bash, but depend on command execution and interception. | Prototype a `prove_it_signal` MCP server before declaring model-callable signal support. Do not implement signal semantics in the Workflow Engine specifically for Codex. |
| Adapter-owned state persistence | Hooks receive `session_id`, `turn_id` for turn-scoped events, `cwd`, and `transcript_path`. Codex stores transcripts locally and supports resume. Config has `sqlite_home` for Codex internal state. No documented custom extension state API like Pi session custom entries. | **Supported through adapter filesystem state; native custom state API unknown.** | Codex Adapter can use filesystem-backed Session State keyed by `session_id`, similar to Claude, while treating Codex transcript/state as read-only evidence unless documented APIs emerge. |
| Tool-result observation | `PostToolUse` observes `Bash`, `apply_patch`, and MCP outputs; for Bash it also runs after non-zero exits. It can replace/modify the returned feedback, but cannot undo side effects. Docs warn interception is incomplete for unified exec/WebSearch/other tools. | **Partial observe/feedback.** | Map to observation effects for supported tools; surface degraded observation diagnostics. |
| Command/result observation | `PostToolUse` exposes `tool_input.command` and `tool_response` for Bash. `codex exec --json` emits JSONL item events including command executions, file changes, MCP calls, web searches, and plan updates. | **Supported for non-interactive exec and supported hook tools; interactive completeness unknown.** | Reviewer backend can consume `codex exec --json`; interactive Adapter should prefer hooks for observations and treat JSONL streams as reviewer/subprocess evidence. |
| Reviewer execution through active Harness | `codex exec` is documented for non-interactive automation and outputs final text or JSONL. `codex review` exists for non-interactive code review. | **Supported enough for experimental reviewer backend.** | A Codex-hosted session can run Codex reviewers through `codex exec`/`codex review`; Claude/Pi sessions must not cross into Codex reviewers. |
| Async/parallel task lifecycle support | Hook docs say multiple matching command hooks for the same event launch concurrently and one hook cannot prevent another from starting. Codex also has multi-agent/subagent support, but this is not prove_it task lifecycle support. | **Adapter risk.** Concurrency is a hook delivery property, not a Workflow Engine task settlement primitive. | Adapter should call a single prove_it hook dispatcher per event and let the Workflow Engine own task ordering/parallelism. Avoid multiple prove_it-owned Codex hooks for the same event. |
| Env/session variable injection | Config supports `shell_environment_policy.set`, `include_only`, and related controls for subprocess environments. MCP server config supports env forwarding. No evidence that a hook can export env vars into future shell commands like `CLAUDE_ENV_FILE`. | **Partial.** Static env injection is supported through config; dynamic session env mutation is unknown/unsupported by current evidence. | Treat environment injection as adapter artifact/config-time only until a dynamic Codex mechanism is proven. |
| Git workflow interaction | Codex CLI works inside Git repos, has `/diff`, `codex apply`, cloud task apply, and requires Git repo checks for safety. No Codex-specific Git hook lifecycle was found. | **No Codex-owned Git workflow primitive.** | Keep prove_it Git workflows under strict `.prove_it/git_workflows` and Git 2.54 config hooks. Codex Adapter should not alter Git Workflow Engine behavior. |
| Packaging/activation model | Codex installs via npm, Homebrew cask, or GitHub releases. Hooks live in `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, or `<repo>/.codex/config.toml`; project-local layers require project trust. Plugins package skills, MCP config, app mappings, and assets via marketplaces. | **Supported but operationally non-trivial.** | Experimental init can write `.codex/hooks.json`/`.codex/config.toml` as Adapter Artifacts and possibly a plugin/MCP package. Doctor must check trust/config activation before first-class support. |

## Enforcement semantics

### What Codex can hard-block with current evidence

- **Supported `PreToolUse` tools:** Codex can deny `Bash`, `apply_patch`/`Edit`/`Write` aliases, and MCP tool calls documented by the hook guide. Local probes confirmed Bash denial.
- **Approval requests:** `PermissionRequest` can deny approval prompts. This blocks approval escalation, but only at approval-request lifecycle points.
- **User prompts:** `UserPromptSubmit` can block a user prompt using `decision: "block"` or exit code `2`. This is useful for prompt policy, not normal prove_it completion verification.

### What is remediation-only or advisory

- **Completion Verification:** Codex `Stop` can return `decision: "block"`, but the official docs state it continues by creating a new prompt rather than rejecting the completed turn. This is a remediation/continuation loop.
- **Post-tool findings:** `PostToolUse` can replace feedback and continue the model from hook-provided feedback, but side effects have already happened. This is observation plus remediation, not prevention.
- **Prompt/context guidance:** AGENTS.md, skills, `developer_instructions`, and `additionalContext` steer behavior but are not enforcement by themselves.

### What cannot be supported with current evidence

- Complete pre-tool coverage across all Codex capabilities. The hook guide explicitly excludes WebSearch and says simple shell interception is incomplete relative to `unified_exec`.
- Input mutation for pre-tool calls. `updatedInput`, `additionalContext`, `continue: false`, `stopReason`, and `suppressOutput` are parsed but not supported for `PreToolUse`; unsupported decisions fail open according to the hook docs.
- Claude-style dynamic shell environment export after SessionStart. Static config exists, but no `CLAUDE_ENV_FILE` equivalent was found.
- First-class Codex Adapter activation without trust diagnostics. Project `.codex/` layers and hooks load only for trusted projects.

### Closest existing Capability Profile

Codex would not resemble Claude because `Stop` is not a hard completion block and pre-tool coverage is partial. It is closer to Pi's remediation profile for completion, but Codex has its own shape:

- Claude-like lifecycle hooks exist.
- Pi-like completion remediation is required.
- Codex-specific risk comes from partial tool interception and project trust/config activation.

The likely profile name should be experimental until a tracer bullet proves the semantics in both interactive TUI and `codex exec` sessions.

## Fit with current Clean Runtime architecture

### Workflow Engine effects that map cleanly

- `context_injection` -> `SessionStart` or `UserPromptSubmit` `additionalContext`, or adapter-owned AGENTS.md/model-instructions artifacts.
- `block` for pre-tool config guard -> `PreToolUse` `permissionDecision: "deny"` for supported tools.
- `observation` -> `PostToolUse` records for supported tool results.
- `remediation` -> `Stop` `decision: "block"` reason, creating a Codex continuation prompt.
- `state_update` -> filesystem-backed Session State keyed by Codex `session_id`.
- Reviewer task execution -> `codex exec` or `codex review` from Codex sessions only.

### Behavior that would need adapter-owned delivery

- `.codex/hooks.json` or inline `[hooks]` generation.
- `[features].codex_hooks = true` and activation/trust diagnostics.
- Codex hook protocol rendering, including Codex-specific differences from Claude hook JSON.
- Codex MCP server or plugin packaging if prove_it signals become model-callable tools.
- Static environment configuration through `shell_environment_policy` if needed.
- Local skill/plugin packaging if prove_it methodology ships through Codex-native distribution.

### Architecture risks and missing seams

- Existing `lib/adapter_capabilities.js` capability names are too coarse for Codex pre-tool semantics; it may need sub-capability diagnostics such as `pre_tool_blocking.supported_tools` and `tool_observation.coverage`.
- Hook commands for the same event run concurrently. The Adapter should install one prove_it dispatcher per event and keep ordered task execution inside the Workflow Engine.
- Codex project trust is an activation concern that doctor/init must detect before runtime behavior can be trusted.
- Stop continuation can loop; the Adapter needs a safe settlement rule using `stop_hook_active` and prove_it signal state.
- `codex exec --json` is excellent for reviewer subprocess evidence, but interactive TUI event streams and transcript formats need separate probes before observation parity claims.

**No Codex-specific Workflow Engine logic is recommended in this slice.** Codex-specific hook schemas, trust, MCP/plugin distribution, and continuation rendering should live in a future Codex Adapter.

## Recommendation

Move Codex from unknown/deferred research status to **experimental Adapter planning**, while keeping it **not implemented and not first-class**.

Rationale tied to evidence:

- There are now documented lifecycle primitives and local probes confirming they work.
- Codex can enforce some hard pre-tool blocks and approval denials.
- Codex can run completion remediation through `Stop` continuation.
- Codex can receive prompt/context injection and can expose MCP tools.
- The known gaps are significant enough to prevent first-class support: incomplete interception, remediation rather than hard completion blocking, project trust activation, and unproven MCP signal ergonomics.

Before revisiting first-class status, prove:

1. Project-local `.codex/` activation can be installed and diagnosed reliably, including trust behavior.
2. Config guard coverage blocks all file-edit paths Codex commonly uses, including `apply_patch` and MCP filesystem tools.
3. Stop continuation can run prove_it Completion Verification without loops and with clear user-visible remediation.
4. A Codex-native signal mechanism works reliably, preferably through MCP.
5. Reviewer tasks can run through `codex exec` with stable verdict parsing and no cross-harness invocation.
6. Interactive TUI behavior matches non-interactive `codex exec` for the hook primitives prove_it needs.

## Follow-on implementation slices

Only these slices are justified by current evidence:

1. **Codex Adapter skeleton and activation probe**
   - Generate minimal `.codex/config.toml` or `.codex/hooks.json` Adapter Artifacts in a scratch project.
   - Add `prove_it doctor` diagnostics for Codex CLI presence, version, `codex_hooks`, hook artifact presence, and project trust status.
   - Do not run workflows yet.

2. **Codex hook protocol renderer tracer bullet**
   - Add a Codex Adapter test harness that feeds documented `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop` JSON into prove_it.
   - Render Codex-native hook output for context injection, pre-tool deny, observation feedback, and Stop continuation.

3. **Codex config guard experiment**
   - Install a single `PreToolUse` dispatcher.
   - Prove protected `.prove_it/config.json` and `.prove_it/config.local.json` edits are blocked for `apply_patch` and Bash-driven edit paths.
   - Document any file-edit paths that remain unblocked.

4. **Codex prompt injection experiment**
   - Compare SessionStart `additionalContext`, UserPromptSubmit `additionalContext`, AGENTS.md, skills, and `model_instructions_file` for delivering methodology guidance.
   - Choose the least surprising Adapter Artifact.

5. **Codex signal mechanism experiment**
   - Build a tiny MCP server exposing `prove_it_signal` for `done`, `stuck`, and `idle`.
   - Verify Codex can call it in interactive and `codex exec` sessions.
   - Keep shared signal lifecycle in the Workflow Engine.

6. **Codex completion verification experiment**
   - Use `Stop` continuation to run a failing then passing verification task.
   - Verify Done Signal preservation on failure, clear-on-pass, loop prevention using `stop_hook_active`, and user-visible remediation text.

7. **Codex reviewer backend experiment**
   - Run Reviewer Tasks through `codex exec`/`codex review` only from active Codex sessions.
   - Capture JSONL/final-message evidence and parse verdicts without reintroducing cross-harness reviewers.

## Open questions

### Unknowns requiring more evidence

- How does project trust behave for non-interactive `codex exec` when `.codex/hooks.json` is introduced by `prove_it init --adapter codex`?
- Are hook semantics identical in interactive TUI, IDE extension, and `codex exec` for all events prove_it needs?
- What is the best Codex-native signal delivery: MCP tool, shell command, skill-guided command, or user slash command?
- Can Codex plugins be installed/updated locally in a way that fits prove_it ownership manifests and deinit semantics?
- What transcript/session files are stable enough to use as evidence without relying on internal formats?
- How should multiple Codex hooks from user, project, and enterprise layers be diagnosed when prove_it's hook is only one of several concurrent hooks?

### Unsupported or degraded based on current evidence

- Full hard pre-tool enforcement across all Codex tool paths is unsupported by the hook docs.
- Claude-style hard Stop rejection is unsupported; Stop block means continuation/remediation.
- Dynamic post-start environment export is unsupported by current evidence.
- `PreToolUse` input mutation and allow/ask decisions are unsupported and can fail open.
- Git Workflow activation should not be tied to Codex; keep strict `.prove_it/git_workflows` on Git hooks.
