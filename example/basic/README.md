# prove_it basic example

A minimal project showing prove_it's default configuration.

## What's included

- `src/greet.js`—a simple greeting module
- `test/greet.test.js`—tests using `node:test`
- `script/test` and `script/test_fast`—test runners
- `.claude/prove_it/config.json`—default prove_it config (output of `prove_it init`)

## Prerequisites

- Node.js >= 18
- `prove_it install` (global hooks registered)

## Try it

Use this example directly (after cloning prove_it):

```bash
cd example/basic
./script/test          # run tests
```

Or copy the config to your own project:

```bash
cp .claude/prove_it/config.json /path/to/your/project/.claude/prove_it/config.json
```

## Testing hooks manually

Pipe simulated hook input to the dispatcher:

```bash
echo '{"hook_event_name":"Stop","session_id":"test","cwd":"."}' | prove_it hook claude:Stop
```

## Running from the local repo

To use the development version instead of the Homebrew install, prepend `test/bin` to your PATH. This uses the repo's `cli.js` directly, so changes track with the git ref:

```bash
# From this directory
PATH="../../test/bin:$PATH" prove_it hook claude:Stop < input.json
PATH="../../test/bin:$PATH" prove_it doctor

# Run Claude Code against this example with the local prove_it
cd example/basic
PATH="../../test/bin:$PATH" claude
```
