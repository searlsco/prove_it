# Claude fast-follow strict `.prove_it` example

This example shows Claude as a fast-follow adapter with strict `.prove_it` artifacts, without claiming end-to-end strict Claude workflow enforcement.

## Create it

```bash
prove_it init --adapter claude
```

## Files that matter

- `.prove_it/config.json` — strict clean-runtime intent and adapter metadata.
- `.prove_it/ownership.json` — manifest for prove_it-owned generated files.
- `.claude/settings.json` — Claude-native hook registrations that call `prove_it hook claude:*`.

The clean runtime does not read legacy `.claude/prove_it` config. Legacy `.claude/prove_it/config.json` remains old/current Claude product behavior, not clean-runtime compatibility, so this example intentionally omits it.

## Enforcement model

Claude strict clean-runtime migration is partial/fast-follow:

- narrow PreToolUse guard paths run through shared effects and render Claude-owned protocol output;
- Stop signal settlement uses shared lifecycle semantics;
- Claude protocol JSON remains adapter-owned because Claude's hook API has its own schemas.

Claude dispatch does not yet generally consume strict `.prove_it/config.json` as its workflow source. Current Claude hard PreToolUse/Stop behavior exists in the old/current Claude path, which reads `.claude/prove_it/config.json`; this strict example intentionally omits that legacy config because the clean runtime does not read it.

Human review is downstream/external to prove_it core; this example does not configure human review as a prove_it gate.
