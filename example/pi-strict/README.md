# Pi-first strict `.prove_it` example

This is the smallest Pi-first clean-runtime project. It demonstrates prove_it as a methodology/workflow engine, not a Claude-only hook runner.

## Create it

```bash
prove_it init --adapter pi
```

Then enable the Pi package for the project:

```bash
pi install -l npm:@davemo/pi-prove-it
```

This example commits the equivalent project setting in `.pi/settings.json`:

```json
{
  "packages": ["npm:@davemo/pi-prove-it"]
}
```

## Files that matter

- `.prove_it/config.json` — strict shared clean-runtime config.
- `.prove_it/ownership.json` — manifest for prove_it-owned generated files.
- `.pi/settings.json` — Pi-native package activation for `@davemo/pi-prove-it`.

The clean runtime does not read legacy `.claude/prove_it` config. Legacy Claude config is intentionally absent.

## Enforcement model

Pi is first-class. The Pi extension provides:

- methodology prompt injection before the agent starts;
- hard pre-tool config guard blocking via `tool_call`;
- model-callable `prove_it_signal` for `done`, `stuck`, and `idle` signals;
- completion verification after `agent_end`;
- remediation follow-up on failure.

Completion verification is remediation-after-agent-end, not hard Stop parity. If verification fails after the agent ends, prove_it asks Pi to continue with remediation instead of pretending it can block completion the way Claude Stop can.

Human review is downstream/external to prove_it core; this example does not configure human review as a prove_it gate.
