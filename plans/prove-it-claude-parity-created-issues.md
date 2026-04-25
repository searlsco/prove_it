# Created GitHub Issues: Claude Parity Migration onto Clean Runtime

Repository: https://github.com/davemo/prove_it

Goal: Justin can use Claude Code with prove_it and get equivalent product behavior backed by strict `.prove_it/config.json`, not `.claude/prove_it/config.json`. This is a hard break; no one-time legacy config migration command is planned.

- #19 Codify Claude parity target and legacy behavior inventory — https://github.com/davemo/prove_it/issues/19
- #20 Route Claude hooks through clean-runtime adapter activation — https://github.com/davemo/prove_it/issues/20
- #21 Render Claude SessionStart from clean runtime — https://github.com/davemo/prove_it/issues/21
- #22 Run strict Claude PreToolUse config guard end-to-end — https://github.com/davemo/prove_it/issues/22
- #23 Run strict Claude PreToolUse script tasks end-to-end — https://github.com/davemo/prove_it/issues/23
- #24 Port Claude Bash prove_it signal interception to shared lifecycle — https://github.com/davemo/prove_it/issues/24
- #25 Run strict Claude Stop completion verification with hard blocking — https://github.com/davemo/prove_it/issues/25
- #26 Port core when conditions needed by Claude defaults — https://github.com/davemo/prove_it/issues/26
- #27 Record post-tool observations in clean session state — https://github.com/davemo/prove_it/issues/27
- #28 Support clean-runtime async and parallel task lifecycle — https://github.com/davemo/prove_it/issues/28
- #29 Add reviewer task abstraction with active-harness backend — https://github.com/davemo/prove_it/issues/29
- #30 Port reviewer backchannel appeal suspension and reset behavior — https://github.com/davemo/prove_it/issues/30
- #31 Port session control disable enable and cancel — https://github.com/davemo/prove_it/issues/31
- #32 Port phase and plan-file behavior onto clean runtime — https://github.com/davemo/prove_it/issues/32
- #33 Port TaskCompleted auto-signaling behavior — https://github.com/davemo/prove_it/issues/33
- #34 Express current Claude defaults as clean prove_it profile — https://github.com/davemo/prove_it/issues/34
- #35 Cut Claude dispatch over to clean runtime and retire legacy config loading — https://github.com/davemo/prove_it/issues/35
- #36 Document Claude hard break parity behavior and worktree implications — https://github.com/davemo/prove_it/issues/36

Dependency shape:

```text
19 → 20 → 21/22/24 → 23 → 25 → 26 → 27 → 28 → 29 → 30/31/32/33 → 34 → 35 → 36
```
