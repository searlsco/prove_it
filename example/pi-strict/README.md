# Pi-first strict `.prove_it` example

This is the smallest Pi-first Clean Runtime project. It demonstrates prove_it as a methodology/workflow engine, not a Claude-only hook runner.

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

- `.prove_it/config.json` — strict Workflow Engine Project Config with `profile: "strict"`.
- `.prove_it/ownership.json` — manifest for prove_it-owned generated files.
- `.pi/settings.json` — Pi-native package activation for `@davemo/pi-prove-it`.

Adapter-native files activate their Harnesses; they are not workflow config. The Workflow Engine source of truth remains `.prove_it/config.json`.

## Enforcement model

Pi is first-class. The Pi Adapter provides:

- methodology prompt injection before the Primary Agent starts;
- hard pre-tool config guard blocking via `tool_call`;
- model-callable `prove_it_signal` for `done`, `stuck`, and `idle` Signals;
- Pi Session State integration;
- Completion Verification from `turn_end`, with `agent_end` settlement as a fallback;
- remediation follow-up on failure.

Completion Verification is remediation-after-turn-end, not Claude Stop hard-block parity. If verification fails after the agent reaches the post-turn completion point, prove_it asks Pi to continue with remediation instead of pretending it can block completion the way Claude Stop can.

Normal Claude hook dispatch ignores stale `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json` as workflow config. Legacy Claude config is intentionally absent from this Pi example.

Human review is downstream/external to prove_it core; this example does not configure human review as a prove_it gate.

## Manual verification: failed Pi remediation in `~/code/pp-test`

Use this scenario to verify the remediation follow-up path against a real Pi session during repository development:

```bash
mkdir -p ~/code/pp-test
cd ~/code/pp-test
PATH="/Users/davemo/code/prove_it/test/bin:$PATH" prove_it init --adapter pi
mkdir -p .pi
cat > .pi/settings.json <<'JSON'
{
  "packages": ["../../prove_it/packages/pi-prove-it"]
}
JSON
mkdir -p script
cat > script/test_fast <<'SH'
#!/usr/bin/env bash
echo "intentional completion failure from pp-test" >&2
exit 1
SH
chmod +x script/test_fast
python3 - <<'PY'
import json
from pathlib import Path
path = Path('.prove_it/config.json')
config = json.loads(path.read_text())
config.setdefault('tasks', {})['completion_check'] = {
    'type': 'script',
    'command': './script/test_fast'
}
config.setdefault('agent_workflows', {})['agent_end'] = ['completion_check']
path.write_text(json.dumps(config, indent=2) + '\n')
PY
pi -p 'Create done_probe.txt with "done probe", then use prove_it_signal with signal="done" and stop.'
```

Expected result: Pi records the `done` signal, runs Completion Verification from `turn_end`, preserves `done` when `script/test_fast` fails, and receives exactly one automatic follow-up user message that starts with `prove_it completion verification failed:` and asks the agent to remediate before signaling `done` again. It should not loop forever without a fresh `prove_it_signal(done)` call.
