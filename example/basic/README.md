# prove_it basic example

A minimal project showing prove_it's default configuration.

## What's included

- `src/greet.js` — a simple greeting module
- `test/greet.test.js` — tests using `node:test`
- `script/test` and `script/test_fast` — test runners
- `.claude/prove_it.json` — default prove_it config (output of `prove_it init`)

## Prerequisites

- Node.js >= 18
- `prove_it install` (global hooks registered)

## Try it

Option 1: Use this example directly (after cloning prove_it):

```bash
cd example/basic
./script/test          # run tests
```

Option 2: Copy the config to your own project:

```bash
cp .claude/prove_it.json /path/to/your/project/.claude/prove_it.json
```

## Testing hooks manually

Pipe simulated hook input to the dispatcher:

```bash
echo '{"hook_event_name":"Stop","session_id":"test","cwd":"."}' | prove_it hook claude:Stop
```

## Local development

To test against a local prove_it clone, create `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|clear|compact",
      "hooks": [{ "type": "command", "command": "node ../../cli.js hook claude:SessionStart" }] }],
    "PreToolUse": [{ "matcher": "Edit|Write|NotebookEdit|Bash",
      "hooks": [{ "type": "command", "command": "node ../../cli.js hook claude:PreToolUse" }] }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "node ../../cli.js hook claude:Stop" }] }]
  }
}
```
