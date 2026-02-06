# prove_it

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

Hooks for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that enforce verified workflows. If Claude says "done" but didn't run the tests, it wasn't actually done.

**This is for Claude Code users.** If you're not using Claude Code, this tool won't do anything for you.

## Setup

```bash
# Install the CLI
brew install searlsco/tap/prove_it

# Register hooks with Claude Code
prove_it install

# IMPORTANT: Restart Claude Code (hooks load at startup)
```

Then in each project:

```bash
cd your-project
prove_it init
```

Now create these executable scripts in your project:

| Script | Purpose | When it runs |
|--------|---------|--------------|
| `script/test_fast` | Fast unit tests | Every time Claude stops work |
| `script/test` | Full test suite (units, integration, linters, etc.) | Before every `git commit` |

Example `script/test_fast`:
```bash
#!/bin/bash
npm test
```

Example `script/test`:
```bash
#!/bin/bash
npm test && npm run lint && npm run typecheck
```

That's it. Now Claude must pass your tests before committing or claiming completion.

## What It Does

1. **Blocks commits** - `git commit` won't run until `./script/test` passes
2. **Blocks stop** - Claude can't stop working until `./script/test_fast` passes
3. **Tracks runs** - Only re-runs tests when source files actually changed

## Disabling

**Ignore specific directories** (e.g., `~/bin` that happens to be a git repo):

Edit `~/.claude/prove_it/config.json`:
```json
{
  "ignoredPaths": ["~/bin", "~/dotfiles"]
}
```

**Disable for this project:**
```bash
echo '{"enabled":false}' > .claude/prove_it.json
```

**Disable globally:**
```bash
export PROVE_IT_DISABLED=1
```

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

## AI Code Reviewer

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

## Troubleshooting

```bash
prove_it diagnose
```

- **Hooks not firing**: Restart Claude Code
- **Tests not running**: Check `./script/test` exists and is executable (`chmod +x`)
- **Hooks running in wrong directories**: prove_it only activates in git repos
