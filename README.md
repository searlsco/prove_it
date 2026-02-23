# prove_it—Force Claude to actually verify its work

🔥 **Comin' in Hot! Shipping multiple unstable releases per day at the moment. If you want prove_it to actually work, [email Justin](mailto:justin@searls.co) for updates** 🛬🔥

**If you experience errors after an upgrade, reset your setup with `prove_it reinstall && prove_it reinit`.**

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

By far the most frustrating thing about [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is its penchant for prematurely declaring success. Out-of-the-box, Claude will happily announce a task is complete. But has it run the tests? No. Did it add any tests? No. Did it run the code? Also no.

**prove_it** hooks into Claude Code's [lifecycle events](https://code.claude.com/docs/en/hooks) and runs whatever tasks you configure—test suites, lint scripts, AI code reviewers—blocking Claude until they pass.

(And in case it's not obvious, **prove_it currently only works with Claude Code.**)

## Quick start

```bash
brew install searlsco/tap/prove_it
prove_it install
cd your-project && prove_it init
```

Restart Claude Code and you're live.

## What can prove_it do?

prove_it is a config-driven framework for enforcing quality in Claude Code sessions. You can easily configure **script** and **subagent** tasks in a few lines of JSON that:

- **Block Claude from stopping** until your tests pass
- **Block git commits** until a full test suite is green
- **Run AI reviewers** — independent subagents that audit Claude's work for coverage gaps, logic errors, or security issues
- **Fire reviews asynchronously** — expensive reviewers run in the background while Claude keeps working, then enforce their verdict on the next stop
- **Gate tasks on signals** — heavyweight checks fire only when Claude declares a unit of work complete (`prove_it signal done`), or when Claude gets caught in a doom loop (`prove_it signal stuck --message "can't figure out Liquid Glass"`)
- **Gate tasks on churn** — reviews trigger after N lines changed (net git diff) or N lines written (gross, catches thrashing)
- **Inject context on session start** — briefs your agent on what prove_it will inspect for and when, along with instructions on how to use it
- **Guard tool usage** — block specific tool calls (config file edits, dangerous commands) before they execute
- **Track runs** — skip re-running tests when code hasn't changed since the last pass

Out of the box, `prove_it init` generates the Searls-stack of configured tasks:

- **Session briefing** on startup — Claude gets an orientation showing active tasks, signal instructions, and how the review process works
- **Config lock** on every edit — silently blocks Claude from modifying your prove_it config
- **Fast tests on every stop** — runs `./script/test_fast` and blocks until it passes
- **Full tests on signal** — runs `./script/test` when Claude signals done (and source files were edited)
- **Async coverage review** — a Haiku-powered `prove-coverage` subagent fires in the background after 541+ net lines of churn, enforced on the next stop
- **Shipworthy review on signal** — an Opus-powered `prove-shipworthy` subagent runs a thorough pre-ship review when Claude signals done
- **Full tests on git commit** — pre-commit hook runs `./script/test` (Claude commits only — human commits pass through)

Every one of these is a config entry you can change, disable, or replace. The framework supports any combination of lifecycle events, conditions, and task types — the default config is just a starting point.

## Setup

### Install

```bash
# Install the CLI
brew install searlsco/tap/prove_it

# Register prove_it hooks in ~/.claude/settings.json
prove_it install
```

### Initialize a project

```bash
cd your-project
prove_it init
```

This interactively sets up `.claude/prove_it/config.json`, creates `script/test` and `script/test_fast` stubs if you don't have them, installs git hooks, and generates a starter `.claude/rules/testing.md`. Restart Claude Code and you're live.

### Non-interactive init

Pass flags to skip prompts (useful for CI or scripting):

```bash
prove_it init --git-hooks --default-checks
```

| Flag | Default | Effect |
|------|---------|--------|
| `--[no-]git-hooks` | on | Install git pre-commit/pre-push hooks |
| `--[no-]default-checks` | on | Include AI coverage review, pre-ship review |
| `--[no-]automatic-git-hook-merge` | off | Merge with existing git hooks (fails if hooks exist) |
| `--[no-]overwrite` |—| Overwrite customized config with current defaults |

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

### Recording runs

`prove_it record` options:
- `--result <N>`—record pass (N=0) or fail (N!=0), exit with code N (best for traps)
- `--pass` / `--fail`—record explicitly (exit 0 / exit 1)
- `--name <task>`—must match the task name in your config

## Configuration

prove_it is configured with a `hooks` array in `.claude/prove_it/config.json`. Each hook targets a lifecycle event and runs an ordered list of tasks:

```json
{
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

1. `~/.claude/prove_it/config.json`—global defaults
2. `.claude/prove_it/config.json`—project config (commit this)
3. `.claude/prove_it/config.local.json`—local overrides (gitignored, per-developer)

### Lifecycle events

**Claude events:**

| Event | Purpose | Behavior |
|-------|---------|----------|
| `SessionStart` | Environment setup, injecting context | **Non-blocking.** All tasks run. Output is injected into Claude's context. Use this to inject prompts, announce project state, set environment variables, or run setup scripts. |
| `PreToolUse` | Guarding tool usage | **Blocking, fail-fast.** Tasks run in order; the first failure denies the tool and stops. Use this for config protection, enforcing workflows, or vetting commands. |
| `Stop` | Verifying completed work | **Blocking, fail-fast.** Tasks run in order; the first failure sends Claude back to fix it. Put cheap tasks first (test suite), expensive ones last (AI reviewer). Async results are harvested before sync tasks run. |

**Git events:**

| Event | Purpose | Behavior |
|-------|---------|----------|
| `pre-commit` | Validating before commit | **Blocking, fail-fast.** Runs only under Claude Code (`CLAUDECODE` env var)—human commits pass through instantly. |
| `pre-push` | Validating before push | **Blocking, fail-fast.** Same as pre-commit but triggers on push. |

### Task types

- **`script`**—runs a shell command, fails on non-zero exit
- **`agent`**—sends a prompt to an AI reviewer, expects PASS/FAIL response (see [Agent tasks](#agent-tasks))
- **`env`**—runs a command that outputs environment variables, injected into Claude's session (SessionStart only, see [Env tasks](#env-tasks))

### Disabling individual tasks

Set `enabled: false` on a task to skip it without removing it from config:

```json
{ "name": "slow-review", "type": "agent", "prompt": "prove-coverage",
  "promptType": "skill", "enabled": false }
```

Disabled tasks are logged as SKIP with reason "Disabled".

### Quiet tasks

Set `quiet: true` on a task to suppress all log output except failures:

```json
{ "name": "lock-config", "type": "script", "command": "prove_it run_builtin config:lock", "quiet": true }
```

Quiet tasks don't emit SKIP or PASS entries to the session log. FAIL and CRASH entries are always logged. This is useful for high-frequency guards (like `config:lock` on every PreToolUse) that would otherwise flood the monitor.

### Task timeout

Set `timeout` (in milliseconds) to override the default execution timeout:

```json
{ "name": "slow-tests", "type": "script", "command": "./script/test", "timeout": 300000 }
```

Defaults: 60s for script tasks, 120s for agent tasks, 30s for env tasks.

### Run caching (`mtime`)

Script tasks cache their results by default. When `mtime: true` (the default for script tasks), prove_it checks whether source files have been modified since the last successful run. If nothing changed, the task is skipped with a "cached pass" reason.

Set `mtime: false` to disable caching and force the task to run every time:

```json
{ "name": "always-run", "type": "script", "command": "./script/check", "mtime": false }
```

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

`matcher` filters by Claude's tool name (`Edit`, `Write`, `Bash`, etc.). `triggers` are regex patterns matched against the tool's command argument. Both are optional—omit them to run on every PreToolUse.

## Conditional tasks (`when`)

Tasks can declare conditions that must be met before they run. This is how you gate expensive reviews on churn thresholds, signal states, or environmental requirements.

```json
{ "name": "my-check", "type": "script", "command": "./script/check",
  "when": { "fileExists": ".config" } }
```

### Condition evaluation

**Object form — AND.** When `when` is an object, every condition must pass:

```json
{ "when": { "envSet": "CLAUDECODE", "linesChanged": 500 } }
```

Both `envSet` AND `linesChanged` must be true. If either fails, the task is skipped.

**Array form — OR of ANDs.** When `when` is an array, each element is AND'd internally and any element passing fires the task:

```json
{
  "name": "coverage-review",
  "type": "agent",
  "prompt": "prove-coverage",
  "promptType": "skill",
  "when": [
    { "envSet": "CLAUDECODE", "linesChanged": 500 },
    { "envSet": "CLAUDECODE", "linesWritten": 1000 }
  ]
}
```

The env var must be set in both clauses, but either churn threshold firing is enough to run the review. This is the MongoDB/CSS-selector pattern.

### Condition reference

| Condition | Type | Description |
|-----------|------|-------------|
| `fileExists` | string | Passes when file exists relative to project root |
| `envSet` | string | Passes when environment variable is set |
| `envNotSet` | string | Passes when environment variable is not set |
| `variablesPresent` | string[] | Passes when all listed template variables resolve to non-empty values |
| `signal` | string | Passes when the named signal (`done`, `stuck`, `idle`) is active for the current session |
| `linesChanged` | number | Passes when at least N source lines have changed (additions + deletions) since the task last ran. Git-based—works in both Claude hooks and git hooks. |
| `linesWritten` | number | Passes when at least N gross lines have been written by the agent since the task last ran. Catches thrashing. Claude Code sessions only. |
| `sourcesModifiedSinceLastRun` | boolean | Passes when source file mtimes are newer than the last run |
| `sourceFilesEdited` | boolean | Passes when source files were edited this turn (session-scoped, tool-agnostic) |
| `toolsUsed` | string[] | Passes when any of the listed tools were used this turn |

### Git-based churn tracking (`linesChanged`)

Each task using `linesChanged` stores a git ref at `refs/worktree/prove_it/<task-name>`. When the condition is evaluated, prove_it diffs the ref against the **working tree** (not just HEAD), filtered to your configured `sources` globs, summing additions and deletions. This means committed, staged, unstaged, and newly-created file changes all count—so Write/Edit tool calls trigger churn immediately without needing a commit. On first run the ref is created at HEAD (bootstrap—returns 0 if the working tree is clean). This is session-independent and worktree-safe. Refs are cleaned up by `prove_it deinit`.

When a task passes or resets, the ref advances to a snapshot of the current working tree state (including untracked source files). This ensures all pending changes are captured—advancing to HEAD alone would be a no-op when churn comes from uncommitted Write/Edit operations.

**`resetOnFail` behavior**: When a task fails, the ref advancement depends on the hook event:
- **PreToolUse** (default `resetOnFail: true`): The ref advances on failure. Without this, the task deadlocks—it blocks every Write/Edit, including writes to test files that would fix the issue.
- **Stop / git hooks** (default `resetOnFail: false`): The ref does NOT advance. The agent gets sent back to fix the issue, and the same accumulated churn keeps triggering the review.
- You can override the default with an explicit `resetOnFail: true` or `resetOnFail: false` on the task.

### Gross churn tracking (`linesWritten`)

While `linesChanged` measures **net** drift (git diff: what changed on disk), `linesWritten` measures **gross** activity (total lines the agent has written). This catches a different failure mode: thrashing. An agent that writes 500 lines, deletes them, rewrites them differently, and deletes again has written 2000 gross lines but may show 0 net churn. The gross counter catches this.

Gross churn accumulates on every successful PreToolUse for Write/Edit/NotebookEdit to source files. Lines are counted from the tool input (no file I/O needed). The counter is stored as a git blob under `refs/worktree/prove_it/__gross_lines`, with per-task snapshots under `<task>.__gross_lines`. Increment uses compare-and-swap for multi-agent safety—concurrent agents can't lose each other's counts.

`resetOnFail` follows the same rules as `linesChanged`.

### Session-scoped conditions

`sourceFilesEdited` and `toolsUsed` are **session-scoped**: they track which tools and files each Claude Code session uses, per-turn. After a successful Stop, the tracking resets so the next Stop only fires if new edits occur.

These conditions solve cross-session bleed—unlike `sourcesModifiedSinceLastRun` (which uses global file timestamps), session-scoped conditions ensure Session A's edits don't trigger Session B's reviewers.

**`sourceFilesEdited: true`**—gates a task on source file edits in the current turn:

```json
{
  "name": "my-review",
  "type": "agent",
  "prompt": "Review the changes...",
  "when": { "sourceFilesEdited": true }
}
```

**`toolsUsed: ["XcodeEdit", "Edit"]`**—gates a task on specific tools being used:

```json
{
  "name": "xcode-review",
  "type": "agent",
  "prompt": "Review Xcode changes...",
  "when": { "toolsUsed": ["XcodeEdit"] }
}
```

### Signals

Signals let the agent declare where it is in a work cycle. The agent runs `prove_it signal done` (or `stuck`, `idle`) and tasks gated with `when: { signal: "done" }` fire on the next Stop. This is useful for heavyweight checks you only want at the end of a coherent unit of work rather than every Stop.

PreToolUse intercepts the `prove_it signal` command automatically—no extra config needed.

**Clear-on-pass / preserve-on-fail**: After a successful Stop (all tasks pass), the active signal is cleared automatically. After a failed Stop, the signal is preserved so the gated tasks re-fire until they pass. This means you signal once, and the heavy checks keep running until everything is clean.

```json
{
  "name": "full-tests",
  "type": "script",
  "command": "./script/test",
  "when": { "signal": "done" }
}
```

Signal commands:

```
prove_it signal done                         Declare coherent work complete
prove_it signal stuck                        Declare stuck / cycling
prove_it signal idle                         Declare idle / between tasks
prove_it signal done -m "Ready for review"   Include a message
prove_it signal clear                        Clear the active signal
```

## Agent tasks

Agent tasks spawn a separate AI process to review Claude's work with an independent PASS/FAIL verdict. This is useful because the reviewing agent has no stake in the code it's judging.

By default, agent tasks use `claude -p` (Claude Code in pipe mode). The reviewer receives a wrapped prompt and must respond with `PASS`, `FAIL`, or `SKIP`.

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
| `{{root_dir}}` | Git root directory (may differ from project_dir in monorepos) |
| `{{session_id}}` | Current Claude Code session ID |
| `{{git_head}}` | Current HEAD commit SHA |
| `{{git_status}}` | `git status --short` (staged/modified/untracked files) |
| `{{recent_commits}}` | `git log --oneline --stat -5` (last 5 commits with file stats) |
| `{{recently_edited_files}}` | Source files changed since last commit (sorted by recency) |
| `{{sources}}` | Configured source globs (one per line) |
| `{{signal_message}}` | Message from the active signal (e.g., from `prove_it signal done -m "message"`) |
| `{{changes_since_last_review}}` | `git diff --stat` since this task's ref was last advanced (shows what changed since the reviewer last passed) |

Conditional blocks are supported: `{{#var}}content{{/var}}` renders only when the variable is non-empty.

### Skill-based prompts

prove_it ships curated reviewer prompts as Claude Code [skills](https://code.claude.com/docs/en/skills). Reference them in your config with `promptType: "skill"`:

```json
{ "type": "agent", "promptType": "skill", "prompt": "prove-coverage" }
```

| Skill | What it reviews |
|-------|----------------|
| `prove-coverage` | Session diffs for test coverage adequacy |
| `prove-shipworthy` | Thorough pre-ship review: correctness, integration, security, tests, omissions. Uses `{{changes_since_last_review}}` for scope. Designed for Opus. |

Skills are installed to `~/.claude/skills/<name>/SKILL.md` by `prove_it install`. The prompt body is the skill file with its YAML frontmatter stripped.

### Rule files

Agent tasks accept a `ruleFile` field that injects the contents of a project-specific rule file into the reviewer prompt. This lets you define testing standards once and apply them to every reviewer:

```json
{
  "name": "coverage-review",
  "type": "agent",
  "prompt": "prove-coverage",
  "promptType": "skill",
  "ruleFile": ".claude/rules/testing.md"
}
```

The path is resolved relative to the project directory. If the file is missing, the task fails with a clear error—this is intentional so you don't silently run reviews without your rules.

`prove_it init` generates a default `.claude/rules/testing.md` with starter rules and a TODO for you to customize. The default agent tasks (`coverage-review`, `shipworthy-review`) both point to this file.

### Model selection

Agent tasks accept a `model` field to control which model the reviewer uses:

```json
{ "name": "coverage-review", "type": "agent",
  "prompt": "Check test coverage...\n\n{{session_diff}}", "model": "haiku" }
```

For OpenAI/codex models (names starting with `gpt-`), prove_it auto-switches to `codex exec -`:

```json
{ "name": "adversarial-review", "type": "agent",
  "prompt": "Review this code for bugs...\n\n{{staged_diff}}", "model": "gpt-5.3-codex" }
```

When no `model` is set and no custom `command` is provided, prove_it applies defaults:

| Event | Default model | Rationale |
|-------|--------------|-----------|
| PreToolUse | `haiku` | Latency-sensitive gate check |
| Stop | `haiku` | Latency-sensitive review |
| pre-commit | `sonnet` | Thoroughness matters more |
| pre-push | `sonnet` | Thoroughness matters more |

You can also set a top-level `model` in config to apply a default across all agent tasks. An explicit `model` on a task always wins. Setting a custom `command` disables default model selection entirely.

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

### Async reviews

Set `async: true` on an agent task to run it in the background:

```json
{
  "name": "coverage-review",
  "type": "agent",
  "async": true,
  "promptType": "skill",
  "prompt": "prove-coverage",
  "model": "haiku",
  "when": { "linesChanged": 541 }
}
```

Async tasks spawn a detached child process and return immediately, so they don't block Claude from continuing work. The lifecycle is:

1. **Spawn**—prove_it forks a worker and lets the Stop pass
2. **Run**—the worker runs the reviewer in the background (RUNNING → PASS/FAIL/SKIP)
3. **Done**—the worker writes its result and logs DONE
4. **Harvest**—on the next Stop, prove_it reads all pending results *before* running sync tasks
5. **Enforce**—results are settled: ENFORCED:PASS lets the stop continue, a FAIL blocks just like a sync failure

This means an async FAIL blocks Claude on the *next* stop, not the current one. The default config uses `async: true` for the coverage reviewer.

`async` has no effect on SessionStart (which never blocks). PreToolUse tasks can technically be async, but the usefulness is limited since they run on every tool call.

### Review backchannel

When an agent reviewer FAILs, prove_it creates a backchannel directory where Claude can appeal the decision:

```
.claude/prove_it/sessions/<session-id>/backchannel/<task-name>/README.md
```

The README is pre-populated with the failure reason and instructions. Claude can write a response explaining why the failure doesn't apply (planning work, code isn't theirs, changes are unrelated). On the next review cycle, the reviewer reads the backchannel content before rendering its verdict.

When a reviewer PASSes or SKIPs, the backchannel is cleaned up automatically.

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

Multiple env tasks merge in order—later tasks override earlier ones for the same key. If the command fails or output can't be parsed, the error is reported and execution continues.

## Builtins

prove_it ships with built-in runnable tasks:

| Builtin | Type | What it does |
|---------|------|-------------|
| `config:lock` | script | Blocks direct edits to prove_it config files. Invoke via `prove_it run_builtin config:lock`. |
| `session:briefing` | script | Renders a session orientation on SessionStart: active tasks, signal instructions, review process overview. Invoke via `prove_it run_builtin session:briefing`. |

Script builtins are configured as `type: "script"` tasks with `command: "prove_it run_builtin <name>"`. Reviewer prompts are distributed as skills (see [Skill-based prompts](#skill-based-prompts)).

## Session briefing

On every SessionStart, the `session:briefing` builtin renders an orientation that's injected into Claude's context. It shows:

- **Active tasks by event**—what runs on Stop, PreToolUse, git commit, etc.
- **Signal instructions**—if any tasks are gated on signals, Claude gets explicit instructions to run `prove_it signal done` when a unit of work is complete
- **Review process**—how FAIL verdicts work, how to use the backchannel to appeal, and that a supervisory process audits appeals

The briefing is generated from your effective config, so it always reflects your actual setup. It filters out the briefing task itself to avoid recursion. If rendering fails, the session continues (briefing failure never blocks).

## Monitoring

### `prove_it monitor`

Run in a separate terminal to watch hook results in real time:

```
prove_it monitor
Session: ea0da8e4 | /Users/justin/code/searls/sugoi_tv | started 02/13/2026, 08:53

09:00:48  CRASH  coverage-review       Unexpected reviewer output: Based on my investigation…
09:00:52  PASS   fast-tests            ./script/test_fast passed (2.3s)
09:01:12  SKIP   fast-tests            cached pass (no code changes)
09:14:33  PASS   commit-review         All changes look correct and well-tested.

watching for new entries… (ctrl-c to stop)
```

```
prove_it monitor             # tail most recent session
prove_it monitor --all       # tail all sessions and project logs
prove_it monitor <id>        # tail a specific session (prefix match OK)
```

### Flags

| Flag | Effect |
|------|--------|
| `--project` | Scope to current project directory. Finds all sessions and project logs for this repo. |
| `--project=/path/to/repo` | Scope to a specific project directory |
| `--verbose` | Show full reviewer prompts, responses, and script output in box-drawn blocks |
| `--sessions` | Show session ID prefix on each line (useful with `--all`) |
| `--status=FAIL,CRASH` | Filter to specific status codes (comma-separated) |
| `--list` | List all sessions with summary info instead of tailing |

### Status of each task

| Code | Meaning |
|------|---------|
| `PASS` | Task passed |
| `FAIL` | Task failed (blocks the action) |
| `SKIP` | Task skipped (condition not met, disabled, cached, or reviewer said SKIP) |
| `CRASH` | Task crashed (unexpected error—treated as a soft skip unless model is explicitly set) |
| `EXEC` | Task is executing |
| `DONE` | Async review complete, waiting for Stop hook to enforce |
| `ENFORCED:PASS` | Async result was harvested and settled as pass |
| `ENFORCED:SKIP` | Async result was harvested and settled as skip |
| `APPEAL` | Developer wrote a backchannel appeal before this review cycle |
| `SET` | Signal was set (`prove_it signal done/stuck/idle`) |
| `CLEAR` | Signal was cleared (`prove_it signal clear` or auto-clear after successful Stop) |

## Skills (`/prove`)

prove_it installs a Claude Code [skill](https://code.claude.com/docs/en/skills)
called `/prove`—evidence-based verification that forces Claude to actually
run the thing and show you the results.

Invoke it with `/prove <claim>` (e.g., `/prove the search API handles
pagination`). If you just type `/prove` with uncommitted changes, it'll prove
those changes work. Claude will:

1. **State what it's trying to prove** and what "working" looks like
2. **Show evidence it works**—commands, output, artifacts
3. **Show evidence it might not work**—edge cases, error paths, things it tried to break
4. **Give its honest judgment**—ready to ship, or what needs to change

The skill is installed to `~/.claude/skills/prove/SKILL.md` and updated on
every `prove_it install`.

## Subprocess environment (`taskEnv`)

When prove_it spawns reviewer subagents or runs script tasks, other hooks installed in your environment (like [turbocommit](https://github.com/Siege/turbocommit)) may fire inside those subprocesses. Use the top-level `taskEnv` field to set environment variables across all prove_it subprocesses:

```json
{
  "taskEnv": {
    "TURBOCOMMIT_DISABLED": "1"
  },
  "hooks": [...]
}
```

These variables are merged into the environment of both script tasks and agent reviewer subprocesses. prove_it forces `PROVE_IT_DISABLED` and `PROVE_IT_SKIP_NOTIFY` in all subprocesses to prevent recursion—these cannot be overridden by `taskEnv`. Reviewer subprocesses additionally force `CLAUDECODE` and `LC_ALL`.

**Merge order** (last wins):
1. `process.env`—inherited base environment
2. `taskEnv`—your config values
3. prove_it forced vars—recursion prevention, always win

## Tracking MCP editing tools (`fileEditingTools`)

By default, prove_it tracks Claude's built-in editing tools (`Edit`, `Write`, `NotebookEdit`). If Claude edits files through MCP tools (e.g. Xcode MCP's `XcodeEdit`), add them to `fileEditingTools` so prove_it can track them:

```json
{
  "fileEditingTools": ["XcodeEdit"],
  "sources": ["**/*.swift", "**/*.m"],
  "hooks": [...]
}
```

Tools listed in `fileEditingTools` are tracked alongside the builtins—they participate in `sourceFilesEdited`, `toolsUsed`, gross churn (`linesWritten`), and the `session_diff` git fallback. For gross churn, line counts are estimated from the longest string value in the tool input.

## Session management

prove_it stores session data in `~/.claude/prove_it/sessions/`—log files (`.jsonl`), state files (`.json`), and async task directories.

**Lazy cleanup**: On every fresh session start (`startup` source), prove_it prunes session files older than 7 days. Pruning is rate-limited to once per 24 hours (tracked via a `.last_prune` marker file), so it adds no overhead to normal operation.

**`format.maxOutputChars`**: Controls the maximum character count for output passed back to Claude Code hooks. Defaults to 12000. Increase if you need longer test output or decrease to save context:

```json
{
  "format": { "maxOutputChars": 20000 },
  "hooks": [...]
}
```

## Commands

```
prove_it install        Register global hooks (~/.claude/settings.json)
prove_it uninstall      Remove global hooks
prove_it reinstall      Uninstall and reinstall global hooks
prove_it init           Set up current project (interactive or with flags)
prove_it deinit         Remove prove_it from current project
prove_it reinit         Deinit and re-init current repository
prove_it doctor         Check installation and show effective config
prove_it monitor        Tail hook results in real time
prove_it signal <type>  Declare a lifecycle signal (done, stuck, idle, clear)
prove_it hook <spec>    Run a dispatcher directly (claude:Stop, git:pre-commit)
prove_it run_builtin <name> Run a builtin check directly
prove_it record         Record a test run result (--name <task> --pass|--fail|--result <N>)
prove_it help           Show help
prove_it --version      Show version
```

## Disabling prove_it

prove_it defaults to `enabled: false`—it only runs when explicitly opted in via
`prove_it install` (global) or `prove_it init` (project). Both write `enabled: true`
to their respective config files.

When you need to disable it after installation:

### Ignore specific directories

Edit `~/.claude/prove_it/config.json`:

```json
{
  "ignoredPaths": ["~/bin", "~/dotfiles"]
}
```

### Disable for a project

For all contributors—edit `.claude/prove_it/config.json`:
```json
{ "enabled": false }
```

For just you—edit `.claude/prove_it/config.local.json`:
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

- **Hooks not firing**—Restart Claude Code after `prove_it install`
- **Tests not running**—Check `./script/test` exists and is executable (`chmod +x`)
- **Hooks running in wrong directories**—prove_it only activates in git repos
- **Reviews never fire**—The default `when` conditions use churn thresholds (`linesChanged`, `linesWritten`). Reviews only trigger after enough code has been written. Check `prove_it monitor` to see skip reasons with current/threshold counts. If you use MCP tools that edit files (e.g. Xcode MCP's `XcodeEdit`), add them to `fileEditingTools` so all churn tracking works for those tools:
  ```json
  {
    "fileEditingTools": ["XcodeEdit"],
    "hooks": [...]
  }
  ```
- **Async reviews not enforcing**—Async results are harvested on the next Stop. If Claude stops work before the async review completes, the result will be enforced on the stop after that. Check `prove_it monitor --verbose` to see RUNNING/DONE status progression.
- **Config errors after upgrade**—Run `prove_it reinstall && prove_it reinit` to reset to current defaults

## Examples

See [`example/basic/`](example/basic/) and [`example/advanced/`](example/advanced/) for working projects with configs, test suites, and reviewer prompts.

## Requirements

- Node.js >= 18
- Claude Code with hooks support

## License

MIT
