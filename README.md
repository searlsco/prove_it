# prove_it: methodology/workflow enforcement for coding agents

🔥 **Comin' in Hot! Shipping multiple unstable releases per day at the moment. If you want prove_it to actually work, [email Justin](mailto:justin@searls.co) for updates** 🛬🔥

**If you experience errors after an upgrade, reset your setup with `prove_it reinstall && prove_it reinit`.**

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

Out-of-the-box, coding agents happily declare work complete before they have proven it: tests may not have run, coverage may be missing, and verification may be hand-wavy.

**prove_it** is a methodology/workflow engine for making agents prove their work. The Clean Runtime stores workflow intent in strict `.prove_it/config.json`; that Project Config is the source of truth for Workflow Engine behavior.

Claude Code and Pi are Harnesses. The Claude Adapter and Pi Adapter translate harness-native events into Workflow Engine stages, then render Workflow Engine Effects back to each harness. Adapter mechanics differ by harness capability, but product behavior is described in terms of Methodology, Signals, Tasks, Pipelines, Completion Verification, and Evidence. See [Adapter capabilities](docs/adapters.md) for the current capability matrix.

## Quick start

Claude Code project with Claude parity behavior:

```bash
brew install searlsco/tap/prove_it
cd your-project
prove_it init --adapter claude
prove_it doctor
```

`prove_it init --adapter claude` writes:

- strict `.prove_it/config.json` with `profile: "claude"` — the Workflow Engine source of truth;
- `.prove_it/ownership.json` — prove_it's ownership manifest for generated artifacts;
- Claude-native `.claude/settings.json` hook registrations that call `prove_it hook claude:*`.

`.claude/settings.json` activates the Claude Adapter. It is not workflow config.

Pi project:

```bash
brew install searlsco/tap/prove_it
cd your-project
prove_it init --adapter pi
pi install -l npm:@davemo/pi-prove-it
prove_it doctor
prove_it explain
```

`prove_it init --adapter pi` writes strict `.prove_it/config.json` with `profile: "strict"` and Pi package activation artifacts.

Multi-adapter project:

```bash
prove_it init --adapter pi --adapter claude
pi install -l npm:@davemo/pi-prove-it
prove_it doctor
```

Multi-adapter init currently keeps `profile: "strict"` so Pi does not inherit Claude-only default mechanics. Restart the relevant Harness after installing adapter-native hooks or packages.

## What can prove_it do?

prove_it is a config-driven methodology/workflow engine for enforcing quality in coding-agent sessions. In the Clean Runtime, shared workflow config lives under `.prove_it/`; adapter-native files activate Pi or Claude according to each adapter's implemented capabilities.

Depending on adapter support, prove_it can:

- **Inject Session Start guidance** — brief the Primary Agent on methodology context, configured tasks, Signal instructions, and review/backchannel process.
- **Protect Workflow Engine config** — hard-block Primary Agent edits to `.prove_it/config.json` and `.prove_it/config.local.json` unless the workflow explicitly allows them.
- **Guide test-first work** — nudge the Primary Agent toward red-green TDD and assumption verification before implementation.
- **Gate tasks on Signals** — run heavyweight Tasks only when the Primary Agent sets a `done`, `stuck`, or `idle` Signal.
- **Run fast/full tests** — run `./script/test_fast` on Completion Verification and `./script/test` when a Done Signal and source edits make the full suite relevant.
- **Run Reviewer Tasks** — run Done, Stuck/Approach, coverage, and testing-pattern reviewers as configured Tasks, with async/parallel execution where supported.
- **Support reviewer appeals** — create a Claude backchannel for FAIL verdict appeals, then feed the appeal back into the next review cycle.
- **Track phases and plans** — support `prove_it phase ...`, phase-aware TDD guidance, and automatic Done/phase instructions in plan files where the Claude Harness exposes the required mechanics.
- **Auto-signal TaskCompleted work** — for Claude TaskCompleted events whose subject matches Done-signal guidance, set the Done Signal automatically when Done-gated Tasks exist.
- **Provide session control** — `prove_it disable`, `prove_it enable`, and `prove_it cancel` control the current session without changing Project Config.
- **Block git commits** — run Git Workflows such as `pre_commit` before commits when configured.
- **Track evidence** — record script output, reviewer verdicts, Signal lifecycle, and task state so future checks can decide what still needs proof.

`prove_it init --adapter claude` selects the Claude parity profile. The Workflow Engine still reads `.prove_it/config.json`; the Claude Adapter owns the Claude hook API mechanics, including `.claude/settings.json`, `CLAUDE_ENV_FILE`, Claude-specific hook JSON, Claude Stop hard blocks, and Claude backchannel paths.

`prove_it init --adapter pi` selects the strict profile. Pi is first-class, but its Capability Profile differs: Pi can hard-block pre-tool config edits and expose model-callable Signals, while failed Completion Verification is delivered as a remediation follow-up after `turn_end` instead of a Claude Stop hard block.

## Setup

### Install

```bash
# Install the CLI
brew install searlsco/tap/prove_it

# Optional: install Claude skills and global Claude hook registration
prove_it install
```

### Initialize a project

Initialize strict `.prove_it` Project Config with explicit adapters:

```bash
cd your-project
prove_it init --adapter claude
prove_it init --adapter pi
prove_it init --adapter pi --adapter claude
```

