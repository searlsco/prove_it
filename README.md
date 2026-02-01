# prove-it

A strict "verifiability-first" setup for Claude Code:

- **Global CLAUDE.md**: forces a consistent, test-gated workflow for all programming work.
- **Global hooks**:
  - **Stop gate**: if anything changed, Claude cannot stop unless the suite gate passes (default: `./scripts/test`).
  - **PreToolUse gate**: when Claude tries to run "completion" commands (e.g., `git commit`, `git push`, `beads done`), it auto-wraps them to run the suite gate first.
  - **SessionStart baseline**: records the session's starting git state so Stop can decide if anything changed.

The goal is to prevent "looks done" behavior when the work was never actually verified.

---

## Installation

### Homebrew (macOS)

```bash
brew tap searlsco/tap
brew install prove-it
prove-it install
```

### npm / npx

```bash
npx prove-it install
```

### Manual

```bash
git clone https://github.com/searlsco/prove-it.git
cd prove-it
./cli.js install
```

---

## Commands

```
prove-it install      # Install globally to ~/.claude/
prove-it uninstall    # Remove from global config
prove-it init         # Initialize current repo with templates
prove-it deinit       # Remove prove-it files from current repo
prove-it help         # Show help
```

---

## What `install` does

- Copy `global/CLAUDE.md` → `~/.claude/CLAUDE.md` (with backup if exists)
- Copy hooks → `~/.claude/hooks/`
- Create `~/.claude/prove-it/config.json` (if missing)
- Merge hook config into `~/.claude/settings.json` (with backup)

> Claude Code settings scopes: `~/.claude/settings.json` (user), `.claude/settings.json` (project). See Claude Code docs for the full hierarchy.

---

## What `init` does

Copies template files into your repo:

- `.claude/rules/` - project-specific verification rules
- `.claude/verifiability.local.json` - project config overrides
- `.claude/ui-evals/` - UI evaluation tracking
- `.claude/verification/` - manual verification artifacts

Also creates a **stub** `scripts/test` if one doesn't exist (you must implement it for your stack).

---

## Configuration

**Global config:**
- `~/.claude/prove-it/config.json`

**Per-repo overrides (optional):**
- `<repo>/.claude/verifiability.local.json`

**Key settings:**
- `suiteGate.command` (default `./scripts/test`)
- `preToolUse.permissionDecision` (`"ask"` or `"allow"`)
- `preToolUse.gatedCommandRegexes` (regex list for "completion boundary" commands)
- `stop.cacheSeconds` (avoid rerunning the suite repeatedly when nothing changed)

---

## Notes

- Hooks run as normal shell commands on your machine with your user privileges.
- The Stop gate is the primary guarantee. If your Claude Code client has issues honoring PreToolUse "ask/deny", the Stop gate still prevents "done without verification".
- After installing, **restart Claude Code** (hooks are loaded at startup).
