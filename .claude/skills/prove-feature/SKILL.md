---
name: prove-feature
description: >
  Create a temporary real project and prove a prove_it feature works (or doesn't)
  end-to-end. Builds a disposable git repo, writes a focused config, runs real
  dispatches through the installed or local prove_it, and produces a human-readable
  session transcript. Use when you need to prove a feature, reproduce a bug, or
  validate a fix against a real project — not just unit tests.
---

# Prove a feature works (or doesn't)

Build a throwaway project and exercise a prove_it feature through the real
dispatcher pipeline. The output is a human-readable transcript the user can
read to confirm the system works end-to-end.

## What "prove" means — read this first

**Proving a feature means watching the feature do its actual job, not just
watching the dispatcher accept a config and return a decision.**

If the feature is a reviewer that detects dead code, you must:
1. Create a project that **contains dead code** → run the reviewer → see it **catch** the dead code
2. Create a project that **has no dead code** → run the reviewer → see it **pass clean**

If the feature is a task that validates API design, you must:
1. Write an API file with **real design violations** → see the task **reject** it
2. Write a clean API file → see the task **approve** it

If the feature is a when-condition gate, you must:
1. Run with the condition **unmet** → see the task **get skipped**
2. Run with the condition **met** → see the task **actually execute and produce its real output**

The pattern is always the same: **construct a realistic situation where the
feature's logic is exercised, then observe it both succeed and fail.** A test
that only checks "did the dispatcher return allow/deny" without verifying the
feature itself inspected the right thing and made the right call is not a proof.

### The critical question

Before writing any code, answer this: **"What real-world situation does this
feature exist to handle, and how will I simulate that situation in a throwaway
project?"**

If you can't answer that, you don't understand the feature well enough to prove
it yet. Stop and think harder.

### Anti-patterns — do NOT do these

**Plumbing-only tests.** Testing that the dispatcher routes to a script and
returns the script's exit code is testing prove_it's plumbing, not the feature.
The feature is what the script *does*. You must create input that makes the
script's logic actually fire.

**Trivial scripts.** Writing `#!/bin/bash\nexit 0` and `#!/bin/bash\nexit 1`
proves the dispatcher handles exit codes. It proves nothing about the feature.
The script must contain the feature's real logic (or a faithful stand-in), and
the test input must be realistic enough to exercise it.

**Success-only tests.** If you only prove the feature passes, you haven't
proved it works — you may have proved it does nothing. A reviewer that always
says "looks good" is broken. **Always prove the feature can fail/reject/deny
before proving it can pass/approve/allow.** Failure-first is how you know the
feature has teeth.

**Config-exists tests.** Writing a config, loading it, and checking it parsed
correctly is a config test, not a feature test. The feature is what happens
*after* the config is loaded.

## Arguments

`<feature description>` — a short description of what to prove. Examples:
- "the dead-code reviewer catches unused functions"
- "the API design validator rejects endpoints without error schemas"
- "script appeal prevents doom loops"
- "multi-when arrays are logical OR"
- "backchannel writes bypass PreToolUse enforcement"
- "linesChanged threshold triggers at the right count"

## Method

### Step 1: Design the scenario BEFORE writing code

This is the most important step. Think through:

1. **What does the feature actually do?** Not what config key enables it —
   what real-world thing does it detect, enforce, or transform?

2. **What does a realistic failing input look like?** Build a project state
   that the feature should catch. Be specific: if it's a code reviewer, write
   actual bad code. If it's a design validator, write an actual bad design.
   If it's a file-size gate, create an actual large file.

3. **What does a realistic passing input look like?** Build the "clean" version
   of the same scenario. Same project structure, but with the problem fixed.

4. **What side effects should you observe?** Beyond pass/fail decisions, what
   should the feature produce? Error messages with specific details? Log entries?
   Modified files? The proof should verify these too — they're how you know the
   feature understood the input, not just guessed.

Write down your scenario plan as comments in the script before implementing it.

### Step 2: Write a self-contained Node.js test script

Create a single file at `/tmp/prove_it_feature_<name>/prove.js` that does
everything: creates the temp project, writes config, builds the realistic
scenario, runs dispatches, and prints results. This is not a `node:test`
test — it's a standalone script that prints a human-readable transcript.

**Use this skeleton:**

```javascript
#!/usr/bin/env node
'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ── Configuration ──

// Choose the dispatcher source:
//   LOCAL SHIM: tests the working tree (for pre-release validation)
//   RELEASE:    tests /opt/homebrew/bin/prove_it (for proving shipped features)
const REPO_ROOT = '<prove_it repo root>'
const USE_LOCAL = <true|false>
const PROVE_IT = USE_LOCAL
  ? path.join(REPO_ROOT, 'test', 'bin', 'prove_it')
  : '/opt/homebrew/bin/prove_it'

// Isolated environment — never touches real user config
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_feature_'))
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_home_'))
const PROVE_IT_DIR = path.join(FAKE_HOME, '.prove_it')
const SESSION_ID = `prove-${Date.now()}`

// ── Helpers ──

function gitIn (dir, ...args) {
  spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
}

function writeFile (relPath, content) {
  const full = path.join(PROJECT_DIR, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function makeExecutable (relPath) {
  fs.chmodSync(path.join(PROJECT_DIR, relPath), 0o755)
}

function writeConfig (config) {
  const cfgPath = path.join(PROJECT_DIR, '.claude', 'prove_it', 'config.json')
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
}

function invoke (hookSpec, input, extraEnv = {}) {
  const env = {
    PATH: USE_LOCAL ? `${REPO_ROOT}/test/bin:${process.env.PATH}` : process.env.PATH,
    HOME: FAKE_HOME,
    CLAUDE_PROJECT_DIR: PROJECT_DIR,
    PROVE_IT_DIR,
    ...extraEnv
  }
  const result = spawnSync(PROVE_IT, ['hook', hookSpec], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env,
    cwd: PROJECT_DIR,
    timeout: 30000
  })
  let output = null
  try { output = JSON.parse(result.stdout) } catch {}
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output
  }
}

function invokePreToolUse (toolName, toolInput, extraEnv = {}) {
  return invoke('claude:PreToolUse', {
    session_id: SESSION_ID,
    tool_name: toolName,
    tool_input: toolInput,
    cwd: PROJECT_DIR
  }, extraEnv)
}

function invokeStop (extraEnv = {}) {
  return invoke('claude:Stop', {
    session_id: SESSION_ID,
    hook_event_name: 'Stop',
    cwd: PROJECT_DIR
  }, extraEnv)
}

function decision (result) {
  return result.output?.hookSpecificOutput?.permissionDecision
    || result.output?.decision
    || '(silent)'
}

function reason (result) {
  return result.output?.hookSpecificOutput?.permissionDecisionReason
    || result.output?.hookSpecificOutput?.message
    || result.output?.reason
    || ''
}

// ── Logging ──

const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'
const INFO = '\x1b[36mINFO\x1b[0m'
const WARN = '\x1b[33mWARN\x1b[0m'
let totalPass = 0
let totalFail = 0

function header (text) {
  console.log(`\n\x1b[1m── ${text} ──\x1b[0m\n`)
}

function info (text) {
  console.log(`  ${INFO}  ${text}`)
}

function check (label, condition, detail) {
  if (condition) {
    console.log(`  ${PASS}  ${label}`)
    totalPass++
  } else {
    console.log(`  ${FAIL}  ${label}`)
    if (detail) console.log(`         ${detail}`)
    totalFail++
  }
}

function printRaw (label, result) {
  const d = decision(result)
  const r = reason(result).split('\n')[0].slice(0, 120)
  console.log(`         ${label}: decision=${d}  reason=${r}`)
}

// ── Setup ──

gitIn(PROJECT_DIR, 'init')
gitIn(PROJECT_DIR, 'config', 'user.email', 'prove@test')
gitIn(PROJECT_DIR, 'config', 'user.name', 'Prove')
writeFile('README.md', '# Test project\n')
gitIn(PROJECT_DIR, 'add', '.')
gitIn(PROJECT_DIR, 'commit', '-m', 'init')

header('Environment')
info(`prove_it:   ${PROVE_IT}`)
info(`source:     ${USE_LOCAL ? 'local shim (working tree)' : 'release (Homebrew)'}`)
info(`project:    ${PROJECT_DIR}`)
info(`session:    ${SESSION_ID}`)
info(`PROVE_IT_DIR: ${PROVE_IT_DIR}`)

// ... scenario implementation goes here ...

// ── Session transcript ──

function printSessionLog () {
  const logFile = path.join(PROVE_IT_DIR, 'sessions', `${SESSION_ID}.jsonl`)
  header('Session Transcript')
  if (!fs.existsSync(logFile)) {
    console.log('  (no session log)')
    return
  }
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
  console.log('  TIME      STATUS   TASK                 REASON')
  console.log('  ────────  ───────  ───────────────────  ──────────────────────────────')
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      const t = new Date(e.at).toISOString().slice(11, 19)
      const s = (e.status || '').padEnd(7)
      const n = (e.reviewer || '').padEnd(19)
      const r = (e.reason || '').split('\n')[0].slice(0, 60)
      console.log(`  ${t}  ${s}  ${n}  ${r}`)
    } catch {}
  }
}

function printSessionState () {
  const stateFile = path.join(PROVE_IT_DIR, 'sessions', `${SESSION_ID}.json`)
  if (!fs.existsSync(stateFile)) return
  header('Session State')
  console.log(JSON.stringify(JSON.parse(fs.readFileSync(stateFile, 'utf8')), null, 2)
    .split('\n').map(l => '  ' + l).join('\n'))
}

// ── Summary ──

function summary () {
  printSessionLog()
  printSessionState()
  header('Summary')
  if (totalFail === 0) {
    console.log(`  \x1b[32m✓ All ${totalPass} checks passed\x1b[0m\n`)
  } else {
    console.log(`  \x1b[31m✗ ${totalFail} of ${totalPass + totalFail} checks failed\x1b[0m\n`)
  }
}

// ── Cleanup ──

function cleanup () {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
}
```

### Step 3: Implement the scenarios — failure first, then success

Fill in the `// ... scenario implementation goes here ...` section. **Every
scenario must follow this structure:**

1. **Build the realistic project state.** Write actual source files, configs,
   scripts — whatever the feature needs to inspect. These must be realistic
   enough that the feature's logic is meaningfully exercised. A dead-code
   detector needs real code with real dead functions. A design validator needs
   a real API spec with real violations.

2. **Prove the feature catches the problem (failure/deny case first).** Run the
   dispatcher against the bad input. Assert not just the decision, but that
   the *reason* or *output* shows the feature understood what was wrong. A deny
   with a generic reason like "script exited 1" is not proof — the reason
   should reference the specific problem (e.g., "unused function `oldHandler`
   detected in src/routes.js").

3. **Fix the problem in the project, then prove the feature approves.** Modify
   the project to resolve the issue (remove the dead code, add the missing
   schema, etc.), then re-run. Assert that the feature now passes. This
   confirms the feature is actually sensitive to the input, not just randomly
   failing.

4. **Check side effects.** If the feature should produce logs, annotations,
   modified files, or specific error messages, verify those exist and contain
   the right content.

**Follow these patterns for common feature types:**

#### Custom reviewer/validator tasks

This is the most common case. You're proving that a task (script, command, etc.)
correctly analyzes project state.

```javascript
// ── Scenario: Dead code reviewer ──
header('Scenario 1: Dead code reviewer catches unused exports')

// Step 1: Write the reviewer script (this IS the feature)
writeFile('scripts/check-dead-code.sh', `#!/bin/bash
# Scan for exported functions that are never imported elsewhere
dead=$(grep -rn 'export function' src/ | while read line; do
  fn=$(echo "$line" | sed 's/.*export function \\([a-zA-Z_]*\\).*/\\1/')
  if ! grep -rq "$fn" src/ --include='*.js' -l | grep -v "$(echo "$line" | cut -d: -f1)" > /dev/null 2>&1; then
    echo "$line"
  fi
done)
if [ -n "$dead" ]; then
  echo "Dead exports found:"
  echo "$dead"
  exit 1
fi
echo "No dead exports"
exit 0
`)
makeExecutable('scripts/check-dead-code.sh')

writeConfig({ enabled: true, hooks: [{ type: 'claude', event: 'PreToolUse', tasks: [{
  name: 'dead-code-check',
  type: 'script',
  command: './scripts/check-dead-code.sh'
}] }] })

// Step 2: Create a project WITH dead code → feature should catch it
writeFile('src/utils.js', `
export function activeHelper() { return 'used' }
export function staleHelper() { return 'nobody calls me' }
`)
writeFile('src/main.js', `
import { activeHelper } from './utils.js'
console.log(activeHelper())
`)
gitIn(PROJECT_DIR, 'add', '.')
gitIn(PROJECT_DIR, 'commit', '-m', 'add code with dead export')

const r1 = invokePreToolUse('Bash', { command: 'echo editing src/main.js' })
check('Dead code present → reviewer denies', decision(r1) === 'deny')
check('Reason mentions the dead function', reason(r1).includes('staleHelper'),
  `Expected reason to mention "staleHelper", got: ${reason(r1).slice(0, 200)}`)
printRaw('raw', r1)

// Step 3: Remove the dead code → feature should pass
writeFile('src/utils.js', `
export function activeHelper() { return 'used' }
`)
gitIn(PROJECT_DIR, 'add', '.')
gitIn(PROJECT_DIR, 'commit', '-m', 'remove dead export')

const r2 = invokePreToolUse('Bash', { command: 'echo editing src/main.js' })
check('Dead code removed → reviewer allows', decision(r2) === 'allow')
check('Reason confirms clean scan', reason(r2).includes('No dead exports'),
  `Expected clean message, got: ${reason(r2).slice(0, 200)}`)
printRaw('raw', r2)
```

The key: the script contains real analysis logic, the project contains real
code, and we verify the feature's output references the specific problem.

#### When-condition gating

```javascript
header('Scenario 2: When-condition gates task execution')

writeConfig({ enabled: true, hooks: [{ type: 'claude', event: 'PreToolUse', tasks: [{
  name: 'gated-review', type: 'script', command: './scripts/check-dead-code.sh',
  when: { envSet: 'RUN_DEAD_CODE_CHECK' }
}] }] })

// Without the env var → task should be skipped entirely
const r3 = invokePreToolUse('Bash', { command: 'echo test' })
check('No env var → task skipped (not denied)', decision(r3) !== 'deny')
printRaw('raw', r3)

// With the env var → task should actually run (and find the dead code if present)
const r4 = invokePreToolUse('Bash', { command: 'echo test' }, { RUN_DEAD_CODE_CHECK: '1' })
check('Env var set → task runs', decision(r4) !== '(silent)',
  `Expected the task to run, got decision=${decision(r4)}`)
printRaw('raw', r4)
```

#### Stateful features (appeal, suspension, failure counting)

Run the same dispatch multiple times with the same session ID. Assert
that behavior changes across invocations (e.g., failure count increments,
backchannel appears, task gets suspended).

```javascript
header('Scenario 3: Repeated failures trigger suspension')

// Use a script that always fails — simulating a reviewer that keeps catching problems
writeFile('scripts/always-fail.sh', '#!/bin/bash\necho "design violation: missing error schema"\nexit 1')
makeExecutable('scripts/always-fail.sh')

writeConfig({ enabled: true, hooks: [{ type: 'claude', event: 'PreToolUse', tasks: [{
  name: 'strict-reviewer', type: 'script', command: './scripts/always-fail.sh'
}] }] })

// Run multiple times — behavior should change as failures accumulate
for (let i = 1; i <= 5; i++) {
  const r = invokePreToolUse('Bash', { command: `echo attempt ${i}` })
  info(`Attempt ${i}: decision=${decision(r)}  reason=${reason(r).slice(0, 80)}`)
}
// (Assert on the specific suspension behavior expected by the feature)
```

#### Stop hook tasks

```javascript
header('Scenario 4: Stop hook runs summary task')

writeConfig({ enabled: true, hooks: [{ type: 'claude', event: 'Stop', tasks: [{
  name: 'session-summary', type: 'script', command: './scripts/summarize.sh'
}] }] })

writeFile('scripts/summarize.sh', '#!/bin/bash\necho "session complete, 3 files changed"\nexit 0')
makeExecutable('scripts/summarize.sh')

const r = invokeStop()
check('Stop hook runs and approves', r.output?.decision === 'approve')
check('Summary output present', reason(r).includes('3 files changed'))
printRaw('raw', r)
```

### Step 4: Call summary() and cleanup()

Always end the script with:
```javascript
summary()
cleanup()
process.exit(totalFail > 0 ? 1 : 0)
```

### Step 5: Run it and present the output

```bash
node /tmp/prove_it_feature_<name>/prove.js
```

Show the full terminal output to the user. The transcript IS the proof.

## Design principles

**The feature must do its actual job in the test.** This is the #1 principle.
If you're proving a code reviewer, it must review real code and catch real
problems. If you're proving a linter gate, it must lint real files. If you're
proving a threshold trigger, you must cross the actual threshold. The
dispatcher plumbing (routing, config parsing, exit code handling) is assumed
to work — you're proving the *feature*, not the *framework*.

**Failure first, then success.** Always prove the feature can reject/deny/fail
before proving it can approve/pass/allow. A system that always says "yes" is
indistinguishable from a system that does nothing. The deny case is what proves
the feature has teeth. Only after seeing a legitimate deny should you fix the
input and verify the allow.

**Verify the reason, not just the decision.** A decision of "deny" could mean
anything. The *reason* is how you know the feature understood the problem. Check
that the reason references the specific issue (the dead function name, the
missing field, the threshold value). Generic reasons like "script failed" are
not proof.

**One script, zero dependencies.** The prove script must be a single file
that uses only Node.js stdlib. No test framework. No imports from the
prove_it repo (the dispatcher is invoked as a subprocess, not imported).

**Isolated from real config.** Always use a fake HOME and PROVE_IT_DIR.
Never touch `~/.claude/` or the user's real sessions.

**FAKE_HOME is HOME.** Several prove_it internals use `process.env.HOME`,
not `CLAUDE_PROJECT_DIR`. For example, `findPlanFile()` searches
`HOME/.claude/plans/`, not the project directory. When your scenario
involves plan files, place them under `FAKE_HOME/.claude/plans/`, not
`PROJECT_DIR/.claude/plans/`. If a task passes silently but has no
side effects, a wrong HOME-vs-project path split is the likely cause.

**Agent tasks need skills installed in FAKE_HOME.** When proving agent-type
tasks (`type: 'agent'` with `promptType: 'skill'`), the reviewer subprocess
(`claude -p`) looks for the skill at `FAKE_HOME/.claude/skills/<name>/SKILL.md`.
If you don't copy the skill file there, the agent will fail with "skill not
found" — which looks like a broken feature but is just a missing setup step.
Copy the skill from the repo before invoking the dispatcher:
```javascript
const skillSrc = path.join(REPO_ROOT, 'lib', 'skills', 'prove-my-skill.md')
const skillDst = path.join(FAKE_HOME, '.claude', 'skills', 'prove-my-skill', 'SKILL.md')
fs.mkdirSync(path.dirname(skillDst), { recursive: true })
fs.copyFileSync(skillSrc, skillDst)
```
Similarly, `claude -p` is available on PATH system-wide, so agent tasks can
and should fully execute their reviewer subprocess in the test environment.

**Human-readable first.** The output is for a human reading a terminal.
Use color, alignment, and section headers. Print the raw dispatcher output
for each scenario so the reader can verify without expanding tool calls.

**Session transcript is mandatory.** Always call `printSessionLog()` at the
end. The session `.jsonl` file is the ground truth for what the dispatcher
did. If it's empty, something is wrong.

**Use the release binary by default.** Set `USE_LOCAL = false` unless you're
testing a fix that isn't released yet. The whole point is to prove the
*shipped* system works.

**Exit non-zero on failure.** The script's exit code is the verdict.

## Choosing local vs release

| Scenario | USE_LOCAL | Why |
|----------|-----------|-----|
| Proving a shipped feature works | `false` | Tests what users actually run |
| Validating a fix before release | `true` | Tests the working tree |
| Reproducing a bug | `false` first | Confirm bug exists in release, then `true` to verify fix |

## Reporting

Present the full terminal output to the user. The output should look like:

```
── Environment ──

  INFO  prove_it:   /opt/homebrew/bin/prove_it
  INFO  source:     release (Homebrew)
  INFO  project:    /tmp/prove_feature_abc123
  INFO  session:    prove-1772134567890

── Scenario 1: Dead code reviewer catches unused exports ──

  FAIL  Dead code present → reviewer denies
  PASS  Reason mentions the dead function
         raw: decision=deny  reason=Dead exports found: src/utils.js:3 staleHelper
  PASS  Dead code removed → reviewer allows
  PASS  Reason confirms clean scan
         raw: decision=allow  reason=No dead exports

── Scenario 2: When-condition gates task execution ──

  PASS  No env var → task skipped (not denied)
  PASS  Env var set → task runs

── Session Transcript ──

  TIME      STATUS   TASK                 REASON
  ────────  ───────  ───────────────────  ──────────────────────────────
  19:25:35  DENY     dead-code-check      Dead exports found: staleHelper
  19:25:35  PASS     dead-code-check      No dead exports
  19:25:36  SKIP     gated-review         Skipped: $RUN_DEAD_CODE_CHECK not set
  19:25:36  PASS     gated-review         No dead exports

── Summary ──

  ✓ All 6 checks passed
```