The adapter flag determines the profile and adapter artifacts:

| Command | Project Config | Adapter artifacts |
|---|---|---|
| `prove_it init --adapter claude` | `.prove_it/config.json` with `profile: "claude"` | `.claude/settings.json` hook registrations for `prove_it hook claude:*` |
| `prove_it init --adapter pi` | `.prove_it/config.json` with `profile: "strict"` | Pi package activation artifacts; install `@davemo/pi-prove-it` in Pi |
| `prove_it init --adapter pi --adapter claude` | `.prove_it/config.json` with `profile: "strict"` | both adapter activations |

`.prove_it/config.json` is the strict source of truth for Workflow Engine config. `.claude/settings.json` is a Claude Adapter Artifact: it activates Claude hooks and contains hook commands, not workflow policy.

The Claude hard break is intentional. Normal `prove_it hook claude:<Event>` dispatch reads strict `.prove_it/config.json` and clean Session State. It ignores stale `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json` as workflow config. There is no `.claude/prove_it` → `.prove_it` migration command and no supported dual-runtime compatibility mode; move retained workflow intent manually into strict `.prove_it` config.

`prove_it doctor` surfaces stale `.claude/prove_it` config files as ignored after the hard break.

### Non-interactive init

Pass flags to skip prompts (useful for CI or scripting):

```bash
prove_it init --git-hooks --default-checks
prove_it init --adapter pi
prove_it init --adapter pi --adapter claude
```

| Flag | Default | Effect |
|------|---------|--------|
| `--[no-]git-hooks` | on | Configure prove_it-owned Git 2.54 config hooks for active Git workflows |
| `--[no-]default-checks` | on | Include AI coverage review, pre-ship review |
| `--[no-]automatic-git-hook-merge` | off | Legacy `.git/hooks/*` mode only; strict adapter init does not write or merge hook shim files |
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
trap 'rc=$?; command -v prove_it >/dev/null 2>&1 && prove_it record --name fast-tests --result $rc' EXIT
rake test
```

And your full `script/test` command will probably run that and more:

```bash
#!/usr/bin/env bash
set -e
trap 'rc=$?; command -v prove_it >/dev/null 2>&1 && prove_it record --name full-tests --result $rc' EXIT
rake test standard:fix test:system
```

The `trap ... EXIT` pattern ensures results are always recorded, even when `set -e` causes early exit. prove_it uses this to skip re-running tests when code hasn't changed.

### Recording runs

`prove_it record` options:
- `--result <N>`—record pass (N=0) or fail (N!=0), exit with code N (best for traps)
- `--pass` / `--fail`—record explicitly (exit 0 / exit 1)
- `--name <task>`—must match the task name in your config

## Configuration

Clean-runtime prove_it is configured in strict `.prove_it/config.json`; inspect its effective merged form with `prove_it explain`.

The public config shape is workflow-first:

```json
{
  "schema_version": 1,
  "profile_version": "prove_it.strict.v1",
  "profile": "claude",
  "globs": {
    "source": ["src/**/*.js", "test/**/*.js"],
    "test": ["test/**/*.test.js"]
  },
  "tasks": {
    "protect_prove_it_config": {
      "type": "config_guard",
      "protected_paths": [".prove_it/config.json", ".prove_it/config.local.json"]
    },
    "fast_tests": {
      "type": "script",
      "command": "./script/test_fast",
      "when": { "sourcesModifiedSinceLastRun": true, "sourceFilesEdited": true }
    },
    "full_tests": {
      "type": "script",
      "command": "./script/test",
      "when": { "signal": "done", "sourceFilesEdited": true }
    }
  },
  "agent_workflows": {
    "session_start": [],
    "pre_tool": ["protect_prove_it_config"],
    "post_tool": [],
    "post_tool_failure": [],
    "agent_end": ["fast_tests", "full_tests"]
  },
  "git_workflows": {
    "pre_commit": [],
    "pre_push": []
  },
  "adapters": {
    "claude": { "enabled": true },
    "pi": { "enabled": false }
  }
}
```

Key ideas:

- `tasks` define named units of work.
- `agent_workflows` and `git_workflows` define Pipelines for normalized Workflow Stages.
- `adapters` declares which Adapters are active; it does not make adapter-native files into workflow config.
- `profile: "claude"` selects retained Claude parity defaults. `profile: "strict"` selects the smaller harness-neutral strict defaults.
- `profile_version` pins built-in profile semantics independently from `schema_version`.

### Config layers

Strict config layers merge in this order:

1. built-in Profile (`strict` or `claude`);
2. optional global `.prove_it` config layer when present;
3. project `.prove_it/config.json` (commit this);
4. developer-local `.prove_it/config.local.json` (gitignored).

After the Claude hard break, `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json` are retired Claude Legacy Config. They are ignored by normal Claude hook dispatch and by normal Git hook dispatch as workflow config, and `prove_it doctor` reports them as stale if they are present. Legacy Claude characterization paths remain quarantined behind a test-only oracle guard and are not user-facing runtime behavior.

### Source and test globs

`globs.source` defines which files prove_it considers "your code" — these globs drive conditions like `sourcesModifiedSinceLastRun`, `sourceFilesEdited`, and `linesChanged`. Test files should be included in `globs.source` so that edits to tests are tracked as source changes.

`globs.test` identifies which source files are test files. This drives the `test_first` guidance in the Claude parity profile, which tracks whether Claude writes and runs failing tests before implementing source code. See [Session phases](#session-phases) for how enforcement varies by activity. `globs.test` is typically a subset of `globs.source` — it doesn't need to be disjoint.

### Lifecycle events

**Claude events:**

| Event | Purpose | Behavior |
|-------|---------|----------|
| `SessionStart` | Injecting context | **Non-blocking.** Clean Runtime context is rendered into Claude's session. Use this to announce methodology, configured Tasks, Signals, and review/backchannel process. Strict config does not currently support legacy `env` tasks. |
| `PreToolUse` | Guarding tool usage | **Blocking, fail-fast.** Tasks run in order; the first failure denies the tool and stops. Use this for config protection, enforcing workflows, or vetting commands. |
| `Stop` | Verifying completed work | **Blocking, fail-fast.** Tasks run in order; the first failure sends Claude back to fix it. Put cheap tasks first (test suite), expensive ones last (AI reviewer). Async results are harvested before sync tasks run. |
| `PostToolUse` | Observing tool results | **Non-blocking.** Fires after a tool succeeds. Used by TDD enforcement to detect test passes. Matcher filters by tool name. |
| `PostToolUseFailure` | Observing tool failures | **Non-blocking.** Fires after a tool fails. Used by TDD enforcement to detect test failures. Matcher filters by tool name. |

**Git events:**

| Event | Purpose | Behavior |
|-------|---------|----------|
| `pre-commit` | Validating before commit | **Blocking, fail-fast.** Runs `git_workflows.pre_commit` from strict `.prove_it/config.json` through the Clean Runtime. Runs only under Claude Code (`CLAUDECODE` env var)—human commits pass through instantly. |
| `pre-push` | Validating before push | **Blocking, fail-fast.** Runs `git_workflows.pre_push` from strict `.prove_it/config.json` through the Clean Runtime. Same Claude Code guard as pre-commit. |

### Git hook activation

Strict adapter init uses Git 2.54+ config-based hooks instead of writing `.git/hooks/pre-commit` or `.git/hooks/pre-push` shim files. For an active strict Git workflow, `prove_it init --adapter claude` writes local repository config like:

```ini
[hook "prove-it-pre-commit"]
  command = prove_it hook git:pre-commit
  event = pre-commit
  enabled = true
