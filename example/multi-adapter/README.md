# Multi-adapter strict `.prove_it` example

This example enables Pi and Claude artifacts in one repository while keeping the product model harness-neutral.

## Create it

```bash
prove_it init --adapter pi --adapter claude
pi install -l npm:@davemo/pi-prove-it
```

## Files that matter

- `.prove_it/config.json` — strict Workflow Engine Project Config with both adapters enabled and `profile: "strict"`.
- `.prove_it/ownership.json` — manifest for prove_it-owned generated files.
- `.pi/settings.json` — Pi-native package activation for `@davemo/pi-prove-it`.
- `.claude/settings.json` — Claude-native hook registrations that call `prove_it hook claude:*`.

Adapter-native files activate their Harnesses; they are not workflow config. The Workflow Engine source of truth remains `.prove_it/config.json`.

## Enforcement model

Multi-adapter init currently keeps `profile: "strict"` so Pi does not inherit Claude-only default mechanics. This example is deliberately narrow: it shows adapter-native activation files without implying cross-harness reviewers, shared session artifacts, or any shared human-approval gate.

- Pi is first-class with hard pre-tool config guard blocking, model-callable `prove_it_signal`, methodology prompt injection, and remediation after `turn_end` when Completion Verification fails.
- Claude is first-class with hard PreToolUse and Stop blocking through Claude hooks when the configured Workflow Engine Tasks require it.

Normal Claude hook dispatch ignores stale `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json` as workflow config. `prove_it doctor` reports those files as stale if they are present.

Human review is downstream/external to prove_it core. If your team wants humans to review outputs from either Harness, put that policy in your code review or release process rather than modeling it as a core prove_it gate.
