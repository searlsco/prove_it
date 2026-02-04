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
      "commandPatterns": [
        "(^|\\s)git\\s+commit\\b",
        "(^|\\s)git\\s+push\\b"
      ]
    }
  }
}
```

## AI Code Reviewer

prove_it includes an optional AI reviewer that checks test coverage. It runs when Claude stops or commits and reports PASS/FAIL based on whether changes have adequate test coverage.

Enabled by default. Disable with:
```json
{
  "reviewer": {
    "onStop": { "enabled": false },
    "onDone": { "enabled": false }
  }
}
```

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
