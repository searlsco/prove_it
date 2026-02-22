# prove_it advanced example

A project demonstrating custom prove_it configuration: custom lint scripts,
domain-specific agent prompts, and `when` conditions.

## What's different from basic

- Custom lint check (`script/lint.sh`) runs before tests on commit
- Agent prompts are tailored to the calculator domain (division by zero, edge cases)
- Higher `maxOutputChars` (16000 vs 12000)
- Custom source globs (no `lib/`—just `src/` and `test/`)

## What's included

- `src/calculator.js`—arithmetic module with edge case handling
- `test/calculator.test.js`—tests using `node:test`
- `script/test` and `script/test_fast`—test runners
- `script/lint.sh`—custom lint check
- `.claude/prove_it/config.json`—customized prove_it config

## Prerequisites

- Node.js >= 18
- `prove_it install` (global hooks registered)

## Try it

```bash
cd example/advanced
./script/test          # run tests
./script/lint.sh       # run lint check
```

## Testing hooks manually

```bash
echo '{"hook_event_name":"Stop","session_id":"test","cwd":"."}' | prove_it hook claude:Stop
```

## Running from the local repo

To use the development version instead of the Homebrew install, prepend `test/bin` to your PATH:

```bash
# From this directory
PATH="../../test/bin:$PATH" prove_it hook claude:Stop < input.json
PATH="../../test/bin:$PATH" prove_it doctor

# Run Claude Code against this example with the local prove_it
cd example/advanced
PATH="../../test/bin:$PATH" claude
```
