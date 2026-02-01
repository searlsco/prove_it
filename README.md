# prove_it

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

Hooks for [Claude Code](https://claude.ai/code) that enforce test-gated workflows. If Claude says "done" but didn't run the tests, it wasn't actually done.

## Why

Claude Code is good at writing code but bad at knowing when it's finished. It'll say "done" or "fixed" without running the test suite, leaving you to discover the breakage later. prove_it fixes this by:

1. **Blocking Stop** until the suite gate passes (if anything changed)
2. **Wrapping completion commands** like `git commit` and `git push` with the test suite
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
- `~/.claude/hooks/prove-it-*.js` - the actual enforcement hooks
- `~/.claude/prove-it/config.json` - global configuration
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

Global config lives at `~/.claude/prove-it/config.json`. Per-repo overrides go in `.claude/verifiability.local.json`.

Key settings:

- `suiteGate.command` - what to run (default: `./script/test`)
- `suiteGate.require` - block if suite gate is missing (default: `true`)
- `beads.enabled` - require a task before code changes (default: `true`)

To disable the suite gate requirement for a specific repo:

```json
{
  "suiteGate": {
    "require": false
  }
}
```

## How it works

**Stop hook**: When Claude tries to stop, prove_it checks if anything changed since the session started. If so, it runs `./script/test`. Failure blocks the stop.

**PreToolUse hook**: When Claude runs `git commit`, `git push`, or `beads done`, prove_it prepends the suite gate. The command only proceeds if tests pass.

**Beads hook**: If your repo has a `.beads/` directory, prove_it blocks Edit/Write operations until there's an in-progress task. This prevents "I'll add the task after" behavior.

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
