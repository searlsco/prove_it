# Claude Verifiability Kit (CCVK)

A strict “verifiability-first” setup for Claude Code:

- **Global CLAUDE.md**: forces a consistent, test-gated workflow for all programming work.
- **Global hooks**:
  - **Stop gate**: if anything changed, Claude cannot stop unless the suite gate passes (default: `./scripts/test`).
  - **PreToolUse gate**: when Claude tries to run “completion” commands (e.g., `git commit`, `git push`, `beads done`), it auto-wraps them to run the suite gate first.
  - **SessionStart baseline**: records the session’s starting git state so Stop can decide if anything changed.

The goal is to prevent “looks done” behavior when the work was never actually verified.

---

## Install (global)

1. Unzip this folder somewhere.
2. Run:

    node install.js

This will:

- Copy `global/CLAUDE.md` → `~/.claude/CLAUDE.md` (with a backup if you already have one)
- Copy hooks → `~/.claude/hooks/`
- Create `~/.claude/verifiability-kit/config.json` (if missing)
- Merge hook config into `~/.claude/settings.json` (with a backup)

> Claude Code settings scopes and locations: `~/.claude/settings.json` (user scope), `.claude/settings.json` (project scope). See Claude Code docs for the full hierarchy.

---

## Optional: initialize a repo (local assets)

From a repo root:

    node init-project.js

This copies the template files into:

- `.claude/rules/`
- `.claude/verifiability.local.json` (project override template)
- `.claude/ui-evals/`
- `.claude/verification/`

It will also create a **stub** `scripts/test` if one doesn’t exist (you must implement it for your stack), and mark it executable when possible.

---

## Configure

Global config:

- `~/.claude/verifiability-kit/config.json`

Per-repo overrides (optional):

- `<repo>/.claude/verifiability.local.json`

Key settings:

- `suiteGate.command` (default `./scripts/test`)
- `preToolUse.permissionDecision` (`"ask"` or `"allow"`)
- `preToolUse.gatedCommandRegexes` (regex list for “completion boundary” commands)
- `stop.cacheSeconds` (avoid rerunning the suite repeatedly when nothing changed)

---

## Uninstall

Run:

    node uninstall.js

This attempts to remove CCVK hook entries from `~/.claude/settings.json` and removes CCVK files (leaving backups).

---

## Notes

- Hooks run as normal shell commands on your machine with your user privileges.
- The Stop gate is the primary guarantee. If your Claude Code client has issues honoring PreToolUse “ask/deny”, the Stop gate still prevents “done without verification”.
