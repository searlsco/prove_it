# prove_it basic legacy-characterization example

A minimal project retained to exercise the quarantined Legacy Runtime oracle in tests. It is not the recommended setup for new projects after the Claude hard break.

For current Claude behavior, use `prove_it init --adapter claude`, which writes strict `.prove_it/config.json` as the Workflow Engine source of truth and `.claude/settings.json` only as Claude Adapter activation.

## What's included

- `src/greet.js` — a simple greeting module
- `test/greet.test.js` — tests using `node:test`
- `script/test` and `script/test_fast` — test runners
- `.claude/prove_it/config.json` — retired Claude Legacy Config used only by test-only legacy characterization paths

## Prerequisites

- Node.js >= 18
- `prove_it install` if you intentionally want global Claude hook registration for legacy characterization

## Try it

Use this example directly (after cloning prove_it):

```bash
cd example/basic
./script/test          # run tests
```

Do not copy `.claude/prove_it/config.json` into new projects as active workflow config. For new Claude projects, run:

```bash
prove_it init --adapter claude
```

## Testing hooks manually

The normal Claude hook path ignores `.claude/prove_it/config.json` after the hard break. Repository tests that still exercise this example set the test-only legacy oracle guard explicitly.

```bash
printf '%s' '{"hook_event_name":"Stop","session_id":"test","cwd":"."}' | \
  NODE_ENV=test \
  PROVE_IT_LEGACY_CLAUDE_ORACLE=1 \
  PROVE_IT_TEST_LEGACY_CLAUDE_ORACLE=1 \
  prove_it hook claude:Stop
```

## Running from the local repo

To use the development version instead of the Homebrew install, prepend `test/bin` to your PATH. This uses the repo's `cli.js` directly, so changes track with the git ref:

```bash
# From this directory
PATH="../../test/bin:$PATH" prove_it doctor
```
