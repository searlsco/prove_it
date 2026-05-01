# @davemo/pi-prove-it

Pi package for prove_it's harness-neutral methodology/workflow enforcement.

This package bundles:

- the Pi extension entrypoint;
- the prove_it runtime files needed by the Pi adapter;
- the shipped prove_it skills.

Install globally or project-locally with:

```bash
pi install npm:@davemo/pi-prove-it
pi install -l npm:@davemo/pi-prove-it
```

Use it with the Pi methodology profile in strict clean-runtime config:

```bash
prove_it init --adapter pi
prove_it explain
prove_it doctor
```

`prove_it init --adapter pi` selects `profile: "pi"`. The Pi extension provides methodology prompt injection, hard pre-tool config guard blocking, the model-callable `prove_it_signal` tool, fast/full script completion verification from Pi `turn_end`, and remediation follow-up when verification fails. Pi completion verification is remediation-based from `turn_end`, with `agent_end` settlement as a fallback; it is not Claude-style hard Stop parity.

The Clean Runtime reads strict `.prove_it/config.json` as Workflow Engine Project Config. Claude Legacy Config under `.claude/prove_it/` is not Clean Runtime input; normal Claude hook dispatch ignores stale legacy config after the hard break and `prove_it doctor` reports it.

During repository development, keep vendored runtime and skills synchronized with:

```bash
node tools/sync-pi-package.js
```