```

The workflow policy remains in `.prove_it/config.json` under `git_workflows`; the Git config entry only activates the dispatcher. `prove_it deinit` removes only the prove_it-owned `hook.prove-it-*` Git config entries and leaves unrelated hook config alone. `prove_it doctor` reports whether configured strict Git workflows have active Git config hooks and warns when Git 2.54 config hooks are unavailable. This slice intentionally has no legacy `.git/hooks/*` fallback for strict Git workflows.

### Task types

Strict Clean Runtime task types are:

- **`config_guard`** — blocks edits to protected Project Config / Local Config paths before the tool runs.
- **`script`** — runs a shell command through the active task provider; a non-zero exit fails the task.
- **`reviewer`** — asks an active-harness reviewer provider for an independent `PASS`, `FAIL`, or `SKIP` verdict. Use this for Claude parity reviewer tasks.
- **`agent`** — legacy-compatible reviewer shape accepted by the strict schema for simple prompt/model reviewer tasks. Prefer `reviewer` for new config because it exposes provider selection and provider options.

Strict task objects are named by their key under `tasks`; they do not include a `name` field:

```json
{
  "tasks": {
    "fast_tests": {
      "type": "script",
      "command": "./script/test_fast",
      "timeout_ms": 300000
    },
    "protect_prove_it_config": {
      "type": "config_guard",
      "protected_paths": [".prove_it/config.json", ".prove_it/config.local.json"]
    }
  },
  "agent_workflows": {
    "pre_tool": ["protect_prove_it_config"],
    "agent_end": ["fast_tests"]
  }
}
```

Task fields currently accepted by strict config are intentionally narrow:

- common: `type`, `description`, `matcher`, `triggers`, `when`, `async`, `parallel`, `failure_behavior`, `appeal`, `output`;
- `config_guard`: `protected_paths`;
- `script`: `command`, `params`, `env`, `timeout_ms`;
- `reviewer`: `intent`, `prompt`, `model`, `provider`, `provider_options`, `timeout_ms`;
- `agent`: `prompt`, `model`.

Strict `script` task execution options are clean Workflow Engine capabilities:

- `params` must be a JSON object and is passed to the script task on stdin as `input.params`.
- `env` must be an object whose values are strings and is applied only to that task's process.
- `timeout_ms` is the strict timeout field; legacy `timeout` is not accepted.

### Task output policy

Tasks default to current routine output behavior. High-frequency tasks can opt into a core output policy:

```json
{
  "tasks": {
    "test_first": {
      "type": "script",
      "command": "$(prove_it prefix)/libexec/test-first",
      "output": "failures_only"
    }
  }
}
```

Accepted values are:

- `"default"` — preserve routine pass/skip/log output behavior.
- `"failures_only"` — suppress routine pass output, skipped-task context, and routine task logs while keeping failures, crashes, remediation, completion verification blocks, and backchannel instructions visible.

The policy is Workflow Engine behavior and applies across adapters that render engine effects, including Claude, Git, and Pi runtime paths.

Legacy Claude Runtime fields such as `quiet`, `briefing`, `enabled`, `promptType`, `ruleFile`, `taskEnv`, `taskAllowedTools`, `taskBypassPermissions`, `fileEditingTools`, and `timeout` are not valid strict `.prove_it/config.json` fields. Use `output: "failures_only"` for clean failures-only task output and `timeout_ms` for strict task timeouts.

To customize config protection, use `config_guard` instead of the retired `guard-config` script/`params.paths` pattern:

```json
{
  "tasks": {
    "protect_sensitive_files": {
      "type": "config_guard",
      "protected_paths": [
        ".prove_it/config.json",
        ".prove_it/config.local.json",
        ".env",
        "credentials/**"
      ]
    }
  },
  "agent_workflows": {
    "pre_tool": ["protect_sensitive_files"]
  }
}
```

To disable a task, remove it from the relevant pipeline or override the pipeline with `.prove_it/config.local.json`; strict config does not use legacy `enabled: false`.

### Matchers and triggers

PreToolUse tasks can filter by tool name and command patterns using `matcher` and `triggers` on individual tasks:

```json
{
  "tasks": {
    "guard_commits": {
      "type": "script",
      "command": "./script/check",
      "matcher": "Bash",
      "triggers": ["(^|\\s)git\\s+commit\\b"]
    }
  },
  "agent_workflows": {
    "pre_tool": ["guard_commits"]
  }
}
```

`matcher` filters by the Adapter's tool name (`Edit`, `Write`, `Bash`, Pi `tool_call` names, etc.). `triggers` are regex patterns matched against the command argument when the Harness exposes one. Both are optional—omit them to run on every Pre Tool event.

## Conditional tasks (`when`)

Tasks can declare conditions that must be met before they run. This is how you gate expensive reviews on Signals, churn thresholds, phase state, or session observations.

```json
{
  "tasks": {
    "done_review": {
      "type": "reviewer",
      "prompt": "skill:prove-done",
      "provider": "claude",
      "when": { "signal": "done" }
    }
  }
}
```

### Condition evaluation

**Object form — AND.** When `when` is an object, every condition must pass:

```json
{ "when": { "signal": "done", "sourceFilesEdited": true } }
```

Both the Done Signal and source-file edit observation must be present.

**Array form — OR of ANDs.** When `when` is an array, each element is AND'd internally and any element passing fires the task:

```json
{
  "tasks": {
    "coverage_review": {
      "type": "reviewer",
      "prompt": "skill:prove-coverage",
      "provider": "claude",
      "when": [
        { "linesChanged": 541 },
        { "linesWritten": 1000 }
      ]
    }
  }
}
```

Either churn threshold firing is enough to run the review.

### Strict condition reference

| Condition | Type | Description |
|-----------|------|-------------|
| `signal` | `"done"`, `"stuck"`, or `"idle"` | Passes when the named Signal is active for the current session. |
| `phase` | `"unknown"`, `"plan"`, `"implement"`, or `"refactor"` | Passes when the current clean phase state matches. |
| `sourceFilesEdited` | boolean | Passes when source files were edited in the current session/turn observations. |
| `testFilesEdited` | boolean | Passes when test files were edited in the current session/turn observations. |
| `sourcesModifiedSinceLastRun` | boolean | Passes when configured source globs are newer than this task's last successful run. |
| `linesChanged` | non-negative integer | Passes when at least N net source lines changed since the task's comparison point. |
| `linesWritten` | non-negative integer | Passes when at least N gross source lines were written by the Primary Agent. |

Legacy conditions such as `fileExists`, `envSet`, `envNotSet`, `variablesPresent`, `toolsUsed`, and task-level `resetOnFail` are not valid strict Clean Runtime config today.

### Git-based churn tracking (`linesChanged`)

`linesChanged` measures net drift (git diff: what changed on disk), filtered to `globs.source`. It counts committed, staged, unstaged, and newly-created source-file changes when the adapter has enough repository context. Broader Worktree isolation for config, state, evidence, and adapter activation is future Platform Capability work.

### Gross churn tracking (`linesWritten`)

`linesWritten` measures gross activity: total lines the Primary Agent has written, even if those lines are later deleted. This catches thrashing. Adapter observation quality can differ by Harness because tool payloads differ.

### Session-scoped observations

`sourceFilesEdited` and `testFilesEdited` are based on clean Session State observations recorded by the active Adapter. After successful Completion Verification, clean completion state can reset so the next verification only reflects new work.

### Signals

Signals let the agent declare where it is in a work cycle. The agent runs `prove_it signal done` (or `stuck`, `idle`) and tasks gated with `when: { signal: "done" }` fire on the next Stop. This is useful for heavyweight checks you only want at the end of a coherent unit of work rather than every Stop.

PreToolUse intercepts the `prove_it signal` command automatically—no extra config needed.

**Clear-on-pass / preserve-on-fail**: After a successful Stop (all tasks pass), the active signal is cleared automatically. After a failed Stop, the signal is preserved so the gated tasks re-fire until they pass. This means you signal once, and the heavy checks keep running until everything is clean.

```json
{
  "tasks": {
    "full_tests": {
      "type": "script",
      "command": "./script/test",
      "when": { "signal": "done" }
    }
  },
  "agent_workflows": {
    "agent_end": ["full_tests"]
  }
}
```

Signal commands:

```
prove_it signal done                         Declare coherent work complete
prove_it signal stuck                        Declare stuck / cycling
prove_it signal idle                         Declare idle / between tasks
prove_it signal done -m "Ready for review"   Include a message
```

## Reviewer tasks

Reviewer Tasks ask an active-harness reviewer provider for an independent `PASS`, `FAIL`, or `SKIP` verdict. In the Claude parity profile, reviewer tasks use the Claude reviewer provider by default; the provider runs Claude Code in a reviewer subprocess and maps the result back into the Workflow Engine.

```json
{
  "tasks": {
    "coverage_review": {
      "type": "reviewer",
      "prompt": "skill:prove-coverage",
      "provider": "claude",
      "provider_options": {
        "max_turns": 20,
        "allowed_tools": ["Read", "Glob", "Grep", "Bash"],
        "bypass_permissions": false,
        "env": {
          "TURBOCOMMIT_DISABLED": "1"
        }
      },
      "when": { "linesChanged": 541 },
      "async": true
    }
  },
  "agent_workflows": {
    "agent_end": ["coverage_review"]
  }
}
```

### Skill-backed reviewer prompts

prove_it ships curated reviewer prompts as Claude Code [skills](https://code.claude.com/docs/en/skills). In strict config, reference a skill with a `skill:` prompt value:

```json
{
  "type": "reviewer",
  "prompt": "skill:prove-coverage",
  "provider": "claude"
}
```

The Claude reviewer backend maps that strict value to Claude's skill invocation mechanics. Do not use legacy `promptType: "skill"` in strict `.prove_it/config.json`.

| Skill | What it reviews |
|-------|----------------|
| `prove-approach` | Approach viability: detects cognitive fixation, performs root-cause analysis, and surfaces structurally different alternatives. Designed for Sonnet. |
| `prove-coverage` | Session diffs for test coverage adequacy |
| `prove-done` | Thorough pre-ship review: correctness, integration, security, tests, omissions. Uses scoped change evidence for review. Designed for Opus. |
| `prove-dry` | Codebase-wide duplication review: finds same-behavior implementations and prescribes EXTRACT refactors. Default PASS. |
| `prove-test-validity` | Test quality review: catches tests that give false confidence (tautological assertions, closed-loop validation, excessive mocking, etc.). Designed for Opus. |

Skills are installed to `~/.claude/skills/<name>/SKILL.md` by `prove_it install`.

### Provider options

Claude reviewer subprocess settings are adapter/provider-owned. Use `provider_options`, not legacy top-level fields:

| Strict field | Replaces legacy concept |
|---|---|
| `provider_options.allowed_tools` | `taskAllowedTools` |
| `provider_options.bypass_permissions` | `taskBypassPermissions` |
| `provider_options.command` | custom reviewer command for the active provider |
| `provider_options.env` | reviewer subprocess environment overrides for that task |
| `provider_options.max_turns` | reviewer turn budget |

Active-harness enforcement is intentional. A Claude session must not invoke Codex-shaped reviewers through `gpt-*` model names or `codex exec -` commands. Codex is deferred for future adapter capability discovery and is not documented as an implemented clean-runtime adapter.

### Reviewer prompt context

The clean reviewer abstraction supplies provider-owned evidence such as session changes, git status, recent commits, Signal messages, and task context where available. The old README documented legacy template variables and `ruleFile`; those legacy config fields are not strict Clean Runtime API today. If you need reusable project-specific reviewer policy now, put it in a custom skill or directly in the reviewer `prompt`/`intent`.

### Async reviews

Set `async: true` on a reviewer task to run it in the background:

```json
{
  "tasks": {
    "coverage_review": {
      "type": "reviewer",
      "prompt": "skill:prove-coverage",
      "provider": "claude",
      "when": { "linesChanged": 541 },
      "async": true
    }
  }
}
```

Async tasks launch and return immediately. Results are harvested on a later Workflow Stage; a deferred `FAIL` is enforced during Completion Verification.

### Parallel tasks

Set `parallel: true` on a task to start it immediately and await it at the end of the current Workflow Stage:

```json
{
  "tasks": {
    "full_tests": {
      "type": "script",
      "command": "./script/test",
      "parallel": true,
      "when": { "signal": "done" }
    },
    "done_review": {
      "type": "reviewer",
      "prompt": "skill:prove-done",
      "provider": "claude",
      "parallel": true,
      "when": { "signal": "done" }
    }
  },
  "agent_workflows": {
    "agent_end": ["full_tests", "done_review"]
  }
}
```

`parallel` and `async` are mutually exclusive; setting both is a validation error.

### Review backchannel

When a Claude reviewer FAILs and an appeal is configured, prove_it creates a Claude Adapter-owned backchannel directory where Claude can appeal the decision:

```
.claude/prove_it/sessions/<session-id>/backchannel/<task-name>/README.md
```

That path is Claude Adapter-owned Session State, not Workflow Engine config. When a reviewer PASSes or SKIPs, the backchannel lifecycle is reset.

## Retired legacy task features

The Legacy Runtime had additional Claude-only config features such as `env` tasks, `ruleFile`, `promptType`, task-level `quiet`, task-level `enabled`, task-level `briefing`, top-level reviewer tool defaults, and `fileEditingTools`. They are not valid strict `.prove_it/config.json` fields after the Claude hard break. Strict `script` task `params`, task-local `env`, `timeout_ms`, and task `output` policy are clean core options, not legacy compatibility aliases.

## Built-in task implementations

The Claude parity profile uses first-class strict task types where possible. For example, config protection is a `config_guard` task, not a legacy `guard-config` script with `params.paths`.

Some standalone scripts still exist in `libexec/` for internal/profile use, but strict Project Config should prefer the documented task types and fields. If you configure a `script` task directly, the strict core execution options are `command`, optional structured `params`, optional task-local string `env`, and optional `timeout_ms`:

```json
{
  "tasks": {
    "custom_check": {
      "type": "script",
      "command": "./script/custom_check",
      "params": {
        "mode": "strict"
      },
      "env": {
        "TURBOCOMMIT_DISABLED": "1"
      },
      "timeout_ms": 120000
    }
  },
  "agent_workflows": {
    "agent_end": ["custom_check"]
  }
}
```

prove_it pipes normalized execution context to script tasks as JSON on stdin. Along with harness event details, script input includes `params` when configured, `target_paths`, effective `sources` and `tests` globs, and cwd/project/root fields. Task-local `env` is applied to the subprocess environment rather than included in stdin.

## Session Start guidance

On Claude `SessionStart`, the Claude Adapter renders Clean Runtime context for the Primary Agent. This includes methodology guidance, active Signals, configured Workflow Engine tasks, and review/backchannel instructions where relevant. The output is adapter-rendered from the Effective Config; strict config does not use the legacy task-level `briefing` field.

Session Start guidance is non-blocking. If guidance rendering fails, the session continues rather than trapping the agent in a startup loop.

## Session phases

prove_it adapts its TDD enforcement based on what Claude is doing. Four phases
control the behavior:

| Phase | What Claude is doing | TDD enforcement |
|-------|---------------------|-----------------|
| `unknown` | Default — no phase declared | Full red-green TDD (same as `implement`) |
| `plan` | Designing an approach, not writing code | No enforcement — planning doesn't need tests |
| `implement` | Writing new features or fixing bugs | Full red-green TDD: write a failing test → confirm failure → write code → confirm pass |
| `refactor` | Restructuring existing code | Run the test suite regularly — existing tests are the safety net |

Claude switches phases by running:

```
prove_it phase implement
prove_it phase refactor
prove_it phase plan
```

### How TDD enforcement works

In **implement** mode (and `unknown`), prove_it tracks a red-green cycle:

1. **Write a test** — prove_it expects a test file edit before source code edits
2. **Run the test, confirm it fails** — proves the test actually tests something
3. **Write the code** — make the test pass
4. **Run the test, confirm it passes** — proves the implementation works

If Claude edits source files without writing tests first, prove_it nudges after
a configurable number of edits (default: 3). If Claude writes a test that passes
without any source changes, prove_it warns that the test may be vacuous.

In **refactor** mode, the expectation is simpler: run the existing test suite
regularly. If tests fail during a refactor, prove_it warns that behavior may have
changed unintentionally.

In **plan** mode, there's no enforcement — Claude is designing, not coding.

### Phase guidance

The Claude parity profile includes phase-aware TDD guidance through Clean Runtime Session Start context and Pre Tool checks. Strict config does not support the legacy task-level `briefing` field.

## Monitoring

### `prove_it monitor`

Run in a separate terminal to watch hook results in real time:

```
prove_it monitor
Session: ea0da8e4 | /Users/justin/code/searls/sugoi_tv | started 02/13/2026, 08:53

09:00:48  BOOM   coverage-review       Unexpected reviewer output: Based on my investigation…
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
| `--status=FAIL,BOOM` | Filter to specific status codes (comma-separated) |
| `--list` | List all sessions with summary info instead of tailing |

### Status of each task

| Code | Meaning |
|------|---------|
| `PASS` | Task passed |
| `FAIL` | Task failed (blocks the action) |
| `SKIP` | Task skipped (condition not met, suspended by appeal, cached, or reviewer said SKIP) |
| `BOOM` | Task crashed (unexpected error—treated as a soft skip unless model is explicitly set) |
| `EXEC` | Task is executing |
| `DONE` | Async review complete, waiting for Stop hook to enforce |
| `ENFORCED:PASS` | Async result was harvested and settled as pass |
| `ENFORCED:SKIP` | Async result was harvested and settled as skip |
| `PLEA` | Developer wrote a backchannel appeal before this review cycle |
| `SET` | Signal was set (`prove_it signal done/stuck/idle`) |
| `CLEAR` | Signal was auto-cleared after successful Stop |

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

## Built-in reviews

prove_it ships review prompts that can be run manually or automatically:

| Skill | What it reviews | Designed for |
|-------|----------------|--------------|
| `/prove-approach` | Approach viability: detects cognitive fixation, surfaces structurally different alternatives | Sonnet (balanced) |
| `/prove-coverage` | Test coverage adequacy for changed code | Haiku (fast, cheap) |
| `/prove-done` | Pre-ship review: correctness, integration, security, tests, omissions | Opus (thorough) |
| `/prove-dry` | Codebase-wide duplication: finds same-behavior implementations, prescribes extractions | Opus (thorough) |
| `/prove-test-validity` | Test quality: catches tests that give false confidence (tautological assertions, closed-loop validation, excessive mocking) | Opus (thorough) |

**Run manually** — invoke any skill as a slash command whenever you want a review. All run as subagents (`context: fork`), so they don't consume your conversation context.

**Run automatically** — configure the same prompts as strict `reviewer` tasks and they'll fire from Workflow Engine pipelines. The Claude parity profile does this: `prove-coverage` runs async after churn thresholds are hit, `prove-done` runs on `prove_it signal done`, and `prove-approach` runs on `prove_it signal stuck`. `prove-test-validity` and `prove-dry` are available skills but are not enabled by default. See [Skill-backed reviewer prompts](#skill-backed-reviewer-prompts) for config details.

The manual and automatic paths use the same reviewer intent — the difference is who triggers it (you vs. prove_it) and where it runs (Claude Code subagent vs. the Claude reviewer provider). Both produce an independent review outside the working agent's context.

## Reviewer subprocess options

Claude reviewer subprocess settings are configured per strict `reviewer` task under `provider_options`. The old top-level fields `taskEnv`, `taskAllowedTools`, and `taskBypassPermissions` are Legacy Runtime config and are not valid strict `.prove_it/config.json` fields.

```json
{
  "tasks": {
    "done_review": {
      "type": "reviewer",
      "prompt": "skill:prove-done",
      "provider": "claude",
      "provider_options": {
        "allowed_tools": ["Read", "Glob", "Grep", "Bash", "Task"],
        "bypass_permissions": false,
        "env": {
          "TURBOCOMMIT_DISABLED": "1"
        },
        "max_turns": 20
      }
    }
  }
}
```

## Adapter observation limits

The Workflow Engine reasons over normalized observations such as `sourceFilesEdited`, `testFilesEdited`, `linesChanged`, and `linesWritten`. Mapping harness-specific tool payloads into those observations is adapter-owned. The old top-level `fileEditingTools` field is not part of strict config today; future adapter-specific observation settings should live under explicit adapter config once supported.

## Session management

For Claude sessions, prove_it stores adapter-owned session data in `~/.claude/prove_it/sessions/`—log files (`.jsonl`), state files (`.json`), and async task directories. This is Session State, not Project Config.

**Lazy cleanup**: On every fresh session start (`startup` source), prove_it prunes session files older than 7 days. Pruning is rate-limited to once per 24 hours (tracked via a `.last_prune` marker file), so it adds no overhead to normal operation.

Output truncation and hook-context formatting are adapter-owned details today; strict `.prove_it/config.json` does not currently expose the legacy `format.maxOutputChars` field.

## Worktrees

Worktree support is future Platform Capability work, not part of the Claude Parity Cutover. The intended direction is isolated boundaries for Project Config, Local Config, Session State, Evidence, reviewer/backchannel artifacts, and adapter activation per Worktree. Do not treat current Claude or Pi adapter-owned paths as the final Worktree boundary model.

## Commands

```
prove_it install        Register global hooks (~/.claude/settings.json)
prove_it uninstall      Remove global hooks
prove_it reinstall      Uninstall and reinstall global hooks
prove_it init --adapter <id>  Set up strict .prove_it project config and adapter artifacts
prove_it deinit         Remove prove_it from current project
prove_it reinit         Deinit and re-init current repository
prove_it doctor         Check installation and show effective config
prove_it monitor        Tail hook results in real time
prove_it signal <type>  Declare a lifecycle signal (done, stuck, idle)
prove_it cancel         Cancel running hook tasks for the current session
prove_it disable        Silence prove_it hooks for the current session (run via `!`)
prove_it enable         Re-enable prove_it hooks for the current session
prove_it catchup        Fast-forward reviewer baselines past stale repo state
prove_it phase <mode>   Set session phase (unknown, plan, implement, refactor)
prove_it hook <spec>    Run a dispatcher directly (claude:Stop, git:pre-commit)
prove_it prefix         Print install directory (for resolving libexec scripts)
prove_it record         Record a test run result (--name <task> --pass|--fail|--result <N>)
prove_it help           Show help
prove_it --version      Show version
```

## Disabling prove_it

For Clean Runtime projects, prefer session-scoped controls when you need prove_it out of the way temporarily:

```bash
! prove_it disable   # silence Pre Tool / Completion Verification hooks for this session
! prove_it enable    # restore them
! prove_it cancel    # stop running hook tasks for this session
```

This works because the Claude Adapter injects `PROVE_IT_SESSION_ID` into the shell on Session Start. The disabled state is keyed to that session id, so other sessions are unaffected. On resume of a disabled session, Claude receives a reminder to run `! prove_it enable` if you want hooks restored.

For all Harnesses, you can also disable prove_it with an environment variable:

```bash
export PROVE_IT_DISABLED=1
```

To disable an adapter persistently, edit strict `.prove_it/config.json` (or your local `.prove_it/config.local.json`) and set that adapter to `enabled: false`:

```json
{
  "schema_version": 1,
  "profile_version": "prove_it.strict.v1",
  "adapters": {
    "claude": { "enabled": false }
  }
}
```

Do not edit `.claude/prove_it/config.json` or `.claude/prove_it/config.local.json` for Clean Runtime behavior; normal Claude hook dispatch ignores those retired legacy files.

Git hooks (pre-commit, pre-push) are not session-scoped and continue to run. Use `git commit --no-verify` if you need to bypass those.

### Catch reviewers up after a big repo change

If you `git pull` (or rebase / reset) mid-session and pull in commits the
session didn't actually produce, reviewers will keep diffing against the
old baseline and flag work that isn't yours. Run:

```bash
! prove_it catchup            # advance baselines for every task in this session
! prove_it catchup done-review # only advance one task
```

`catchup` advances task refs (`refs/worktree/prove_it/<task>`) and the
session baseline to the current `HEAD`, clears successive failure counts,
removes tasks from the suspended list, and deletes any open backchannel
appeal directories. Uncommitted edits stay visible to subsequent reviewers
— catchup zips past committed history, not your in-progress work.

Scoped to the current git checkout (or worktree). Per-task form leaves
session-wide state untouched.

## Troubleshooting

```bash
prove_it doctor
```

- **Hooks not firing**—Restart Claude Code after `prove_it install`
- **Tests not running**—Check `./script/test` exists and is executable (`chmod +x`)
- **Hooks running in wrong directories**—prove_it only activates in git repos
- **Reviews never fire**—The default `when` conditions use churn thresholds (`linesChanged`, `linesWritten`). Reviews only trigger after enough code has been written. Check `prove_it monitor` to see skip reasons with current/threshold counts. If edits happen through a harness tool the adapter does not recognize as file editing, strict config does not yet expose the legacy `fileEditingTools` override; that is future adapter-observation work.
- **Async reviews not enforcing**—Async results are harvested on the next Stop. If Claude stops work before the async review completes, the result will be enforced on the stop after that. Check `prove_it monitor --verbose` to see RUNNING/DONE status progression.
- **Hooks hanging or taking too long**—Press escape in Claude Code to dismiss the hook UI, then run `! prove_it cancel` to kill all running tasks for the current session. The hook exits with approve so Claude can continue. This works because prove_it injects `PROVE_IT_SESSION_ID` into your shell environment on session start.
- **Stale `.claude/prove_it` configs reported**—After the Claude hard break, normal Claude hook dispatch ignores `.claude/prove_it/config.json` and `.claude/prove_it/config.local.json`. Move retained workflow intent into strict `.prove_it/config.json`; there is no migration command or dual-runtime compatibility mode.
- **Config errors after upgrade**—Run `prove_it reinstall && prove_it reinit` to reset to current defaults

## Cookbook

### Prefer `gh` CLI over WebFetch for GitHub URLs

Claude sometimes uses `WebFetch` for GitHub URLs when the `gh` CLI is faster and handles authentication. This guard script denies `WebFetch` for any `github.com` URL and tells Claude to use `gh` instead.

**1. Create the guard script** (requires `jq`):

```bash
mkdir -p ~/bin/prove_it_tasks
cat > ~/bin/prove_it_tasks/prefer_gh_cli_over_fetch << 'SCRIPT'
#!/usr/bin/env bash
# Guard: deny WebFetch for GitHub URLs, redirect to gh CLI.
# Reads hook input from stdin (prove_it pipes tool_name + tool_input).

input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty')

[ "$tool" = "WebFetch" ] || exit 0

url=$(echo "$input" | jq -r '.tool_input.url // empty')

if echo "$url" | grep -qi 'github\.com'; then
  echo "Do not use WebFetch for GitHub URLs. Use the gh CLI instead (e.g., gh pr view, gh issue view, gh api)."
  exit 1
fi
SCRIPT
chmod +x ~/bin/prove_it_tasks/prefer_gh_cli_over_fetch
```

**2. Add it to strict `.prove_it/config.json`**:

```json
{
  "tasks": {
    "prefer_gh_cli_over_fetch": {
      "type": "script",
      "command": "~/bin/prove_it_tasks/prefer_gh_cli_over_fetch",
      "matcher": "WebFetch"
    }
  },
  "agent_workflows": {
    "pre_tool": ["prefer_gh_cli_over_fetch"]
  }
}
```

**How it works:** prove_it pipes normalized hook context (tool name, tool input, session ID) as JSON to script tasks on stdin. The `matcher` limits the task to `WebFetch`; the script then checks whether the URL is GitHub and exits 1 to deny it.

## Examples

Clean-runtime examples:

- [`example/pi-strict/`](example/pi-strict/) — Pi-first strict `.prove_it` project using `@davemo/pi-prove-it`.
- [`example/claude-fast-follow/`](example/claude-fast-follow/) — Claude parity project with strict `.prove_it` config. The directory name is historical from the fast-follow phase.
- [`example/multi-adapter/`](example/multi-adapter/) — Pi + Claude strict `.prove_it` project using `profile: "strict"` so Pi does not inherit Claude-only defaults.

Legacy characterization examples retained for test-only oracle coverage:

- [`example/basic/`](example/basic/) — retired `.claude/prove_it` config, not recommended for new projects.
- [`example/advanced/`](example/advanced/) — retired `.claude/prove_it` config, not recommended for new projects.

Human review is downstream/external to prove_it core; examples do not model human approval as a core prove_it gate. Codex is deferred for future adapter capability discovery and is not documented as an implemented clean-runtime adapter.

## Requirements

- Node.js >= 18
- Claude Code with hooks support

## License

MIT
