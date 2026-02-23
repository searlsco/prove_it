---
name: session-log
description: Inspect prove_it session logs—review history, reviewer verdicts, and session state. Use when asked about session logs, reviewer results, or "what did the last hook say".
---

# Inspect prove_it session logs

Session data lives in `~/.claude/prove_it/sessions/`. Two file types per session:

- `<session_id>.json`—session state (project dir, git HEAD, started_at)
- `<session_id>.jsonl`—reviewer log (one JSON object per line: at, reviewer, status, reason, projectDir, sessionId)
- `_project_<hash>.jsonl`—project-level reviewer log (when session_id was null)

## Determine the current session ID

The current Claude Code session ID is passed in hook input. To find it for the active conversation, check the most recently modified `.jsonl` file:

```bash
ls -t ~/.claude/prove_it/sessions/*.jsonl | head -5
```

## What to show

### Default (no args): show the current session's reviewer log

1. Find the most recently modified `.jsonl` file (excluding `_project_*` and `test-session*` files).
2. Read it and display each entry as a table or formatted list showing:
   - **Time** (human-readable from the `at` timestamp)
   - **Reviewer** name
   - **Status** (PASS/FAIL/SKIP/BOOM)
   - **Reason** (the reviewer's rationale)

### With a session ID arg: show that specific session

Read `<session_id>.jsonl` and `<session_id>.json` and display both the session state and reviewer entries.

### With `--all` or `all`: list all sessions

List all session `.json` files sorted by modification time, showing session ID, project, and started_at.

### With `--stats` or `stats`: aggregate reviewer stats

Count PASS/FAIL/SKIP/BOOM across all `.jsonl` files and show totals.

## Formatting

- Show timestamps as relative times (e.g., "2 min ago") or HH:MM:SS
- Truncate long reasons to ~120 chars in table view, show full text if only one session
- Use the reviewer name as-is (e.g., "coverage-review", "fast-tests")
