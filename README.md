# prove_it - Force Claude to actually verify its work

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

By far the most frustrating thing about [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is its penchant for prematurely declaring success. Out-of-the-box, Claude will happily announce a task is complete. Has it run the tests? No. Did it add any tests? No. Did it run the code? Also no.

That's why I (well, Claude) wrote **prove_it**: to introduce structured verifiability into Claude's workflow. It hooks into Claude Code's [lifecycle events](https://code.claude.com/docs/en/hooks) and runs whatever tasks you configure — test suites, lint scripts, AI code reviewers — blocking Claude until they pass.

If it's not obvious, **prove_it only works with Claude Code.** If you're not using Claude Code, this tool won't do anything for you.

## What does prove_it prove?

The two most important things prove_it does:

* **Blocks stop** — each time Claude finishes its response and hands control back to the user, it fires ["stop" hooks](https://code.claude.com/docs/en/hooks#subagentstop). prove_it runs your fast tests (`script/test_fast`) and blocks if they fail. It can also deploy a [reviewer agent](#agent-tasks) to check whether commensurate verification methods (e.g. test coverage) were introduced for whatever code was added during the response
* **Blocks commits** — each time Claude attempts a `git commit`, prove_it runs `./script/test` and blocks unless it passes. It can then deploy a [reviewer agent](#agent-tasks) that inspects all staged changes and hunts for potential bugs and dead code, blocking if it finds anything significant

Other stuff prove_it does:

* **Git hooks for Claude commits** — prove_it installs git pre-commit hooks that run your test suite when Claude commits. Human commits pass through instantly (the hooks only activate when the `CLAUDECODE` environment variable is set)
* **[Beads](https://github.com/steveyegge/beads) integration** — if your project uses beads to track work, prove_it will stop Claude from editing code unless a current task is in progress, essentially forcing it to know _what_ it's working on before it starts working
* **Tracks runs** — if code hasn't changed since the last successful test run, prove_it skips re-running your tests (configurable per-task)
* **Config protection** — blocks Claude from editing your prove_it config files directly

## Setup

```bash
# Install the CLI
brew install searlsco/tap/prove_it

# Register prove_it hooks in ~/.claude/settings.json
prove_it install
```

Then, in each project:

```bash
cd your-project
prove_it init
```

This will interactively set up `.claude/prove_it.json`, create a `script/test` stub if you don't have one, and install git hooks. Restart Claude Code and you're live.

### Non-interactive init

Pass flags to skip prompts (useful for CI or scripting):

```bash
prove_it init --git-hooks --default-checks
```

Available flags:

```
--[no-]git-hooks                Install git pre-commit/pre-push hooks (default: on)
--[no-]default-checks           Include beads gate, AI code review, AI coverage review (default: on)
--[no-]automatic-git-hook-merge Merge with existing git hooks (default: off — fails if hooks exist)
```

## Test scripts

By default, prove_it looks for two test scripts by convention:

| Script | Purpose | When it runs |
|--------|---------|--------------|
| `script/test` | Full test suite (units, integration, linters, etc.) | Before every `git commit` |
| `script/test_fast` | Fast unit tests only | Every time Claude stops work |

For example, your `script/test_fast` script might run:

```bash
#!/usr/bin/env bash
set -e
trap 'prove_it record --name fast-tests --result $?' EXIT
rake test
```

And your full `script/test` command will probably run that and more:

```bash
#!/usr/bin/env bash
set -e
trap 'prove_it record --name full-tests --result $?' EXIT
rake test standard:fix test:system
```

The `trap ... EXIT` pattern ensures results are always recorded, even when `set -e` causes early exit. prove_it uses this to skip re-running tests when code hasn't changed.

That's it. Now Claude must see your tests pass before claiming the job's done or committing your code.

### Recording runs from test scripts

The `trap ... EXIT` pattern shown above ensures prove_it's mtime cache stays current — when code hasn't changed since the last pass, hooks skip re-running your tests.

`prove_it record` options:
- `--result <N>` — record pass (N=0) or fail (N!=0), exit with code N (best for traps)
- `--pass` / `--fail` — record explicitly (exit 0 / exit 1)
- `--name <task>` — must match the task name in your `prove_it.json` config

## Configuration

prove_it is configured with a `hooks` array in `.claude/prove_it.json`. Each hook targets a lifecycle event and runs an ordered list of tasks:

```json
{
  "configVersion": 3,
  "enabled": true,
  "sources": ["src/**/*.js", "lib/**/*.js", "test/**/*.js"],
  "hooks": [
    {
      "type": "claude",
      "event": "Stop",
      "tasks": [
        { "name": "fast-tests", "type": "script", "command": "./script/test_fast" },
        { "name": "coverage-review", "type": "agent", "prompt": "Check coverage...\n\n{{session_diffs}}" }
      ]
    }
  ]
}
```

### Config layers

Config files merge (later overrides earlier):

1. `~/.claude/prove_it/config.json` — global defaults
2. `.claude/prove_it.json` — project config (commit this)
3. `.claude/prove_it.local.json` — local overrides (gitignored, per-developer)

### Lifecycle events

Each event type serves a different purpose. Tasks within a hook run in order.

**Claude events:**

| Event | Purpose | Behavior |
|-------|---------|----------|
| `SessionStart` | Environment setup, injecting context | **Non-blocking.** All tasks run. Output is printed to Claude's context via stdout — use this to inject prompts, announce project state, or run setup scripts. |
| `PreToolUse` | Guarding tool usage | **Blocking, fail-fast.** Tasks run in order; the first failure denies the tool and stops. Use this for config protection, enforcing workflows, or vetting commands before they execute. |
| `Stop` | Verifying completed work | **Blocking, fail-fast.** Tasks run in order; the first failure sends Claude back to fix it. Put cheap tasks first (test suite), expensive ones last (AI reviewer). |

**Git events:**

| Event | Purpose | Behavior |
|-------|---------|----------|
| `pre-commit` | Validating before commit | **Blocking, fail-fast.** Runs only under Claude Code (`CLAUDECODE` env var) — human commits pass through instantly. More reliable than Stop hooks because Claude can't skip them. |
| `pre-push` | Validating before push | **Blocking, fail-fast.** Same as pre-commit but triggers on push. |

**Example: PreToolUse guard**

Block Claude from editing config files and require a tracked task before code changes:

```json
{
  "type": "claude",
  "event": "PreToolUse",
  "matcher": "Edit|Write|NotebookEdit|Bash",
  "tasks": [
    { "name": "lock-config", "type": "script", "command": "prove_it run_builtin config:lock" },
    { "name": "require-wip", "type": "script", "command": "prove_it run_builtin beads:require_wip",
      "when": { "fileExists": ".beads" } }
  ]
}
```

### Task types

- **`script`** — runs a shell command, fails on non-zero exit
- **`agent`** — sends a prompt to an AI reviewer, expects PASS/FAIL response (see [Agent tasks](#agent-tasks))

### Matchers and triggers

PreToolUse hooks can filter by tool name and command patterns:

```json
{
  "type": "claude",
  "event": "PreToolUse",
  "matcher": "Bash",
  "triggers": ["(^|\\s)git\\s+commit\\b"],
  "tasks": [...]
}
```

`matcher` filters by Claude's tool name (`Edit`, `Write`, `Bash`, etc.). `triggers` are regex patterns matched against the tool's command argument. Both are optional — omit them to run on every PreToolUse.

### Conditional tasks

```json
{ "name": "require-wip", "type": "script", "command": "prove_it run_builtin beads:require_wip",
  "when": { "fileExists": ".beads" } }
```

Supported conditions: `fileExists`, `envSet`, `envNotSet`.

## Agent tasks

Agent tasks spawn a separate AI process to review Claude's work with an independent PASS/FAIL verdict. This is useful because the reviewing agent has no stake in the code it's judging.

By default, agent tasks use `claude -p` (Claude Code in pipe mode). The reviewer receives a wrapped prompt and must respond with `PASS` or `FAIL: <reason>`.

```json
{
  "name": "commit-review",
  "type": "agent",
  "prompt": "Review staged changes for:\n1. Test coverage gaps\n2. Logic errors or edge cases\n3. Dead code\n\n{{staged_diff}}"
}
```

### Template variables

These expand in agent prompts:

| Variable | Contents |
|----------|----------|
| `{{staged_diff}}` | `git diff --cached` (staged changes) |
| `{{staged_files}}` | `git diff --cached --name-only` |
| `{{working_diff}}` | `git diff` (unstaged changes) |
| `{{changed_files}}` | `git diff --name-only HEAD` |
| `{{session_diffs}}` | All changes since session baseline |
| `{{test_output}}` | Output from the most recent script check |
| `{{tool_command}}` | The command Claude is trying to run |
| `{{file_path}}` | The file Claude is trying to edit |
| `{{project_dir}}` | Project directory |
| `{{git_head}}` | Current HEAD commit SHA |

### Adversarial cross-platform review

You can use a different AI for each reviewer, so the agent doing the work is checked by a competing model:

```json
{
  "name": "commit-review",
  "type": "agent",
  "prompt": "Review staged changes for bugs and missing tests.\n\n{{staged_diff}}"
},
{
  "name": "adversarial-review",
  "type": "agent",
  "command": "codex exec -",
  "prompt": "Second opinion: look for issues the primary reviewer might miss.\n\n{{staged_diff}}"
}
```

The `command` field accepts any CLI that reads a prompt from stdin and writes its response to stdout. Defaults to `claude -p`.

## Builtins

prove_it ships with built-in tasks invoked via `prove_it run_builtin <name>`:

| Builtin | Event | What it does |
|---------|-------|-------------|
| `config:lock` | PreToolUse | Blocks direct edits to prove_it config files |
| `beads:require_wip` | PreToolUse | Requires an in-progress issue before code changes |
| `review:commit_quality` | pre-commit | Agent reviews staged diff for bugs and dead code |
| `review:test_coverage` | Stop | Agent reviews session diffs for test coverage |

## Commands

```
prove_it install       Register global hooks (~/.claude/settings.json)
prove_it uninstall     Remove global hooks
prove_it init          Set up current project (interactive or with flags)
prove_it deinit        Remove prove_it from current project
prove_it diagnose      Check installation and show effective config
prove_it hook <spec>   Run a dispatcher directly (claude:Stop, git:pre-commit)
prove_it run_builtin <namespace:name> Run a builtin check directly
prove_it record        Record a test run result (--name <check> --pass|--fail|--result <N>)
```

## Disabling prove_it

prove_it only runs in directories that contain a git repository, so casual use of Claude in `~/tmp` or `~/bin` won't trigger it.

When you do need to disable it:

### Ignore specific directories

Edit `~/.claude/prove_it/config.json`:

```json
{
  "ignoredPaths": ["~/bin", "~/dotfiles"]
}
```

### Disable for a project

For all contributors — edit `.claude/prove_it.json`:
```json
{ "enabled": false }
```

For just you — edit `.claude/prove_it.local.json`:
```json
{ "enabled": false }
```

### Disable with an environment variable

```bash
export PROVE_IT_DISABLED=1
```

## Troubleshooting

```bash
prove_it diagnose
```

- **Hooks not firing** — Restart Claude Code after `prove_it install`
- **Tests not running** — Check `./script/test` exists and is executable (`chmod +x`)
- **Hooks running in wrong directories** — prove_it only activates in git repos

## Examples

See [`example/basic/`](example/basic/) and [`example/advanced/`](example/advanced/) for working projects with configs, test suites, and reviewer prompts.

## Requirements

- Node.js >= 18
- Claude Code with hooks support

## License

MIT
