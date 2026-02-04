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

Config files are layered (later overrides earlier):
1. `~/.claude/prove_it/config.json` - global user config
2. `.claude/prove_it.json` - team config (commit this)
3. `.claude/prove_it.local.json` - local overrides + run cache (gitignored)

### Team config (`.claude/prove_it.json`)

This is the main config you'll customize per-repo. Full example with all options:

```json
{
  "commands": {
    "test": {
      "full": "./script/test",
      "fast": "./script/test_fast"
    }
  },
  "sources": [
    "src/**",
    "lib/**",
    "test/**",
    "*.js"
  ],
  "hooks": {
    "done": {
      "enabled": true,
      "commandPatterns": [
        "(^|\\s)git\\s+commit\\b",
        "(^|\\s)(beads|bd)\\s+(done|finish|close)\\b"
      ]
    },
    "stop": {
      "enabled": true
    }
  },
  "reviewer": {
    "onStop": {
      "enabled": true,
      "prompt": "Custom coverage review instructions..."
    },
    "onDone": {
      "enabled": true,
      "prompt": "Custom code review instructions..."
    }
  },
  "format": {
    "maxOutputChars": 12000
  },
  "beads": {
    "enabled": true
  }
}
```

**Key settings to customize:**

- **`commands.test.full`** - your full test suite command (default: `./script/test`)
- **`commands.test.fast`** - fast tests for Stop hook (default: `./script/test_fast`, falls back to full)
- **`sources`** - glob patterns for source files. When set, prove_it only runs tests when these files change. If `null` (default), tracks all git-tracked files.

### Local config (`.claude/prove_it.local.json`)

Gitignored. Contains local overrides and run tracking data:

```json
{
  "hooks": {
    "stop": {
      "enabled": false
    }
  },
  "runs": {
    "test_fast": { "pass": true, "at": 1706000000000, "mtime": 1705999000000 },
    "test_full": { "pass": true, "at": 1706000000000, "mtime": 1705999000000 }
  }
}
```

The `runs` section is managed automatically—it tracks when tests last passed so prove_it can skip redundant runs.

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
