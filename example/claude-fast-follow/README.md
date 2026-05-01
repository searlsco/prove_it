# Claude parity strict `.prove_it` example

This example shows Claude after the Clean Runtime hard break. The directory name is historical from the fast-follow phase; the behavior documented here is the completed Claude Parity Cutover.

## Create it

```bash
prove_it init --adapter claude
```

## Files that matter

- `.prove_it/config.json` — strict Workflow Engine Project Config with `profile: "claude"`.
- `.prove_it/ownership.json` — manifest for prove_it-owned generated files.
- `.claude/settings.json` — Claude Adapter activation and hook registrations that call `prove_it hook claude:*`.

`.claude/settings.json` is not workflow config. It is a Claude-native Adapter Artifact.

## Hard-break behavior

Normal Claude hook dispatch uses strict `.prove_it/config.json` and clean Session State. It ignores stale `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json` as workflow config. There is no legacy config migration command and no supported dual-runtime compatibility mode.

`prove_it doctor` reports stale legacy Claude configs as ignored after the hard break.

## Claude parity behavior

This example uses the Claude parity profile so Claude can exercise retained product behavior through the Clean Runtime:

- Session Start briefing and methodology context;
- protected `.prove_it` config edits;
- test-first guidance;
- Done/Stuck Signal behavior;
- Done-gated fast/full tests;
- Done, Stuck/Approach, coverage, and testing-pattern Reviewer Tasks;
- backchannel appeal behavior for reviewer FAILs;
- phase and plan-file behavior;
- TaskCompleted auto-signaling;
- disable/enable/cancel session control.

Claude-specific mechanics remain adapter-owned: hook names, hook JSON schemas, `.claude/settings.json`, `CLAUDE_ENV_FILE`, Claude Stop hard blocks, file-history access, and backchannel file paths.

Human review is downstream/external to prove_it core; this example does not configure human review as a prove_it gate.
