# Agent Testing

## The problem

prove_it's hooks reference `prove_it` by name (e.g., `prove_it run_builtin config:lock`). When Claude Code fires hooks, the `prove_it` on PATH determines which version runs. During development, that's usually the Homebrew install — not your working tree.

## The solution

`script/agent` launches Claude Code with `test/bin/prove_it` prepended to PATH. This shim resolves to the repo's `cli.js`, so every `prove_it` invocation — hooks, builtins, transitive calls — uses your local source.

```bash
./script/agent                    # interactive
./script/agent -p "fix the bug"  # with prompt
```

## How it works

```
script/agent
  └─ PATH="$REPO_ROOT/test/bin:$PATH" claude --dangerously-skip-permissions
       └─ Claude Code fires SessionStart
            └─ prove_it hook claude:SessionStart
                 └─ resolves to test/bin/prove_it → cli.js
                      └─ runs local-shim-check → confirms test/bin/prove_it is active
                      └─ records session baseline (lazy, internal)
```

All child processes inherit the modified PATH: hook dispatchers, builtin tasks, test scripts, agent reviewers.

## Verification

The project's `.claude/prove_it/config.json` includes a `local-shim-check` as the first SessionStart task. On every session start, it runs:

```bash
which prove_it | grep -q test/bin/prove_it
```

- **Pass**: `prove_it resolves to local shim: .../test/bin/prove_it`
- **Fail**: `WARNING: prove_it resolves to /opt/homebrew/bin/prove_it, not test/bin/prove_it. Use ./script/agent to launch Claude with the local version.`

This is a SessionStart task, so it warns but doesn't block — the agent sees the message and knows whether it's running against local source or the installed version.

## When to use what

| Scenario | Command |
|----------|---------|
| Develop prove_it with live hooks | `./script/agent` |
| Run tests from the CLI | `./script/test` |
| Test a single hook manually | `PATH="$(pwd)/test/bin:$PATH" prove_it hook claude:Stop <<< '{...}'` |
| Test an example project | `cd example/basic && PATH="../../test/bin:$PATH" claude` |
| Use the installed (released) version | `claude` (normal) |
