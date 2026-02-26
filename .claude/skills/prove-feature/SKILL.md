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

## Arguments

`<feature description>` — a short description of what to prove. Examples:
- "script appeal prevents doom loops"
- "multi-when arrays are logical OR"
- "backchannel writes bypass PreToolUse enforcement"
- "linesChanged threshold triggers at the right count"

## Method

### Step 1: Write a self-contained Node.js test script

Create a single file at `/tmp/prove_it_feature_<name>/prove.js` that does
everything: creates the temp project, writes config, runs dispatches, prints
results. This is not a `node:test` test — it's a standalone script that
prints a human-readable transcript.

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

// ... test scenarios go here ...

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

### Step 2: Write the test scenarios

Fill in the `// ... test scenarios go here ...` section with scenarios
specific to the feature being proved. Each scenario should:

1. Set up the config and project state (scripts, files, git commits)
2. Invoke the dispatcher one or more times
3. Assert on the decision, reason, and any side effects
4. Print human-readable output showing what happened

**Follow these patterns for common feature types:**

#### Script tasks (PreToolUse enforcement)
```javascript
writeFile('script/test_fast', '#!/bin/bash\nexit 0\n')
makeExecutable('script/test_fast')
writeConfig({ enabled: true, hooks: [{ type: 'claude', event: 'PreToolUse', tasks: [...] }] })
const r = invokePreToolUse('Bash', { command: 'echo hello' })
check('script passes → allow', decision(r) === 'allow')
```

#### When-condition gating
```javascript
writeConfig({ enabled: true, hooks: [{ type: 'claude', event: 'PreToolUse', tasks: [{
  name: 'gated', type: 'script', command: './script/pass',
  when: { envSet: 'MY_VAR' }
}] }] })
const r1 = invokePreToolUse('Bash', { command: 'echo' })
check('no env → skipped', decision(r1) !== 'deny')
const r2 = invokePreToolUse('Bash', { command: 'echo' }, { MY_VAR: '1' })
check('env set → runs', decision(r2) === 'allow')
```

#### Stateful features (appeal, suspension, failure counting)
Run the same dispatch multiple times with the same session ID. Assert
that behavior changes across invocations (e.g., failure count increments,
backchannel appears, task gets suspended).

#### Stop hook tasks
```javascript
writeConfig({ enabled: true, hooks: [{ type: 'claude', event: 'Stop', tasks: [...] }] })
const r = invokeStop()
check('stop approves', r.output?.decision === 'approve')
```

### Step 3: Call summary() and cleanup()

Always end the script with:
```javascript
summary()
cleanup()
process.exit(totalFail > 0 ? 1 : 0)
```

### Step 4: Run it and present the output

```bash
node /tmp/prove_it_feature_<name>/prove.js
```

Show the full terminal output to the user. The transcript IS the proof.

## Design principles

**One script, zero dependencies.** The prove script must be a single file
that uses only Node.js stdlib. No test framework. No imports from the
prove_it repo (the dispatcher is invoked as a subprocess, not imported).

**Isolated from real config.** Always use a fake HOME and PROVE_IT_DIR.
Never touch `~/.claude/` or the user's real sessions.

**Human-readable first.** The output is for a human reading a terminal.
Use color, alignment, and section headers. Print the raw dispatcher output
for each scenario so the reader can verify without expanding tool calls.

**Session transcript is mandatory.** Always call `printSessionLog()` at the
end. The session `.jsonl` file is the ground truth for what the dispatcher
did. If it's empty, something is wrong.

**Prove failure before success.** When testing enforcement features, always
prove the system can deny before proving it can allow. A system that always
allows is useless.

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

── Scenario 1: Task skipped when condition not met ──

  PASS  No env var → task skipped (allow)
  PASS  With env var → task runs and passes

── Scenario 2: Failing script blocks tool use ──

  PASS  Script failure → deny
         raw: decision=deny  reason=prove_it: fast-tests failed...

── Session Transcript ──

  TIME      STATUS   TASK                 REASON
  ────────  ───────  ───────────────────  ──────────────────────────────
  19:25:35  SKIP     or-gate              Skipped because $TRIGGER was not set
  19:25:35  RUNNING  or-gate
  19:25:35  PASS     or-gate              ./script/pass passed (0.0s)

── Summary ──

  ✓ All 8 checks passed
```
