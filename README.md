# prove_it

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

Hooks for [Claude Code](https://claude.ai/code) that enforce test-gated workflows. If Claude says "done" but didn't run the tests, it wasn't actually done.

## Why

Claude Code is good at writing code but bad at knowing when it's finished. It'll say "done" or "fixed" without running the test suite, leaving you to discover the breakage later. prove_it fixes this by:

1. **Blocking Stop** until the suite gate passes (if anything changed)
2. **Wrapping completion commands** like `git commit` with the test suite
3. **Requiring a tracked task** before allowing code changes (if you use [beads](https://github.com/anthropics/beads))

The suite gate is just an executable at `./script/test` in your repo. You decide what it runs.

## Installation

```bash
brew install searlsco/tap/prove_it
prove_it install
```

Or with npm:

```bash
npx prove_it install
```

**Important**: Restart Claude Code after installing. Hooks are loaded at startup.

## What it installs

- `~/.claude/CLAUDE.md` - instructions for Claude about verification requirements
- `~/.claude/hooks/prove_it_*.js` - the actual enforcement hooks
- `~/.claude/prove_it/config.json` - global configuration
- Updates `~/.claude/settings.json` to register the hooks

## Setting up a repo

```bash
cd your-repo
prove_it init
```

This creates a stub at `./script/test`. Replace it with your actual test command:

```bash
#!/bin/bash
npm test && npm run lint
```

Or whatever your stack needs. The only requirement is exit 0 for success.

## Commands

```
prove_it install    # Install globally
prove_it uninstall  # Remove global hooks
prove_it init       # Add templates to current repo
prove_it deinit     # Remove templates from current repo
prove_it diagnose   # Check what's working and what isn't
```

## Configuration

Global config lives at `~/.claude/prove_it/config.json`. Per-repo config is split:
- `.claude/prove_it.json` - team config (commit this)
- `.claude/prove_it.local.json` - local overrides + run cache (gitignored)

Key settings:

- `commands.test.full` - full gate command (default: `./script/test`)
- `commands.test.fast` - fast gate for Stop hook (default: `./script/test_fast`, falls back to full)
- `sources` - glob patterns to track for mtime-based skip (default: `null` = git-tracked files)
- `hooks.done.enabled` - enable Done hook (gates commit/beads done) (default: `true`)
- `hooks.done.commandPatterns` - regex patterns for commands that trigger the gate
- `hooks.stop.enabled` - enable Stop hook (default: `true`)
- `reviewer.onStop.enabled` - AI reviewer checks test coverage on Stop (default: `true`)
- `reviewer.onStop.prompt` - what the coverage reviewer checks
- `reviewer.onDone.enabled` - AI reviewer checks for bugs before commit (default: `true`)
- `reviewer.onDone.prompt` - what the code reviewer checks
- `format.maxOutputChars` - truncate gate output to this many characters (default: `12000`)
- `beads.enabled` - require a task before code changes (default: `true`)

Example: use npm test instead of script/test:

```json
{
  "commands": {
    "test": {
      "full": "npm test"
    }
  }
}
```

## How it works

**Stop hook**: When Claude tries to stop, runs the fast gate (`./script/test_fast` or full gate). Uses mtime tracking to skip if tests already passed since last code change. If tests failed recently and code hasn't changed, blocks immediately.

**Done hook**: When Claude runs `git commit` or `beads done`, prepends the full gate. The command only proceeds if tests pass.

**Beads hook**: If your repo has a `.beads/` directory, blocks Edit/Write operations until there's an in-progress task. This prevents "I'll add the task after" behavior.

## Troubleshooting

```bash
prove_it diagnose
```

This checks whether hooks are installed, registered, and whether your current repo has the expected suite gate.

## Releasing

To release a new version:

1. Bump version in `package.json`
2. Commit, tag, and push:
   ```bash
   git add -A && git commit -m "v0.x.x"
   git tag v0.x.x
   git push && git push --tags
   ```
3. GitHub Actions will automatically update the Homebrew formula in `searlsco/homebrew-tap`
4. Verify with:
   ```bash
   brew update && brew reinstall searlsco/tap/prove_it && prove_it diagnose
   ```
