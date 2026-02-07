# prove_it - Force Claude to actually verify its work

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

By far the most frustrating thing about [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is its penchant for prematurely declaring success. Out-of-the-box, Claude will happily announce a task is complete. Has it run the tests? No. Did it add any tests? No. Did it run the code? Also no.

That's why I (well, Claude) wrote **prove_it**: to introduce structured and unstructured verifiability checks into Claude's workflow. It hooks into Claude Code's [lifecycle events](https://code.claude.com/docs/en/hooks) and runs whatever checks you configure — test suites, lint scripts, AI code reviewers — blocking Claude until they pass.

If it's not obvious, **prove_it only works with Claude Code.** If you're not using Claude Code, this tool won't do anything for you.

## What does prove_it prove?

The two most important things prove_it does:

* **Blocks stop** — each time Claude finishes its response and hands control back to the user, it fires ["stop" hooks](https://code.claude.com/docs/en/hooks#subagentstop). prove_it runs your fast tests (`script/test_fast`) and blocks if they fail. It can also deploy a [reviewer agent](#agent-checks) to check whether commensurate verification methods (e.g. test coverage) were introduced for whatever code was added during the response
* **Blocks commits** — each time Claude attempts a `git commit`, prove_it runs `./script/test` and blocks unless it passes. It can then deploy a [reviewer agent](#agent-checks) that inspects all staged changes and hunts for potential bugs and dead code, blocking if it finds anything significant

Other stuff prove_it does:

* **Blocks human commits too** — prove_it installs git pre-commit and pre-push hooks so the same test checks run whether Claude or a human is committing
* **[Beads](https://github.com/steveyegge/beads) integration** — if your project uses beads to track work, prove_it will stop Claude from editing code unless a current task is in progress, essentially forcing it to know _what_ it's working on before it starts working
* **Tracks runs** — if code hasn't changed since the last successful test run, prove_it skips re-running your tests (configurable per-check)
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
#!/bin/bash
rake test
```

And your full `script/test` command will probably run that and more:

```bash
#!/bin/bash
rake test standard:fix test:system
```

That's it. Now Claude must see your tests pass before claiming the job's done or committing your code.

## Configuration

prove_it is configured with a `hooks` array in `.claude/prove_it.json`. Each hook targets a lifecycle event and runs a list of checks:

```json
{
  "configVersion": 2,
  "enabled": true,
  "sources": ["src/**/*.js", "lib/**/*.js", "test/**/*.js"],
  "hooks": [
    {
      "type": "claude",
      "event": "Stop",
      "checks": [
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

### Hook types

| Type | Event | What triggers it |
|------|-------|-----------------|
| `claude` | `SessionStart` | Claude boots up |
| `claude` | `PreToolUse` | Before Claude uses a tool (edit, commit, etc.) |
| `claude` | `Stop` | Claude finishes a task |
| `git` | `pre-commit` | Before any git commit (Claude or human) |
| `git` | `pre-push` | Before any git push |

### Check types

- **`script`** — runs a shell command, fails on non-zero exit
- **`agent`** — sends a prompt to an AI reviewer, expects PASS/FAIL response (see [Agent checks](#agent-checks))

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

`matcher` filters by Claude's tool name (`Edit`, `Write`, `Bash`, etc.). `triggers` are regex patterns matched against the tool's command argument. Both are optional — omit them to run on every PreToolUse.

### Conditional checks

```json
{ "name": "beads-gate", "type": "script", "command": "prove_it builtin:beads-gate",
  "when": { "fileExists": ".beads" } }
```

Supported conditions: `fileExists`, `envSet`, `envNotSet`.

## Agent checks

Agent checks spawn a separate AI process to review Claude's work with an independent PASS/FAIL verdict. This is useful because the reviewing agent has no stake in the code it's judging.

By default, agent checks use `claude -p` (Claude Code in pipe mode). The reviewer receives a wrapped prompt and must respond with `PASS` or `FAIL: <reason>`.

```json
{
  "name": "code-review",
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
  "name": "code-review",
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

prove_it ships with built-in checks invoked via `prove_it builtin:<name>`:

| Builtin | Event | What it does |
|---------|-------|-------------|
| `session-baseline` | SessionStart | Records git state for session diff tracking |
| `beads-reminder` | SessionStart | Reminds Claude about issue tracker workflow |
| `config-protection` | PreToolUse | Blocks direct edits to prove_it config files |
| `beads-gate` | PreToolUse | Requires an in-progress issue before code changes |
| `soft-stop-reminder` | Stop | Reminds Claude to push and clean up |

## Commands

```
prove_it install     Register global hooks (~/.claude/settings.json)
prove_it uninstall   Remove global hooks
prove_it init        Set up current project (interactive or with flags)
prove_it deinit      Remove prove_it from current project
prove_it diagnose    Check installation and show effective config
prove_it hook <spec> Run a dispatcher directly (claude:Stop, git:pre-commit)
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
