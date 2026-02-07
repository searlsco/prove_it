# prove_it

Config-driven verification hooks for Claude Code.

prove_it makes Claude Code prove its work. Every time Claude edits files, commits code, or finishes a task, prove_it runs checks you configure: test suites, lint scripts, AI code reviewers. If a check fails, Claude gets blocked until it fixes the problem.

## Quick start

```bash
brew install searlsco/tap/prove_it    # install
prove_it install                       # register global hooks
cd your-project
prove_it init                          # interactive setup
```

Restart Claude Code. That's it — your tests now run automatically.

## What it does

prove_it hooks into Claude Code's lifecycle at three points:

| Event | When | Default checks |
|-------|------|----------------|
| **SessionStart** | Claude boots up | Record baseline, remind about issue tracker |
| **PreToolUse** | Before edits/commits | Protect config files, run tests before commit, AI code review |
| **Stop** | Claude finishes a task | Run fast tests, AI coverage review, remind to push |

It also installs git hooks (pre-commit, pre-push) so the same checks run for human commits too.

## How it works

1. `prove_it install` registers three thin dispatchers in `~/.claude/settings.json`
2. `prove_it init` creates `.claude/prove_it.json` in your project — a list of hooks and checks
3. When Claude Code fires an event, the dispatcher reads your config and runs matching checks
4. Checks are composable: scripts, builtins, or AI agent reviewers
5. Failed checks block Claude with actionable feedback

## Configuration

`.claude/prove_it.json` is a JSON file with a `hooks` array. Each hook has:

```json
{
  "type": "claude",
  "event": "Stop",
  "checks": [
    { "name": "fast-tests", "type": "script", "command": "./script/test_fast" },
    { "name": "coverage-review", "type": "agent", "prompt": "Check coverage...\n\n{{session_diffs}}" }
  ]
}
```

### Check types

- **script** — runs a shell command, fails on non-zero exit
- **agent** — sends a prompt to Claude, expects PASS/FAIL response

### Template variables

Expand in agent prompts:
- `{{staged_diff}}` — git staged changes
- `{{session_diffs}}` — all changes in this Claude session
- `{{test_output}}` — output from the most recent script check

### Conditional checks

```json
{ "name": "beads-gate", "type": "script", "command": "prove_it builtin:beads-gate",
  "when": { "fileExists": ".beads" } }
```

Supported conditions: `fileExists`, `envSet`, `envNotSet`.

### Hook types

- `"type": "claude"` — dispatched by Claude Code events (SessionStart, PreToolUse, Stop)
- `"type": "git"` — dispatched by git hooks (pre-commit, pre-push)

### Matchers and triggers

PreToolUse hooks can filter by tool name and command patterns:

```json
{
  "type": "claude",
  "event": "PreToolUse",
  "matcher": "Bash",
  "triggers": ["(^|\\s)git\\s+commit\\b"],
  "checks": [...]
}
```

## Commands

```
prove_it install     Register global hooks (~/.claude/settings.json)
prove_it uninstall   Remove global hooks
prove_it init        Set up project config (interactive or with flags)
prove_it deinit      Remove prove_it from current project
prove_it diagnose    Check installation and show effective config
prove_it hook <spec> Run a dispatcher directly (claude:Stop, git:pre-commit)
```

### Init flags

```
--[no-]git-hooks                Git pre-commit/pre-push hooks (default: yes)
--[no-]default-checks           Beads gate, AI code review, AI coverage review (default: yes)
--[no-]automatic-git-hook-merge Merge with existing git hooks (default: yes)
```

No flags + TTY = interactive prompts. No flags + no TTY = all defaults.

## Config layers

prove_it merges configuration from multiple sources (later wins):

1. **Defaults** — minimal baseline
2. **Global** — `~/.claude/prove_it/config.json`
3. **Ancestor configs** — `.claude/prove_it.json` from root-most directory to cwd
4. **Local** — `.claude/prove_it.local.json` (gitignored, per-developer overrides)

### Local overrides

`.claude/prove_it.local.json` merges on top of the team config. `prove_it init` creates it and adds it to `.gitignore`. Use it to disable checks locally:

```json
{ "enabled": false }
```

## Examples

See [`example/basic/`](example/basic/) and [`example/advanced/`](example/advanced/) for working projects with configs, tests, and instructions.

## Builtins

prove_it ships with several built-in checks:

| Builtin | Event | What it does |
|---------|-------|-------------|
| `session-baseline` | SessionStart | Records git state for session diff tracking |
| `beads-reminder` | SessionStart | Reminds Claude about issue tracker workflow |
| `config-protection` | PreToolUse | Blocks direct edits to prove_it config files |
| `beads-gate` | PreToolUse | Requires an in-progress issue before code changes |
| `soft-stop-reminder` | Stop | Reminds Claude to push and clean up |

## Development

### Running from source

The repo includes a shim at `test/bin/prove_it` that resolves to the local `cli.js`. To use the development version instead of the Homebrew install:

```bash
# From the repo root
PATH="$(pwd)/test/bin:$PATH" prove_it diagnose

# From an example directory
cd example/basic
PATH="../../test/bin:$PATH" prove_it hook claude:Stop < input.json
```

### Testing

```bash
./script/test          # unit + integration tests
./script/test_fast     # lint + unit tests only
npm run test:e2e       # end-to-end beads integration
```

### Releasing

See [RELEASE.md](RELEASE.md) for the full release process.

## Requirements

- Node.js >= 18
- Claude Code with hooks support

## License

MIT
