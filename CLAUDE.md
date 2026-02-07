# prove_it Development Guide

## Architecture

prove_it is a config-driven hook framework for Claude Code. It reads `.claude/prove_it.json` from a project directory and runs matching checks when Claude Code fires lifecycle events (SessionStart, PreToolUse, Stop). It also dispatches git hooks (pre-commit, pre-push).

### Key modules

- `cli.js` — CLI entry point, commands: install, uninstall, init, deinit, diagnose, hook
- `lib/dispatcher/claude.js` — Main dispatcher for Claude Code events
- `lib/dispatcher/git.js` — Dispatcher for git hooks
- `lib/dispatcher/protocol.js` — Output formatting for Claude Code hook API
- `lib/checks/script.js` — Runs shell commands as checks
- `lib/checks/agent.js` — Runs AI agent reviewer checks
- `lib/checks/builtins.js` — Built-in checks (session-baseline, config-protection, etc.)
- `lib/config.js` — Config loading, merging, and `buildConfig()` for init
- `lib/init.js` — Project initialization, git hook shim management
- `lib/template.js` — Template variable expansion for agent prompts
- `lib/globs.js` — File matching, source detection, config path detection

### Claude Code Hook API

- PreToolUse: `permissionDecision` valid values are `"allow"`, `"deny"`, `"ask"` (inside `hookSpecificOutput`). Never use `"block"` or `"approve"` — Claude Code silently ignores them.
- Stop: uses top-level `decision: "block"` or `"approve"` (different schema from PreToolUse).
- SessionStart: outputs plain text to stdout (no JSON).
- `session_id` is available in hook input for all events.

## Testing

```bash
./script/test          # lint + unit tests + integration tests (the verification oracle)
./script/test_fast     # lint + unit tests only (runs on Stop hook)
npm run test:e2e       # end-to-end beads integration
```

- Unit tests: `test/*.test.js`
- Integration tests: `test/integration/*.test.js`
- Example validation: `test/examples.test.js`
- Hook harness: `test/integration/hook-harness.js`

## Running from source (local development)

There is a shim at `test/bin/prove_it` that resolves to the repo's `cli.js`. To use the development version instead of the Homebrew install, prepend it to your PATH:

```bash
# From the repo root
PATH="$(pwd)/test/bin:$PATH" prove_it diagnose

# Test an example project with local prove_it
cd example/basic
PATH="../../test/bin:$PATH" prove_it hook claude:Stop <<< '{"hook_event_name":"Stop","session_id":"test","cwd":"."}'

# Run Claude Code with local prove_it hooks
PATH="$(pwd)/test/bin:$PATH" claude
```

This ensures `prove_it` commands in configs (like `prove_it builtin:session-baseline`) resolve to the local source, not the Homebrew install. Changes track with the git ref — you can check out any commit and test that version.

## Releasing

Use the `/release` skill. It reads `RELEASE.md` for the full process.

## Conventions

- No dependencies beyond Node.js stdlib (devDependencies: standard for linting only)
- Linter: `npx standard --fix` (run automatically by `./script/test_fast`)
- Config format: v2 schema with `configVersion: 2` and `hooks` array
- All builtins are invoked via `prove_it builtin:<name>` — they're part of the CLI
