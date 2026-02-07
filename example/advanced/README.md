# prove_it advanced example

A project demonstrating custom prove_it configuration: custom lint scripts,
domain-specific agent prompts, custom timeouts, and `when` conditions.

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
- `.claude/prove_it.json` — customized prove_it config

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
