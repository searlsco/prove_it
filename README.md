# prove_it - Force Claude to actually verify its work

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

By far the most frustrating thing about [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is its penchant for prematurely declaring success. Out-of-the-box, Claude will happily announce a task is complete. Has it run the tests? No. Did it add any tests? No. Did it run the code? Also no.

That's why I (well, Claude) wrote **prove_it**: to introduce more structured and unstructured verifiability checks into its workflow. It accomplishes this by registering a few [hooks](https://code.claude.com/docs/en/hooks), and is designed to be just-configurable-enough to be used on any project.

If it's not obvious, **prove_it only works with Claude Code.** If you're not using Claude Code, this tool won't do anything for you.

## What does prove_it prove?

The two most important things prove_it does:

* **Blocks stop** - each time Claude finishes its response and hands control back to the user, it fires any ["stop" hooks](https://code.claude.com/docs/en/hooks#subagentstop). prove_it leverages this hook to do two things:
  - Run your unit tests (`script/test_fast` if defined, otherwise `script/test`) and blocks if they fail
  - Deploy a [reviewer agent](#reviewer-agents) to ensure commensurate verification methods (e.g. test coverage) were introduced for whatever code was added during the response
* **Blocks commits** - each time Claude attempts to make a git commit, prove_it runs a hook that will:
  - Run `./script/test` and block unless it passes
  - Deploy a [reviewer agent](#reviewer-agents) that will—in addition to inspecting test coverage—inspect all code introduced since the previous commit and hunt for potential bugs and dead code, blocking if it finds anything significant

Other stuff prove_it does:

* **Beads integration** - if your project uses [beads](https://github.com/steveyegge/beads) to track work, prove_it will stop Claude from editing code until or unless a current task is in progress, essentially forcing it to know what it's working on before it starts editing code
* **Tracks runs** - If Claude stops work or attempts a commit and your code hasn't changed since the last successful test run, it won't waste daylight re-running your tests


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

This will create project-specific settings in `.claude` and ensure a `script/test` exists (don't like it? You can change it later).

## Test scripts

By default, prove_it looks for two test scripts by convention:

| Script | Purpose | When it runs |
|--------|---------|--------------|
| `script/test` | Full test suite (units, integration, linters, etc.) | Before every `git commit` |
| `script/test_fast` | Fast unit tests | Every time Claude stops work |

For example, your `script/test_fast` script might run:

```bash
#!/bin/bash

rake test
```

And your full  `script/test` command will probably run that and more:

```bash
#!/bin/bash

rake test standard:fix test:system
```

That's it. Now Claude must see your tests pass before claiming the job's done or committing your code.

## Commands

```
prove_it install    # Register hooks with Claude Code
prove_it uninstall  # Remove hooks
prove_it init       # Set up current project
prove_it deinit     # Remove from current project
prove_it diagnose   # Check installation status
```

## Configuration

Config files layer (later overrides earlier):
1. `~/.claude/prove_it/config.json` - global defaults
2. `.claude/prove_it.json` - project config (commit this)
3. `.claude/prove_it.local.json` - local overrides (gitignored)

**Custom test commands:**
```json
{
  "commands": {
    "test": {
      "full": "./run-tests.sh",
      "fast": "./run-tests.sh --fast"
    }
  }
}
```

**Disable stop hook** (only require tests on commit):
```json
{
  "hooks": {
    "stop": { "enabled": false }
  }
}
```

**Require tests before git push too:**
```json
{
  "hooks": {
    "done": {
      "triggers": [
        "(^|\\s)git\\s+commit\\b",
        "(^|\\s)git\\s+push\\b"
      ]
    }
  }
}
```

## Reviewer Agents

Each hook has an optional AI reviewer that gates Claude's work with an independent PASS/FAIL check:

- **stop reviewer** - when Claude stops work, checks that changes have test coverage
- **done reviewer** - before `git commit`, reviews staged changes for bugs, dead code, and missing tests

Enabled by default using `claude -p`. Disable with:
```json
{
  "hooks": {
    "stop": { "reviewer": { "enabled": false } },
    "done": { "reviewer": { "enabled": false } }
  }
}
```

### Setting up the reviewer agent

The reviewer is any CLI command that accepts a prompt and returns `PASS` or `FAIL: <reason>` on stdout. By default, prove_it uses `claude -p`, but you can point it at any tool.

Each reviewer has three options:

| Option | Default | Description |
|--------|---------|-------------|
| `command` | `"claude -p {prompt}"` | Command template. `{prompt}` is replaced with the review prompt. |
| `outputMode` | `"text"` | How to read the response from stdout. |
| `prompt` | (built-in) | Custom review instructions (replaces the default prompt). |

**`outputMode`** values:

| Mode | Behavior |
|------|----------|
| `text` | First line of stdout is the verdict. Use with CLIs that output clean text (e.g. `claude -p`). |
| `jsonl` | Parses JSONL events, extracts the last `agent_message`. Use with CLIs that mix progress into stdout (e.g. `codex exec --json`). |

The command must exit 0 on success. The response (after parsing per `outputMode`) must start with `PASS` or `FAIL: <reason>`.

### Example: mixing Claude and Codex

You can use different models for each reviewer. This is useful for adversarial review — the agent doing the work is checked by a different model:

```json
{
  "hooks": {
    "stop": {
      "reviewer": {
        "command": "claude -p {prompt}",
        "outputMode": "text"
      }
    },
    "done": {
      "reviewer": {
        "command": "codex exec --sandbox read-only --json {prompt}",
        "outputMode": "jsonl"
      }
    }
  }
}
```

For [Codex CLI](https://github.com/openai/codex), use `--sandbox read-only` (the reviewer shouldn't write files) and `--json` (so prove_it can parse the structured output instead of the noisy default). The `jsonl` output mode extracts the model's actual response from Codex's `item.completed` events.

## Beads Integration

If you use [beads](https://github.com/anthropics/beads) for task tracking, prove_it requires an in-progress task before allowing code changes. Just have a `.beads/` directory in your project.

Disable with:
```json
{
  "beads": { "enabled": false }
}
```

## Disabling prove_it

If you run `claude` in a directory that is not a typical project (as I often do in `~/tmp` or `~/bin`), you may find that Claude will run erroneously afoul of prove_it's stop hook. To minimize this risk, prove_it will only run by default in directories that are tracked by a git repository.

To disable prove_it, you have a few options:

### Ignore specific directories

Edit `~/.claude/prove_it/config.json`:

```json
{
  "ignoredPaths": ["~/bin", "~/dotfiles"]
}
```

Each of these paths and their descendants will be ignored by prove_it's hooks

### Disable for a particular project

Disable prove_it for all contributors of a project by editing `.claude/prove_it.json`:

```bash
echo '{"enabled":false}' > .claude/prove_it.json
```

Disable prove_it locally in a project with the untracked `.claude/prove_it.local.json`:

```bash
echo '{"enabled":false}' > .claude/prove_it.local.json
```

### Disable prove_it with an environment variable

You can disable prove_it globally by setting the `PROVE_IT_DISABLED` env var:

```bash
export PROVE_IT_DISABLED=1
```

## Troubleshooting

Run the `diagnose` command to see the current state of your installation/setup:

```bash
prove_it diagnose
```

- **Hooks not firing**: Restart Claude Code
- **Tests not running**: Check `./script/test` exists and is executable (`chmod +x`)
- **Hooks running in wrong directories**: prove_it only activates in git repos
