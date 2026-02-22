# prove_it Development Guide

## Architecture

prove_it is a config-driven hook framework for Claude Code. It reads `.claude/prove_it/config.json` from a project directory and runs matching tasks when Claude Code fires lifecycle events (SessionStart, PreToolUse, Stop). It also dispatches git hooks (pre-commit, pre-push).

### Key modules

- `cli.js`—CLI entry point, commands: install, uninstall, init, deinit, doctor, monitor, hook, run_builtin
- `lib/dispatcher/claude.js`—Main dispatcher for Claude Code events
- `lib/dispatcher/git.js`—Dispatcher for git hooks
- `lib/dispatcher/protocol.js`—Output formatting for Claude Code hook API
- `lib/checks/script.js`—Runs shell commands as tasks
- `lib/checks/agent.js`—Runs AI agent reviewer tasks
- `lib/checks/env.js`—Runs env tasks that inject environment variables via CLAUDE_ENV_FILE
- `lib/checks/builtins.js`—Built-in runnable tasks (config:lock, session:briefing)
- `lib/config.js`—Config loading, merging, and `buildConfig()` for init
- `lib/init.js`—Project initialization, git hook shim management
- `lib/template.js`—Template variable expansion for agent prompts
- `lib/globs.js`—File matching, source detection, config path detection
- `lib/monitor.js`—`prove_it monitor` CLI: tails session logs in human-readable format

### Claude Code Hook API

- PreToolUse: `permissionDecision` valid values are `"allow"`, `"deny"`, `"ask"` (inside `hookSpecificOutput`). Never use `"block"` or `"approve"`—Claude Code silently ignores them.
- Stop: uses top-level `decision: "block"` or `"approve"` (different schema from PreToolUse).
- SessionStart: outputs JSON with `additionalContext` and optionally `systemMessage`.
- `session_id` is available in hook input for all events.

## Testing

```bash
./script/test          # lint + unit tests + integration tests (the verification oracle)
./script/test_fast     # lint + unit tests only (runs on Stop hook)
npm run test:integration  # integration tests
```

- Unit tests: `test/*.test.js`
- Integration tests: `test/integration/*.test.js`
- Example validation: `test/examples.test.js`
- Hook harness: `test/integration/hook-harness.js`

## Running from source (local development)

Use `./script/agent` to launch Claude Code with the local prove_it on PATH:

```bash
./script/agent                    # interactive
./script/agent -p "fix the bug"  # with prompt
```

This prepends `test/bin/prove_it` (a shim to `cli.js`) to PATH so all hook dispatchers, builtins, and transitive `prove_it` calls use the working tree. A `local-shim-check` runs on SessionStart to confirm the shim is active.

See [AGENTS.md](AGENTS.md) for the full agent testing workflow.

## Releasing

Use the `/release` skill. It reads `RELEASE.md` for the full process.

## Two-tier installation model

prove_it uses a two-tier activation model: `enabled` defaults to `false` in the
dispatcher, so prove_it does nothing unless explicitly opted in.

- **`install`/`uninstall`** manage global hook registrations in `~/.claude/settings.json`
  and global config in `~/.claude/prove_it/config.json` (which sets `enabled: true`).
  These never touch project files.
- **`init`/`deinit`** manage project-level files only (`.claude/prove_it/config.json`, git shims).
  These never touch `~/.claude/settings.json`.

Because the global config sets `enabled: true`, prove_it runs in any project once
installed globally. Deleting a project's `.claude/prove_it/config.json` does not stop
prove_it if the global config has `enabled: true`—it just means no project-specific
tasks are configured.

## Conventions

- No dependencies beyond Node.js stdlib (devDependencies: standard for linting only)
- Linter: `npx standard --fix` (run automatically by `./script/test_fast`)
- Config format: `hooks` array containing `tasks`
- Runnable builtins are invoked via `prove_it run_builtin <namespace>:<name>`
- Agent reviewer prompts are distributed as Claude Code skills (`lib/skills/prove-coverage.md`, `lib/skills/prove-shipworthy.md`), resolved via `promptType: 'skill'`
