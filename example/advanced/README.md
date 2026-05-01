# prove_it advanced legacy-characterization example

A project retained to exercise custom Legacy Runtime behavior in tests: custom lint scripts, domain-specific agent prompts, and `when` conditions. It is not the recommended setup for new projects after the Claude hard break.

For current Claude behavior, use `prove_it init --adapter claude`, which writes strict `.prove_it/config.json` as the Workflow Engine source of truth and `.claude/settings.json` only as Claude Adapter activation.

## What's different from basic

- Custom lint check (`script/lint.sh`) runs before tests on commit
- Agent prompts are tailored to the calculator domain (division by zero, edge cases)
- Higher `maxOutputChars` (16000 vs 12000)
- Custom source globs (no `lib/` — just `src/` and `test/`)

## What's included

- `src/calculator.js` — arithmetic module with edge case handling
- `test/calculator.test.js` — tests using `node:test`
- `script/test` and `script/test_fast` — test runners
- `script/lint.sh` — custom lint check
- `.claude/prove_it/config.json` — retired Claude Legacy Config used only by test-only legacy characterization paths

## Prerequisites

- Node.js >= 18
- `prove_it install` if you intentionally want global Claude hook registration for legacy characterization

## Try it

```bash
cd example/advanced
./script/test          # run tests
./script/lint.sh       # run lint check
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

To use the development version instead of the Homebrew install, prepend `test/bin` to your PATH:

```bash
# From this directory
PATH="../../test/bin:$PATH" prove_it doctor
```
