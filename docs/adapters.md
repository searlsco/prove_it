# Adapter capabilities and clean-runtime examples

prove_it is a methodology/workflow engine. The clean runtime defines workflow intent in strict `.prove_it/config.json`; each adapter maps that workflow to the enforcement mechanisms its harness actually supports.

Pi is first-class. Pi is the fully wired clean-runtime adapter path today. Claude is a fast-follow adapter: the current work added adapter/effect boundaries plus shared signal lifecycle and Stop settlement, but Claude dispatch does not yet generally consume strict `.prove_it/config.json` as its workflow source. Current Claude hard PreToolUse/Stop behavior exists in the old/current Claude path, while Claude strict clean-runtime migration is partial/fast-follow. Codex is deferred for future capability discovery and is not documented here as an implemented adapter.

## Strict clean-runtime setup

Use explicit adapters for new clean-runtime projects:

```bash
prove_it init --adapter pi
prove_it init --adapter pi --adapter claude
```

These commands write strict shared config under `.prove_it/`:

- `.prove_it/config.json` — workflow config for the clean runtime.
- `.prove_it/ownership.json` — manifest for prove_it-owned artifacts.
- `.prove_it/.gitignore` — excludes local clean-runtime overrides such as `config.local.json`.

The clean runtime does not read legacy `.claude/prove_it` config. Legacy `.claude/prove_it/config.json` remains old/current Claude product behavior, not compatibility input for the clean runtime.

Inspect the effective clean-runtime config with:

```bash
prove_it explain
```

Check installation and adapter capability diagnostics with:

```bash
prove_it doctor
```

## Pi-first usage

Install the Pi package in a project or globally:

```bash
pi install -l npm:@davemo/pi-prove-it
# or: pi install npm:@davemo/pi-prove-it
```

The package identity is `@davemo/pi-prove-it`. A project-local `.pi/settings.json` can declare it directly:

```json
{
  "packages": ["npm:@davemo/pi-prove-it"]
}
```

The Pi extension currently provides:

- methodology prompt injection before the agent starts;
- hard pre-tool config guard blocking through Pi `tool_call`;
- model-callable `prove_it_signal` for shared signal semantics;
- completion verification from Pi `turn_end`, with `agent_end` settlement as a fallback;
- remediation follow-up when completion verification fails.

Pi completion verification is remediation from `turn_end`, not hard Stop parity. When verification fails, prove_it asks Pi to continue and remediate; it does not claim that Pi has Claude-style Stop blocking.

See [`example/pi-strict/`](../example/pi-strict/) for the smallest Pi-first strict `.prove_it` project.

## Claude fast-follow usage

Claude activation is adapter-native: `.claude/settings.json` registers Claude hooks that call `prove_it hook claude:*`, and `.prove_it/config.json` records strict clean-runtime intent for the fast-follow adapter. Do not treat that file as the full source of truth for Claude task enforcement yet.

Claude fast-follow behavior currently includes:

- narrow PreToolUse guard paths through shared effects;
- Stop signal settlement through the shared lifecycle;
- Claude protocol output owned by the Claude adapter, because Claude PreToolUse and Stop use different hook output schemas.

Claude dispatch does not yet generally consume strict `.prove_it/config.json` as its workflow source. Current Claude hard PreToolUse/Stop behavior exists in the old/current Claude path, which reads `.claude/prove_it/config.json`; strict clean-runtime Claude migration is partial/fast-follow.

See [`example/claude-fast-follow/`](../example/claude-fast-follow/) for a Claude fast-follow project that shows strict owned artifacts without claiming end-to-end strict workflow enforcement.

## Multi-adapter usage

A multi-adapter project can enable both Pi and Claude:

```bash
prove_it init --adapter pi --adapter claude
pi install -l npm:@davemo/pi-prove-it
```

This is useful when a team uses both harnesses and wants one strict `.prove_it` intent file. Pi consumes that clean-runtime path end to end today; Claude records adapter intent and native hook activation while its strict workflow enforcement remains partial/fast-follow. It should not imply end-to-end strict Claude workflow enforcement, cross-harness reviewers, shared session artifacts, or prove_it-managed human approval.

Human review is downstream/external to prove_it core. Treat human review as a code-review, release, or team policy after prove_it reports its machine-verifiable status.

See [`example/multi-adapter/`](../example/multi-adapter/) for a strict `.prove_it` example with Pi native activation and Claude fast-follow native hook activation.

## Capability comparison matrix

| Capability | Pi | Claude |
|---|---|---|
| Methodology prompt injection | Available before `before_agent_start` | Adapter-specific session context through Claude hooks |
| Pre-tool config guard | hard block via Pi `tool_call` | hard block in the old/current Claude `PreToolUse` path; strict clean-runtime bridge currently covers narrow guard paths |
| Post-tool observation | observe-only via Pi `tool_result` | observable through Claude post-tool hooks in the old/current Claude product |
| Model-callable signals | available through `prove_it_signal` | command-based `prove_it signal ...` through Claude tool use |
| Session state | available through Pi session state entries | adapter-owned Claude session/log state |
| Completion verification | remediation after `turn_end` | hard block in the old/current Claude `Stop` path; shared signal settlement exists, but strict `.prove_it` task workflow is not the general source yet |
| Protocol rendering | Pi extension return values and remediation messages | Claude adapter owns Claude hook JSON output |

The matrix intentionally distinguishes hard block from remediation. A hard block prevents the guarded action or completion in that harness. Remediation means the harness has reached a post-turn or completion lifecycle point, so prove_it queues or asks for follow-up work instead of claiming hard enforcement.

## What is not implemented here

- Codex is deferred for future adapter capability discovery. Do not treat Codex as an implemented clean-runtime adapter.
- Legacy `.claude/prove_it` config is not clean-runtime input.
- Generated session logs and backchannel artifacts are runtime state, not example source files.
- Human review is downstream/external to prove_it core, not a built-in prove_it gate.
