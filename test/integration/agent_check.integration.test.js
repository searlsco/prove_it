const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { defaultModel, runAgentCheck, backchannelDir, backchannelReadmePath, createBackchannel } = require('../../lib/checks/agent')
const { freshRepo } = require('../helpers')

function writeReviewer (dir, name, body) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, `#!/usr/bin/env bash\ncat > /dev/null\n${body}\n`)
  fs.chmodSync(p, 0o755)
  return p
}

function writeCaptureReviewer (dir, captureName) {
  const capturePath = path.join(dir, captureName)
  const p = path.join(dir, `${captureName}_reviewer.sh`)
  fs.writeFileSync(p, `#!/usr/bin/env bash\ncat > "${capturePath}"\necho "PASS"\n`)
  fs.chmodSync(p, 0o755)
  return { reviewerPath: p, capturePath }
}

function ctx (tmpDir, overrides) {
  return { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '', ...overrides }
}

describe('agent check', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  // ---------- Story: basic execution ----------
  // PASS, FAIL, SKIP, empty prompt, null prompt, binary not found
  it('handles PASS, FAIL, SKIP, empty/null prompt, and missing binary', () => {
    // PASS
    const passPath = writeReviewer(tmpDir, 'pass.sh', 'echo "PASS"')
    const pass = runAgentCheck(
      { name: 'test-review', command: passPath, prompt: 'Review {{project_dir}}' },
      ctx(tmpDir)
    )
    assert.strictEqual(pass.pass, true)

    // FAIL
    const failPath = writeReviewer(tmpDir, 'fail.sh', 'echo "FAIL: untested code"')
    const fail = runAgentCheck(
      { name: 'test-review', command: failPath, prompt: 'Review this' },
      ctx(tmpDir)
    )
    assert.strictEqual(fail.pass, false)
    assert.ok(fail.reason.includes('untested code'))

    // SKIP
    const skipPath = writeReviewer(tmpDir, 'skip.sh', 'echo "SKIP: changes are unrelated"')
    const skip = runAgentCheck(
      { name: 'test-review', command: skipPath, prompt: 'Review {{project_dir}}' },
      ctx(tmpDir)
    )
    assert.strictEqual(skip.pass, true)
    assert.strictEqual(skip.skipped, true)
    assert.strictEqual(skip.reason, 'changes are unrelated')

    // Empty prompt → skip
    const empty = runAgentCheck(
      { name: 'test-review', command: 'claude -p', prompt: '' },
      ctx(tmpDir)
    )
    assert.strictEqual(empty.skipped, true)

    // Null prompt → skip
    const nul = runAgentCheck(
      { name: 'test-review', command: 'claude -p', prompt: null },
      ctx(tmpDir)
    )
    assert.strictEqual(nul.skipped, true)

    // Missing binary → skip with warning
    const missing = runAgentCheck(
      { name: 'test-review', command: '/nonexistent/binary', prompt: 'Review this' },
      ctx(tmpDir)
    )
    assert.strictEqual(missing.skipped, true)
    assert.ok(missing.reason.includes('not found'))
  })

  // ---------- Story: crash behavior with explicit model ----------
  it('hard-fails when task has explicit model and reviewer crashes', () => {
    const crashPath = path.join(tmpDir, 'crash.sh')
    fs.writeFileSync(crashPath, '#!/usr/bin/env bash\ncat > /dev/null\nexit 1\n')
    fs.chmodSync(crashPath, 0o755)

    const result = runAgentCheck(
      { name: 'model-crash', command: crashPath, prompt: 'Review this', model: 'opus' },
      ctx(tmpDir)
    )
    assert.strictEqual(result.pass, false, 'Should hard-fail when model is set and reviewer crashes')
    assert.ok(result.reason.includes('model "opus"'), 'Should mention the model')
    assert.ok(result.reason.includes('prove_it signal clear'), 'Should tell agent how to unblock')
    assert.strictEqual(result.skipped, undefined, 'Should not be marked as skipped')
  })

  it('soft-skips crash when no explicit model', () => {
    const crashPath = path.join(tmpDir, 'crash2.sh')
    fs.writeFileSync(crashPath, '#!/usr/bin/env bash\ncat > /dev/null\nexit 1\n')
    fs.chmodSync(crashPath, 0o755)

    const result = runAgentCheck(
      { name: 'no-model-crash', command: crashPath, prompt: 'Review this' },
      ctx(tmpDir)
    )
    assert.strictEqual(result.pass, true, 'Should soft-skip when no model set')
    assert.strictEqual(result.skipped, true, 'Should be marked as skipped')
  })

  it('expands template variables in prompt', () => {
    const { reviewerPath, capturePath } = writeCaptureReviewer(tmpDir, 'captured.txt')
    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Project at {{project_dir}}' },
      ctx(tmpDir)
    )
    assert.ok(fs.readFileSync(capturePath, 'utf8').includes(tmpDir))
  })

  it('fails for unknown template variables and unavailable session vars', () => {
    // Unknown variable
    const unkn = runAgentCheck(
      { name: 'test-review', prompt: 'Review {{bogus_var}}' },
      ctx(tmpDir)
    )
    assert.strictEqual(unkn.pass, false)
    assert.ok(unkn.reason.includes('bogus_var'))

    // session_diff without session
    const sd = runAgentCheck(
      { name: 'test-review', prompt: 'Review {{session_diff}}' },
      ctx(tmpDir)
    )
    assert.strictEqual(sd.pass, false)
    assert.ok(sd.reason.includes('session_id is null'))

    // session_id without session
    const si = runAgentCheck(
      { name: 'test-review', prompt: 'Session: {{session_id}}' },
      ctx(tmpDir)
    )
    assert.strictEqual(si.pass, false)
    assert.ok(si.reason.includes('session_id'))

    // session_id WITH session → passes
    const passPath = writeReviewer(tmpDir, 'pass.sh', 'echo "PASS"')
    const ok = runAgentCheck(
      { name: 'test-review', command: passPath, prompt: 'Session: {{session_id}}' },
      ctx(tmpDir, { sessionId: 'test-session' })
    )
    assert.strictEqual(ok.pass, true)
  })

  it('resolves promptType reference and fails for unknown reference', () => {
    const { reviewerPath, capturePath } = writeCaptureReviewer(tmpDir, 'ref_captured.txt')
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'changed\n')
    spawnSync('git', ['add', 'file.txt'], { cwd: tmpDir })

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'review:commit_quality', promptType: 'reference' },
      ctx(tmpDir)
    )
    assert.strictEqual(result.pass, true)
    assert.ok(fs.readFileSync(capturePath, 'utf8').includes('Test coverage gaps'))

    // Unknown reference → fails
    const unkn = runAgentCheck(
      { name: 'test-review', prompt: 'nonexistent:builtin', promptType: 'reference' },
      ctx(tmpDir)
    )
    assert.strictEqual(unkn.pass, false)
    assert.ok(unkn.reason.includes('unknown prompt reference'))
  })

  // ---------- Story: model precedence ----------
  // task model > context model > hook default > no model (explicit command)
  it('resolves model with correct precedence', () => {
    const shimDir = path.join(tmpDir, 'bin')
    fs.mkdirSync(shimDir, { recursive: true })

    // Shims for claude and codex
    for (const name of ['claude', 'codex']) {
      const p = path.join(shimDir, name)
      fs.writeFileSync(p, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: args=$*"\n')
      fs.chmodSync(p, 0o755)
    }

    const origPath = process.env.PATH
    process.env.PATH = `${shimDir}:${origPath}`

    try {
      // 1. Task-level model wins over configModel
      const r1 = runAgentCheck(
        { name: 'test-review', prompt: 'Review {{project_dir}}', model: 'haiku' },
        ctx(tmpDir, { hookEvent: 'Stop', configModel: 'custom-model' })
      )
      assert.ok(r1.reason.includes('haiku') && !r1.reason.includes('custom-model'),
        'task model should win')

      // 2. configModel used when no task model
      const r2 = runAgentCheck(
        { name: 'test-review', prompt: 'Review {{project_dir}}' },
        ctx(tmpDir, { hookEvent: 'Stop', configModel: 'custom-model' })
      )
      assert.ok(r2.reason.includes('custom-model'), 'configModel should be used')

      // 3. Default model when no task model or configModel
      const r3 = runAgentCheck(
        { name: 'test-review', prompt: 'Review {{project_dir}}' },
        ctx(tmpDir, { hookEvent: 'Stop' })
      )
      assert.ok(r3.reason.includes('haiku'), 'default model for Stop should be haiku')

      // 4. No default model with explicit command
      const explicitPath = writeReviewer(tmpDir, 'custom.sh', 'echo "PASS: args=$*"')
      const r4 = runAgentCheck(
        { name: 'test-review', command: explicitPath, prompt: 'Review {{project_dir}}' },
        ctx(tmpDir, { hookEvent: 'Stop' })
      )
      assert.ok(!r4.reason.includes('--model'), 'no model with explicit command')

      // 5. Codex auto-switch for gpt- models
      const r5 = runAgentCheck(
        { name: 'test-review', prompt: 'Review {{project_dir}}', model: 'gpt-5.3-codex' },
        ctx(tmpDir)
      )
      assert.ok(r5.reason.includes('gpt-5.3-codex'), 'codex model should pass through')
    } finally {
      process.env.PATH = origPath
    }
  })

  // ---------- Story: rule file injection ----------
  // present → injected; missing → fails; absent → unchanged
  it('injects rule file when present, fails when missing, omits when absent', () => {
    const { reviewerPath, capturePath } = writeCaptureReviewer(tmpDir, 'rule_captured.txt')

    // Present: rule file injected
    const ruleDir = path.join(tmpDir, '.claude', 'rules')
    fs.mkdirSync(ruleDir, { recursive: true })
    fs.writeFileSync(path.join(ruleDir, 'testing.md'), 'All code must have tests.\n')

    const r1 = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this', ruleFile: '.claude/rules/testing.md' },
      ctx(tmpDir)
    )
    assert.strictEqual(r1.pass, true)
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes('--- Rules ---'))
    assert.ok(captured.includes('All code must have tests.'))

    // Missing: fails
    const r2 = runAgentCheck(
      { name: 'test-review', prompt: 'Review this', ruleFile: '.claude/rules/nonexistent.md' },
      ctx(tmpDir)
    )
    assert.strictEqual(r2.pass, false)
    assert.ok(r2.reason.includes('ruleFile not found'))

    // Absent: no rules section
    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      ctx(tmpDir)
    )
    assert.ok(!fs.readFileSync(capturePath, 'utf8').includes('--- Rules ---'))
  })

  // ---------- Story: quiet mode ----------
  // PASS suppressed, FAIL logged, SKIP suppressed
  it('quiet mode suppresses PASS and SKIP logs but keeps FAIL', () => {
    const origDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')

    try {
      function readLog (sid) {
        const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sid}.jsonl`)
        return fs.existsSync(logFile)
          ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
          : []
      }

      // PASS: suppressed
      const passPath = writeReviewer(tmpDir, 'qpass.sh', 'echo "PASS: all good"')
      runAgentCheck(
        { name: 'quiet-review', command: passPath, prompt: 'Review this', quiet: true },
        ctx(tmpDir, { sessionId: 'quiet-pass' })
      )
      assert.strictEqual(readLog('quiet-pass').length, 0, 'Quiet PASS: no log entries')

      // FAIL: still logged
      const failPath = writeReviewer(tmpDir, 'qfail.sh', 'echo "FAIL: bad code"')
      const failResult = runAgentCheck(
        { name: 'quiet-review', command: failPath, prompt: 'Review this', quiet: true },
        ctx(tmpDir, { sessionId: 'quiet-fail' })
      )
      assert.strictEqual(failResult.pass, false)
      const failEntries = readLog('quiet-fail')
      assert.ok(failEntries.some(e => e.status === 'FAIL'))
      assert.ok(!failEntries.some(e => e.status === 'RUNNING'))

      // SKIP: suppressed
      const skipPath = writeReviewer(tmpDir, 'qskip.sh', 'echo "SKIP: unrelated changes"')
      runAgentCheck(
        { name: 'quiet-review', command: skipPath, prompt: 'Review this', quiet: true },
        ctx(tmpDir, { sessionId: 'quiet-skip' })
      )
      assert.strictEqual(readLog('quiet-skip').length, 0, 'Quiet SKIP: no log entries')
    } finally {
      if (origDir === undefined) delete process.env.PROVE_IT_DIR
      else process.env.PROVE_IT_DIR = origDir
    }
  })

  it('passes configEnv through to reviewer subprocess', () => {
    const reviewerPath = path.join(tmpDir, 'env_reviewer.sh')
    fs.writeFileSync(reviewerPath, [
      '#!/usr/bin/env bash', 'cat > /dev/null',
      'if [ "$MY_CUSTOM_VAR" = "hello" ]; then echo "PASS: set"; else echo "FAIL: not set"; fi'
    ].join('\n'))
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'env-review', command: reviewerPath, prompt: 'Review this' },
      ctx(tmpDir, { configEnv: { MY_CUSTOM_VAR: 'hello' } })
    )
    assert.strictEqual(result.pass, true)
  })

  // ---------- Story: verbose data in log entries ----------
  it('logs verbose data (prompt, response, model) on PASS, FAIL, and SKIP verdicts', () => {
    const origDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
    const SID = 'test-session-verbose'

    function readLogEntries () {
      const logFile = path.join(tmpDir, 'prove_it_state', 'sessions', `${SID}.jsonl`)
      if (!fs.existsSync(logFile)) return []
      return fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    }

    try {
      // PASS—verbose should have prompt, response, model
      const passPath = writeReviewer(tmpDir, 'v_pass.sh', 'echo "PASS: looks good"')
      runAgentCheck(
        { name: 'verbose-pass', command: passPath, prompt: 'Review {{project_dir}}', model: 'haiku' },
        ctx(tmpDir, { sessionId: SID, hookEvent: 'Stop' })
      )
      const passEntries = readLogEntries().filter(e => e.reviewer === 'verbose-pass')
      const passRunning = passEntries.filter(e => e.status === 'RUNNING')
      const passResult = passEntries.filter(e => e.status === 'PASS')
      assert.strictEqual(passRunning.length, 1)
      assert.strictEqual(passResult.length, 1)
      assert.ok(passResult[0].verbose, 'PASS entry should have verbose data')
      assert.strictEqual(typeof passResult[0].verbose.prompt, 'string')
      assert.ok(passResult[0].verbose.prompt.includes('Review'), 'verbose prompt should contain user prompt')
      assert.strictEqual(passResult[0].verbose.response, 'PASS: looks good')
      assert.strictEqual(passResult[0].verbose.model, 'haiku')
      assert.strictEqual(passResult[0].verbose.backchannel, false)
      assert.strictEqual(passRunning[0].verbose, undefined, 'RUNNING entry should not have verbose data')

      // FAIL—verbose should have prompt, response, model
      const failPath = writeReviewer(tmpDir, 'v_fail.sh', 'echo "FAIL: missing tests"')
      runAgentCheck(
        { name: 'verbose-fail', command: failPath, prompt: 'Check tests' },
        ctx(tmpDir, { sessionId: SID, hookEvent: 'Stop' })
      )
      const failEntries = readLogEntries().filter(e => e.reviewer === 'verbose-fail')
      const failResult = failEntries.filter(e => e.status === 'FAIL')
      assert.strictEqual(failResult.length, 1)
      assert.ok(failResult[0].verbose, 'FAIL entry should have verbose data')
      assert.strictEqual(typeof failResult[0].verbose.prompt, 'string')
      assert.strictEqual(failResult[0].verbose.response, 'FAIL: missing tests')

      // SKIP—verbose should have prompt, response, model
      const skipPath = writeReviewer(tmpDir, 'v_skip.sh', 'echo "SKIP: unrelated"')
      runAgentCheck(
        { name: 'verbose-skip', command: skipPath, prompt: 'Review this' },
        ctx(tmpDir, { sessionId: SID, hookEvent: 'Stop' })
      )
      const skipEntries = readLogEntries().filter(e => e.reviewer === 'verbose-skip')
      const skipResult = skipEntries.filter(e => e.status === 'SKIP')
      assert.strictEqual(skipResult.length, 1)
      assert.ok(skipResult[0].verbose, 'SKIP entry should have verbose data')
      assert.strictEqual(skipResult[0].verbose.response, 'SKIP: unrelated')
    } finally {
      if (origDir === undefined) delete process.env.PROVE_IT_DIR
      else process.env.PROVE_IT_DIR = origDir
    }
  })
})

describe('backchannel', () => {
  let tmpDir, origProveItDir
  const sessionId = 'test-session-abc123'

  beforeEach(() => {
    tmpDir = freshRepo()
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ---------- Story: backchannel lifecycle ----------
  // FAIL → created → repeat FAIL → preserved → PASS → cleaned up
  it('lifecycle: created on FAIL, preserved on repeat FAIL, cleaned on PASS/SKIP', () => {
    // FAIL → creates backchannel
    const failPath = writeReviewer(tmpDir, 'fail.sh', 'echo "FAIL: missing tests"')
    runAgentCheck(
      { name: 'test-review', command: failPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId })
    )
    const readmePath = backchannelReadmePath(tmpDir, sessionId, 'test-review')
    assert.ok(fs.existsSync(readmePath))
    const content = fs.readFileSync(readmePath, 'utf8')
    assert.ok(content.includes('missing tests'))
    assert.ok(content.includes('Write your recommendation'))

    // Simulate dev editing backchannel
    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    fs.writeFileSync(path.join(bcDir, 'README.md'), 'Dev response: I am doing planning work\n')

    // Repeat FAIL → dev content preserved
    const fail2Path = writeReviewer(tmpDir, 'fail2.sh', 'echo "FAIL: still missing tests"')
    runAgentCheck(
      { name: 'test-review', command: fail2Path, prompt: 'Review this' },
      ctx(tmpDir, { sessionId })
    )
    const preserved = fs.readFileSync(path.join(bcDir, 'README.md'), 'utf8')
    assert.ok(preserved.includes('Dev response: I am doing planning work'))
    assert.ok(!preserved.includes('still missing tests'))

    // PASS → cleaned up
    const passPath = writeReviewer(tmpDir, 'pass.sh', 'echo "PASS: looks good"')
    runAgentCheck(
      { name: 'test-review', command: passPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId })
    )
    assert.ok(!fs.existsSync(bcDir))

    // Re-create for SKIP cleanup test
    createBackchannel(tmpDir, sessionId, 'test-review', 'some failure')
    const skipPath = writeReviewer(tmpDir, 'skip.sh', 'echo "SKIP: unrelated changes"')
    runAgentCheck(
      { name: 'test-review', command: skipPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId })
    )
    assert.ok(!fs.existsSync(bcDir), 'Cleaned on SKIP')
  })

  // ---------- Story: backchannel prompt injection ----------
  it('injects backchannel into prompt when present, omits when absent', () => {
    const { reviewerPath, capturePath } = writeCaptureReviewer(tmpDir, 'bc_captured.txt')

    // No backchannel → no section
    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId })
    )
    assert.ok(!fs.readFileSync(capturePath, 'utf8').includes('Developer Backchannel'))

    // With backchannel → injected
    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    fs.mkdirSync(bcDir, { recursive: true })
    fs.writeFileSync(path.join(bcDir, 'README.md'), 'I am doing planning work.\n')

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId })
    )
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes('--- Developer Backchannel ---'))
    assert.ok(captured.includes('I am doing planning work'))
    assert.ok(captured.includes('--- End Developer Backchannel ---'))
  })

  // ---------- Story: backchannel logging ----------
  it('logs RUNNING → PASS/FAIL with hookEvent/triggerProgress, and APPEAL when backchannel exists', () => {
    // RUNNING → PASS
    const passPath = writeReviewer(tmpDir, 'pass.sh', 'echo "PASS: all good"')
    runAgentCheck(
      { name: 'test-review', command: passPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId, hookEvent: 'Stop', _triggerProgress: 'linesChanged: 512/500' })
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.strictEqual(entries[0].status, 'RUNNING')
    assert.strictEqual(entries[0].reviewer, 'test-review')
    assert.strictEqual(entries[0].hookEvent, 'Stop')
    assert.strictEqual(entries[0].triggerProgress, 'linesChanged: 512/500')
    assert.strictEqual(entries[1].status, 'PASS')

    // No APPEAL without backchannel
    assert.strictEqual(entries.find(e => e.status === 'APPEAL'), undefined)

    // RUNNING → FAIL
    const sid2 = 'test-session-fail-log'
    const failPath = writeReviewer(tmpDir, 'fail.sh', 'echo "FAIL: bad code"')
    runAgentCheck(
      { name: 'test-review', command: failPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId: sid2 })
    )
    const logFile2 = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sid2}.jsonl`)
    const entries2 = fs.readFileSync(logFile2, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.strictEqual(entries2[0].status, 'RUNNING')
    assert.strictEqual(entries2[entries2.length - 1].status, 'FAIL')

    // APPEAL when backchannel exists
    const sid3 = 'test-session-appeal'
    const bcDir3 = backchannelDir(tmpDir, sid3, 'test-review')
    fs.mkdirSync(bcDir3, { recursive: true })
    fs.writeFileSync(path.join(bcDir3, 'README.md'), 'I am doing planning work.\n')
    runAgentCheck(
      { name: 'test-review', command: passPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId: sid3 })
    )
    const logFile3 = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sid3}.jsonl`)
    const entries3 = fs.readFileSync(logFile3, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const appeal = entries3.find(e => e.status === 'APPEAL')
    assert.ok(appeal)
    assert.strictEqual(appeal.reason, 'appealed via backchannel')
  })

  // ---------- Story: backchannel path sanitization ----------
  it('sanitizes task names with special characters', () => {
    const bc1 = backchannelDir(tmpDir, sessionId, '../etc')
    assert.ok(bc1.includes('.._etc'))
    assert.ok(!bc1.includes('/../'))

    const bc2 = backchannelDir(tmpDir, sessionId, '..')
    assert.ok(!bc2.endsWith('/backchannel/..'))
    assert.ok(bc2.includes('_..'))
  })

  // ---------- Story: backchannel edge cases ----------
  it('handles crash, null sessionId, multi-line reason, and filesystem errors', () => {
    // Crash: backchannel survives
    createBackchannel(tmpDir, sessionId, 'test-review', 'some failure')
    const crashPath = path.join(tmpDir, 'crash.sh')
    fs.writeFileSync(crashPath, '#!/usr/bin/env bash\ncat > /dev/null\nexit 1\n')
    fs.chmodSync(crashPath, 0o755)
    runAgentCheck(
      { name: 'test-review', command: crashPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId })
    )
    assert.ok(fs.existsSync(backchannelReadmePath(tmpDir, sessionId, 'test-review')))

    // Null sessionId: no backchannel
    const failPath = writeReviewer(tmpDir, 'fail_noid.sh', 'echo "FAIL: no tests"')
    const noIdResult = runAgentCheck(
      { name: 'test-review', command: failPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId: null })
    )
    assert.strictEqual(noIdResult.pass, false)
    assert.ok(!noIdResult.reason.includes('backchannel'))

    // FAIL reason includes backchannel path hint
    const failHintPath = writeReviewer(tmpDir, 'fail_hint.sh', 'echo "FAIL: no tests"')
    const hintResult = runAgentCheck(
      { name: 'test-review', command: failHintPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId })
    )
    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    assert.ok(hintResult.reason.includes(bcDir))
    assert.ok(hintResult.reason.includes('README.md'))

    // Multi-line reason is blockquoted
    const reason = 'missing tests for:\n- function foo\n- function bar'
    createBackchannel(tmpDir, sessionId, 'multiline-review', reason)
    const readmePath = backchannelReadmePath(tmpDir, sessionId, 'multiline-review')
    const mlContent = fs.readFileSync(readmePath, 'utf8')
    assert.ok(mlContent.includes('> missing tests for:'))
    assert.ok(mlContent.includes('> - function foo'))

    // Filesystem error: no crash (use a fresh session to avoid conflict)
    const fsSid = 'test-session-fs-error'
    const blockingPath = path.join(tmpDir, '.claude', 'prove_it', 'sessions', fsSid, 'backchannel')
    fs.mkdirSync(path.dirname(blockingPath), { recursive: true })
    fs.writeFileSync(blockingPath, 'not a directory')
    assert.doesNotThrow(() => createBackchannel(tmpDir, fsSid, 'fs-error', 'some failure'))

    // FAIL still returned despite filesystem error
    const failFsPath = writeReviewer(tmpDir, 'fail_fs.sh', 'echo "FAIL: no tests"')
    const fsResult = runAgentCheck(
      { name: 'test-review', command: failFsPath, prompt: 'Review this' },
      ctx(tmpDir, { sessionId: fsSid })
    )
    assert.strictEqual(fsResult.pass, false)
    assert.ok(fsResult.reason.includes('no tests'))
  })
})

describe('defaultModel', () => {
  const cases = [
    ['PreToolUse', false, 'haiku'],
    ['Stop', false, 'haiku'],
    ['pre-commit', false, 'sonnet'],
    ['pre-push', false, 'sonnet'],
    ['SessionStart', false, null],
    ['Stop', true, null],
    ['pre-commit', true, null]
  ]
  cases.forEach(([event, hasCommand, expected]) => {
    it(`${event} ${hasCommand ? '(explicit command)' : ''} → ${expected}`, () => {
      assert.strictEqual(defaultModel(event, hasCommand), expected)
    })
  })
})
