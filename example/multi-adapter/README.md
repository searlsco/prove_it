# Multi-adapter strict `.prove_it` example

This example enables Pi and Claude artifacts in one repository while being explicit about their current enforcement differences.

## Create it

```bash
prove_it init --adapter pi --adapter claude
pi install -l npm:@davemo/pi-prove-it
```

## Files that matter

- `.prove_it/config.json` — strict clean-runtime intent with both adapters enabled.
- `.prove_it/ownership.json` — manifest for prove_it-owned generated files.
- `.pi/settings.json` — Pi-native package activation for `@davemo/pi-prove-it`.
- `.claude/settings.json` — Claude-native hook registrations.

The clean runtime does not read legacy `.claude/prove_it` config. Adapter-native files activate their harnesses; Pi consumes the clean-runtime path end to end today, while Claude strict clean-runtime migration is partial/fast-follow.

## Enforcement model

This example is deliberately narrow: it shows adapter-native activation files without implying end-to-end strict Claude workflow enforcement, reviewers that coordinate across harnesses, or any shared human-approval gate.

- Pi is the fully wired clean-runtime adapter path today: methodology prompt injection, hard pre-tool config guard blocking, model-callable `prove_it_signal`, and remediation after `agent_end` when completion verification fails.
- Claude dispatch does not yet generally consume strict `.prove_it/config.json` as its workflow source. Current Claude hard PreToolUse/Stop behavior exists in the old/current Claude path; strict clean-runtime Claude migration is partial/fast-follow.

Human review is downstream/external to prove_it core. If your team wants humans to review outputs from either harness, put that policy in your code review or release process rather than modeling it as a core prove_it gate.
