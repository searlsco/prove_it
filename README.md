# prove_it - Force Claude to actually verify its work

🔥 **Comin' in Hot! Shipping multiple unstable releases per day at the moment. If you want prove_it to actually work, [email Justin](mailto:justin@searls.co) for updates** 🛬🔥

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

By far the most frustrating thing about [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is its penchant for prematurely declaring success. Out-of-the-box, Claude will happily announce a task is complete. Has it run the tests? No. Did it add any tests? No. Did it run the code? Also no.

That's why I (well, Claude) wrote **prove_it**: to introduce structured verifiability into Claude's workflow. It hooks into Claude Code's [lifecycle events](https://code.claude.com/docs/en/hooks) and runs whatever tasks you configure — test suites, lint scripts, AI code reviewers — blocking Claude until they pass.

If it's not obvious, **prove_it only works with Claude Code.** If you're not using Claude Code, this tool won't do anything for you.

## What does prove_it prove?

The two most important things prove_it does:

* **Blocks stop** — each time Claude finishes its response and hands control back to the user, it fires ["stop" hooks](https://code.claude.com/docs/en/hooks#subagentstop). prove_it runs your fast tests (`script/test_fast`) and blocks if they fail. It can also deploy [reviewer agents](#agent-tasks) — a code quality review and a coverage review — that fire periodically based on how much code the agent has written
* **Blocks commits** — each time Claude attempts a `git commit`, prove_it runs `./script/test` and blocks unless it passes

Other stuff prove_it does:

* **Git hooks for Claude commits** — prove_it installs git pre-commit hooks that run your test suite when Claude commits. Human commits pass through instantly (the hooks only activate when the `CLAUDECODE` environment variable is set)
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
--[no-]default-checks           Include AI code review, AI coverage review (default: on)
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
        { "name": "coverage-review", "type": "agent", "prompt": "Check coverage...\n\n{{session_diff}}" }
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
| `SessionStart` | Environment setup, injecting context | **Non-blocking.** All tasks run. Output is injected into Claude's context. Errors are also surfaced to the user. Use this to inject prompts, announce project state, set environment variables, or run setup scripts. |
| `PreToolUse` | Guarding tool usage | **Blocking, fail-fast.** Tasks run in order; the first failure denies the tool and stops. Use this for config protection, enforcing workflows, or vetting commands before they execute. |
| `Stop` | Verifying completed work | **Blocking, fail-fast.** Tasks run in order; the first failure sends Claude back to fix it. Put cheap tasks first (test suite), expensive ones last (AI reviewer). |

**Git events:**

| Event | Purpose | Behavior |
|-------|---------|----------|
| `pre-commit` | Validating before commit | **Blocking, fail-fast.** Runs only under Claude Code (`CLAUDECODE` env var) — human commits pass through instantly. More reliable than Stop hooks because Claude can't skip them. |
| `pre-push` | Validating before push | **Blocking, fail-fast.** Same as pre-commit but triggers on push. |

**Example: PreToolUse guard**

Block Claude from editing config files:

```json
{
  "type": "claude",
  "event": "PreToolUse",
  "matcher": "Edit|Write|NotebookEdit|Bash",
  "tasks": [
    { "name": "lock-config", "type": "script", "command": "prove_it run_builtin config:lock" }
  ]
}
```

### Task types

- **`script`** — runs a shell command, fails on non-zero exit
- **`agent`** — sends a prompt to an AI reviewer, expects PASS/FAIL response (see [Agent tasks](#agent-tasks))
- **`env`** — runs a command that outputs environment variables, injected into Claude's session (SessionStart only, see [Env tasks](#env-tasks))

### Disabling individual tasks

Set `enabled: false` on a task to skip it without removing it from config:

```json
{ "name": "slow-review", "type": "agent", "prompt": "review:test_coverage",
  "promptType": "reference", "enabled": false }
```

Omitting `enabled` (or setting it to `true`) runs the task normally. Disabled tasks are logged as SKIP with reason "Disabled".

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
{ "name": "my-check", "type": "script", "command": "./script/check",
  "when": { "fileExists": ".config" } }
```

Supported conditions:

| Condition | Category | Type | Description |
|-----------|----------|------|-------------|
| `fileExists` | prerequisite | string | Passes when file exists relative to project root |
| `envSet` | prerequisite | string | Passes when environment variable is set |
| `envNotSet` | prerequisite | string | Passes when environment variable is not set |
| `variablesPresent` | prerequisite | string[] | Passes when all listed template variables resolve to non-empty values |
| `linesWrittenSinceLastRun` | trigger | number | Passes when at least N source lines have changed (additions + deletions) since the task last ran. Backed by git refs — works in both Claude hooks and git hooks. |
| `linesChangedSinceLastRun` | trigger | number | Passes when at least N gross lines have been written by the agent since the task last ran. Tracks cumulative Write/Edit/NotebookEdit activity — catches thrashing (back-and-forth edits that net to zero). Claude Code sessions only. |
| `sourcesModifiedSinceLastRun` | trigger | boolean | Passes when source file mtimes are newer than the last run |
| `sourceFilesEdited` | trigger | boolean | Passes when source files were edited this turn (session-scoped, tool-agnostic) |
| `toolsUsed` | trigger | string[] | Passes when any of the listed tools were used this turn |

**Prerequisites** are environmental gates — all must pass (AND). **Triggers** are activity signals — any one passing is enough to fire the task (OR). Prerequisites are checked first; if any fails, the task is skipped regardless of triggers. When no triggers are present, prerequisites alone decide. This means you can combine a prerequisite like `envSet` with multiple triggers like `linesWrittenSinceLastRun` and `linesChangedSinceLastRun` — the env var must be set, but either churn threshold will fire the review:

```json
{
  "name": "coverage-review",
  "type": "agent",
  "prompt": "review:test_coverage",
  "promptType": "reference",
  "when": {
    "envSet": "CLAUDECODE",
    "linesWrittenSinceLastRun": 500,
    "linesChangedSinceLastRun": 1000
  }
}
```

#### Git-based churn tracking (`linesWrittenSinceLastRun`)

Each task using `linesWrittenSinceLastRun` stores a git ref at `refs/worktree/prove_it/<task-name>`. When the condition is evaluated, prove_it diffs the ref against the **working tree** (not just HEAD), filtered to your configured `sources` globs, summing additions and deletions. This means committed, staged, unstaged, and newly-created file changes all count — so Write/Edit tool calls trigger churn immediately without needing a commit. On first run the ref is created at HEAD (bootstrap — returns 0 if the working tree is clean). This is session-independent and worktree-safe. Refs are cleaned up by `prove_it deinit`.

When a task passes or resets, the ref advances to a snapshot of the current working tree state (including untracked source files). This ensures all pending changes are captured — advancing to HEAD alone would be a no-op when churn comes from uncommitted Write/Edit operations.

**`resetOnFail` behavior**: When a task fails, the ref advancement depends on the hook event:
- **PreToolUse** (default `resetOnFail: true`): The ref advances on failure. Without this, the task deadlocks — it blocks every Write/Edit, including writes to test files that would fix the issue.
- **Stop / git hooks** (default `resetOnFail: false`): The ref does NOT advance. The agent gets sent back to fix the issue, and the same accumulated churn keeps triggering the review.
- You can override the default with an explicit `resetOnFail: true` or `resetOnFail: false` on the task.

#### Gross churn tracking (`linesChangedSinceLastRun`)

While `linesWrittenSinceLastRun` measures **net** drift (git diff: what changed on disk), `linesChangedSinceLastRun` measures **gross** activity (total lines the agent has written). This catches a different failure mode: thrashing. An agent that writes 500 lines, deletes them, rewrites them differently, and deletes again has written 2000 gross lines but may show 0 net churn. The gross counter catches this.

Gross churn accumulates on every successful PreToolUse for Write/Edit/NotebookEdit to source files. Lines are counted from the tool input (no file I/O needed). The counter is stored as a git blob under `refs/worktree/prove_it/__gross_lines`, with per-task snapshots under `<task>.__gross_lines`. Increment uses compare-and-swap for multi-agent safety — concurrent agents can't lose each other's counts.

`resetOnFail` follows the same rules as `linesWrittenSinceLastRun`.

#### Session-scoped conditions

`sourceFilesEdited` and `toolsUsed` are **session-scoped**: they track which tools and files each Claude Code session uses, per-turn. After a successful Stop, the tracking resets so the next Stop only fires if new edits occur.

These conditions solve cross-session bleed — unlike `sourcesModifiedSinceLastRun` (which uses global file timestamps), session-scoped conditions ensure Session A's edits don't trigger Session B's reviewers.

**`sourceFilesEdited: true`** — Gates a task on source file edits in the current turn:

```json
{
  "name": "my-review",
  "type": "agent",
  "prompt": "Review the changes...",
  "when": { "sourceFilesEdited": true }
}
```

**`toolsUsed: ["XcodeEdit", "Edit"]`** — Gates a task on specific tools being used:

```json
{
  "name": "xcode-review",
  "type": "agent",
  "prompt": "Review Xcode changes...",
  "when": { "toolsUsed": ["XcodeEdit"] }
}
```

### Tracking MCP editing tools

By default, prove_it tracks Claude's built-in editing tools (`Edit`, `Write`, `NotebookEdit`). If Claude edits files through MCP tools (e.g. Xcode MCP's `XcodeEdit`), add them to `fileEditingTools` so prove_it can track them:

```json
{
  "configVersion": 3,
  "fileEditingTools": ["XcodeEdit"],
  "sources": ["**/*.swift", "**/*.m"],
  "hooks": [...]
}
```

Tools listed in `fileEditingTools` are tracked alongside the builtins — they participate in `sourceFilesEdited`, `toolsUsed`, gross churn (`linesChangedSinceLastRun`), and the `session_diff` git fallback. For gross churn, line counts are estimated from the longest string value in the tool input.

## Env tasks

Env tasks run a command during SessionStart and inject the output as environment variables into Claude Code's session. They only run on `startup` and `resume` (not after `/clear` or compaction, where the environment is already set).

```json
{
  "type": "claude",
  "event": "SessionStart",
  "tasks": [
    { "name": "load-env", "type": "env", "command": "./script/load_env.sh" }
  ]
}
```

The command's stdout is parsed as environment variables. Three output formats work:

```bash
# .env format
API_KEY=abc123
DEBUG=true

# export format
export API_KEY=abc123
export DEBUG="true"
```

```
{"API_KEY": "abc123", "DEBUG": "true"}
```

Multiple env tasks merge in order — later tasks override earlier ones for the same key. If the command fails or output can't be parsed, the error is reported and execution continues.

## Subprocess environment

When prove_it spawns reviewer subagents or runs script tasks, other hooks installed in your environment (like [turbocommit](https://github.com/Siege/turbocommit)) may fire inside those subprocesses. Use the top-level `taskEnv` field to set environment variables across all prove_it subprocesses:

```json
{
  "configVersion": 3,
  "taskEnv": {
    "TURBOCOMMIT_DISABLED": "1"
  },
  "hooks": [...]
}
```

These variables are merged into the environment of both script tasks and agent reviewer subprocesses. prove_it forces `PROVE_IT_DISABLED` and `PROVE_IT_SKIP_NOTIFY` in all subprocesses to prevent recursion — these cannot be overridden by `taskEnv`. Reviewer subprocesses additionally force `CLAUDECODE` and `LC_ALL`.

**Merge order** (last wins):
1. `process.env` — inherited base environment
2. `taskEnv` — your config values
3. prove_it forced vars — recursion prevention, always win

## Agent tasks

Agent tasks spawn a separate AI process to review Claude's work with an independent PASS/FAIL verdict. This is useful because the reviewing agent has no stake in the code it's judging.

By default, agent tasks use `claude -p` (Claude Code in pipe mode). The reviewer receives a wrapped prompt and must respond with `PASS` or `FAIL: <reason>`.

```json
{
  "name": "my-review",
  "type": "agent",
  "prompt": "Review recent changes for:\n1. Test coverage gaps\n2. Logic errors or edge cases\n3. Dead code\n\n{{recently_edited_files}}\n\n{{recent_commits}}\n\n{{git_status}}"
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
| `{{session_diff}}` | All changes since session baseline (uses Claude Code file-history, falls back to git diff scoped to tracked files) |
| `{{test_output}}` | Output from the most recent script check |
| `{{tool_command}}` | The command Claude is trying to run |
| `{{file_path}}` | The file Claude is trying to edit |
| `{{project_dir}}` | Project directory |
| `{{git_head}}` | Current HEAD commit SHA |
| `{{git_status}}` | `git status --short` (staged/modified/untracked files) |
| `{{recent_commits}}` | `git log --oneline --stat -5` (last 5 commits with file stats) |

### Rule files

Agent tasks accept a `ruleFile` field that injects the contents of a project-specific rule file into the reviewer prompt. This lets you define testing standards (or other review criteria) once and apply them to every reviewer:

```json
{
  "name": "coverage-review",
  "type": "agent",
  "prompt": "review:test_coverage",
  "promptType": "reference",
  "ruleFile": ".claude/rules/testing.md"
}
```

The path is resolved relative to the project directory. If the file is missing, the task fails with a clear error — this is intentional so you don't silently run reviews without your rules.

`prove_it init` generates a default `.claude/rules/testing.md` with starter rules and a TODO for you to customize. The default agent tasks (`code-quality-review`, `coverage-review`) both point to this file.

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

### Model selection

Agent tasks accept a `model` field to control which model the reviewer uses. For Claude models, prove_it appends `--model <model>` to the `claude -p` command automatically:

```json
{
  "name": "coverage-review",
  "type": "agent",
  "prompt": "Check test coverage...\n\n{{session_diff}}",
  "model": "haiku"
}
```

For OpenAI/codex models (names starting with `gpt-`), prove_it auto-switches to `codex exec -` and appends `--model`:

```json
{
  "name": "adversarial-review",
  "type": "agent",
  "prompt": "Review this code for bugs...\n\n{{staged_diff}}",
  "model": "gpt-5.3-codex"
}
```

This is equivalent to setting `"command": "codex exec -"` and `"model": "gpt-5.3-codex"` separately. An explicit `command` always takes precedence over auto-detection.

When no `model` is set and no custom `command` is provided, prove_it applies sensible defaults based on the hook event:

| Event | Default model | Rationale |
|-------|--------------|-----------|
| PreToolUse | `haiku` | Latency-sensitive gate check |
| Stop | `haiku` | Latency-sensitive review |
| pre-commit | `sonnet` | Thoroughness matters more |
| pre-push | `sonnet` | Thoroughness matters more |

An explicit `model` always wins. Setting a custom `command` disables default model selection entirely (prove_it won't append `--model` to unknown CLIs). The `--model` flag is appended only for `claude` and `codex` binaries.

## Builtins

prove_it ships with built-in tasks invoked via `prove_it run_builtin <name>`:

| Builtin | Type | What it does |
|---------|------|-------------|
| `config:lock` | script | Blocks direct edits to prove_it config files |
| `review:code_quality` | agent prompt | Reviews for logic errors, dead code, error handling gaps, naming contradictions |
| `review:commit_quality` | agent prompt | Reviews staged diff for test coverage gaps, logic errors, dead code |
| `review:test_coverage` | agent prompt | Reviews session diffs for test coverage adequacy |
| `review:test_investment` | agent prompt | Reviews whether recent edits include adequate test investment |

## Skills

prove_it installs a Claude Code [skill](https://code.claude.com/docs/en/skills)
called `/prove` — evidence-based verification that forces Claude to actually
run the thing and show you the results.

Invoke it with `/prove <claim>` (e.g., `/prove the search API handles
pagination`). If you just type `/prove` with uncommitted changes, it'll prove
those changes work. Claude will:

1. **State what it's trying to prove** and what "working" looks like
2. **Show evidence it works** — commands, output, artifacts
3. **Show evidence it might not work** — edge cases, error paths, things it tried to break
4. **Give its honest judgment** — ready to ship, or what needs to change

The skill is installed to `~/.claude/skills/prove/SKILL.md` and updated on
every `prove_it install`.

## Monitoring

Run `prove_it monitor` in a separate terminal to watch hook results in real time:

```
prove_it monitor
Session: ea0da8e4 | /Users/justin/code/searls/sugoi_tv | started 02/13/2026, 08:53

09:00:48  CRASH  coverage-review       Unexpected reviewer output: Based on my investigation…
09:00:52  PASS   fast-tests            ./script/test_fast passed (2.3s)
09:01:12  SKIP   fast-tests            cached pass (no code changes)
09:14:33  PASS   commit-review         All changes look correct and well-tested.

watching for new entries… (ctrl-c to stop)
```

All task types — script, agent, and env — log their outcomes to session `.jsonl` files. The monitor formats these into a human-readable stream.

```
prove_it monitor             # tail most recent session
prove_it monitor --all       # tail all sessions and project logs
prove_it monitor <id>        # tail a specific session (prefix match OK)
```

## Commands

```
prove_it install       Register global hooks (~/.claude/settings.json)
prove_it uninstall     Remove global hooks
prove_it init          Set up current project (interactive or with flags)
prove_it deinit        Remove prove_it from current project
prove_it doctor        Check installation and show effective config
prove_it monitor       Tail hook results in real time
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
prove_it doctor
```

- **Hooks not firing** — Restart Claude Code after `prove_it install`
- **Tests not running** — Check `./script/test` exists and is executable (`chmod +x`)
- **Hooks running in wrong directories** — prove_it only activates in git repos
- **Reviews never fire** — The default `when` conditions use churn thresholds (`linesWrittenSinceLastRun`, `linesChangedSinceLastRun`). Reviews only trigger after enough code has been written. Check `prove_it monitor` to see skip reasons with current/threshold counts. If you use MCP tools that edit files (e.g. Xcode MCP's `XcodeEdit`), add them to `fileEditingTools` so all churn tracking works for those tools:
  ```json
  {
    "fileEditingTools": ["XcodeEdit"],
    "hooks": [...]
  }
  ```

## Examples

See [`example/basic/`](example/basic/) and [`example/advanced/`](example/advanced/) for working projects with configs, test suites, and reviewer prompts.

## Requirements

- Node.js >= 18
- Claude Code with hooks support

## License

MIT
