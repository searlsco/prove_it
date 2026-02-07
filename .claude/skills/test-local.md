---
name: test-local
description: Test prove_it from source against an example project or temp directory. Use when you want to verify hook behavior end-to-end without a Homebrew release.
---

# Test prove_it locally

Run prove_it from the repo source (not the Homebrew install) to test hook behavior.

## Steps

1. Identify the test target. If the user didn't specify, use `example/basic/`.

2. Set up the PATH shim so `prove_it` resolves to the repo's `cli.js`:
   ```bash
   export PATH="$(git rev-parse --show-toplevel)/test/bin:$PATH"
   which prove_it   # should show test/bin/prove_it
   ```

3. Run the requested test. Common scenarios:

   **Test a specific hook event:**
   ```bash
   cd example/basic
   echo '{"hook_event_name":"Stop","session_id":"test","cwd":"."}' | prove_it hook claude:Stop
   ```

   **Test SessionStart:**
   ```bash
   echo '{"hook_event_name":"SessionStart","source":"startup","session_id":"test","cwd":"."}' | prove_it hook claude:SessionStart
   ```

   **Test PreToolUse (edit protection):**
   ```bash
   echo '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"src/greet.js"},"session_id":"test","cwd":"."}' | prove_it hook claude:PreToolUse
   ```

   **Test PreToolUse (commit gate):**
   ```bash
   echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m test"},"session_id":"test","cwd":"."}' | prove_it hook claude:PreToolUse
   ```

   **Test init in a temp directory:**
   ```bash
   tmpdir=$(mktemp -d)
   cd "$tmpdir" && git init
   prove_it init --no-default-checks
   cat .claude/prove_it.json
   prove_it deinit
   rm -rf "$tmpdir"
   ```

   **Test diagnose:**
   ```bash
   cd example/basic
   prove_it diagnose
   ```

4. Report the output and whether the behavior matches expectations.

## Notes

- The shim at `test/bin/prove_it` just does `exec node ../../cli.js "$@"`
- All `prove_it builtin:*` commands in configs will also resolve through the shim
- This tracks with the current git ref — check out any commit to test that version
