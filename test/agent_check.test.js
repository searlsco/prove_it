const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { defaultModel, runAgentCheck, backchannelDir, backchannelReadmePath, createBackchannel } = require('../lib/checks/agent')

describe('agent check', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_agent_test_'))
    spawnSync('git', ['init'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when reviewer returns PASS', () => {
    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review {{project_dir}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
  })

  it('fails when reviewer returns FAIL', () => {
    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: untested code"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, false)
    assert.ok(result.reason.includes('untested code'))
  })

  it('skips when prompt is empty after expansion', () => {
    const result = runAgentCheck(
      { name: 'test-review', command: 'claude -p', prompt: '' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
    assert.strictEqual(result.skipped, true)
  })

  it('skips when prompt is null', () => {
    const result = runAgentCheck(
      { name: 'test-review', command: 'claude -p', prompt: null },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
    assert.strictEqual(result.skipped, true)
  })

  it('returns skipped when reviewer returns SKIP', () => {
    const reviewerPath = path.join(tmpDir, 'skip_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "SKIP: changes are unrelated"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review {{project_dir}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
    assert.strictEqual(result.skipped, true)
    assert.strictEqual(result.reason, 'changes are unrelated')
  })

  it('expands template variables in prompt', () => {
    const capturePath = path.join(tmpDir, 'captured.txt')
    const reviewerPath = path.join(tmpDir, 'capture_reviewer.sh')
    fs.writeFileSync(reviewerPath, `#!/usr/bin/env bash\ncat > "${capturePath}"\necho "PASS"\n`)
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Project at {{project_dir}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )

    assert.ok(fs.existsSync(capturePath), 'Should have captured stdin')
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes(tmpDir), `Prompt should contain expanded project_dir, got: ${captured}`)
  })

  it('passes with warning when reviewer binary not found', () => {
    const result = runAgentCheck(
      { name: 'test-review', command: '/nonexistent/binary', prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
    assert.strictEqual(result.skipped, true)
    assert.ok(result.reason.includes('not found'),
      `Reason should mention binary not found, got: ${result.reason}`)
  })

  it('resolves promptType reference to builtin prompt', () => {
    const reviewerPath = path.join(tmpDir, 'capture_reviewer.sh')
    const capturePath = path.join(tmpDir, 'captured.txt')
    fs.writeFileSync(reviewerPath, `#!/usr/bin/env bash\ncat > "${capturePath}"\necho "PASS"\n`)
    fs.chmodSync(reviewerPath, 0o755)

    // Stage a change so staged_diff is non-empty
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'changed\n')
    spawnSync('git', ['add', 'file.txt'], { cwd: tmpDir })

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'review:commit_quality', promptType: 'reference' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
    // Verify the builtin prompt was used (contains staged_diff expansion)
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes('Test coverage gaps'),
      `Should contain builtin prompt text, got: ${captured.substring(0, 200)}`)
  })

  it('fails with error for unknown prompt reference', () => {
    const result = runAgentCheck(
      { name: 'test-review', prompt: 'nonexistent:builtin', promptType: 'reference' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, false)
    assert.ok(result.reason.includes('unknown prompt reference'),
      `Should mention unknown reference, got: ${result.reason}`)
  })

  it('fails with error for unknown template variables in custom prompt', () => {
    const result = runAgentCheck(
      { name: 'test-review', prompt: 'Review {{bogus_var}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, false)
    assert.ok(result.reason.includes('unknown template variable'),
      `Should mention unknown template variable, got: ${result.reason}`)
    assert.ok(result.reason.includes('bogus_var'),
      `Should name the unknown variable, got: ${result.reason}`)
  })

  it('fails when prompt uses session_diff but sessionId is null', () => {
    const result = runAgentCheck(
      { name: 'test-review', prompt: 'Review {{session_diff}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, false)
    assert.ok(result.reason.includes('session_diff'),
      `Should name the unavailable var, got: ${result.reason}`)
    assert.ok(result.reason.includes('session_id is null'),
      `Should explain why, got: ${result.reason}`)
  })

  it('fails when prompt uses session_id but sessionId is null', () => {
    const result = runAgentCheck(
      { name: 'test-review', prompt: 'Session: {{session_id}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, false)
    assert.ok(result.reason.includes('session_id'),
      `Should name the unavailable var, got: ${result.reason}`)
  })

  it('passes model through to reviewer config', () => {
    // Create a shim named 'claude' that echoes its args so we can verify --model
    const shimPath = path.join(tmpDir, 'claude')
    fs.writeFileSync(shimPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: args=$*"\n')
    fs.chmodSync(shimPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: `${shimPath} -p`, prompt: 'Review {{project_dir}}', model: 'haiku' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
    assert.ok(result.reason.includes('--model') && result.reason.includes('haiku'),
      `Expected --model haiku in reviewer output, got: ${result.reason}`)
  })

  it('passes null command when check has no command (lets reviewer pick default)', () => {
    // Create a 'codex' shim so the auto-switch for gpt- models works end-to-end
    const shimDir = path.join(tmpDir, 'bin')
    fs.mkdirSync(shimDir, { recursive: true })
    const shimPath = path.join(shimDir, 'codex')
    fs.writeFileSync(shimPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: args=$*"\n')
    fs.chmodSync(shimPath, 0o755)

    const origPath = process.env.PATH
    process.env.PATH = `${shimDir}:${origPath}`

    const result = runAgentCheck(
      { name: 'test-review', prompt: 'Review {{project_dir}}', model: 'gpt-5.3-codex' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )

    process.env.PATH = origPath

    assert.strictEqual(result.pass, true)
    assert.ok(result.reason.includes('--model') && result.reason.includes('gpt-5.3-codex'),
      `Expected codex auto-switch with --model, got: ${result.reason}`)
  })

  it('uses context.configModel when task has no model', () => {
    const shimDir = path.join(tmpDir, 'bin')
    fs.mkdirSync(shimDir, { recursive: true })
    const shimPath = path.join(shimDir, 'claude')
    fs.writeFileSync(shimPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: args=$*"\n')
    fs.chmodSync(shimPath, 0o755)

    const origPath = process.env.PATH
    process.env.PATH = `${shimDir}:${origPath}`

    const result = runAgentCheck(
      { name: 'test-review', prompt: 'Review {{project_dir}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, hookEvent: 'Stop', testOutput: '', configModel: 'custom-model' }
    )

    process.env.PATH = origPath

    assert.strictEqual(result.pass, true)
    assert.ok(result.reason.includes('--model') && result.reason.includes('custom-model'),
      `Expected --model custom-model from configModel, got: ${result.reason}`)
  })

  it('task-level model overrides context.configModel', () => {
    const shimDir = path.join(tmpDir, 'bin')
    fs.mkdirSync(shimDir, { recursive: true })
    const shimPath = path.join(shimDir, 'claude')
    fs.writeFileSync(shimPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: args=$*"\n')
    fs.chmodSync(shimPath, 0o755)

    const origPath = process.env.PATH
    process.env.PATH = `${shimDir}:${origPath}`

    const result = runAgentCheck(
      { name: 'test-review', prompt: 'Review {{project_dir}}', model: 'haiku' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, hookEvent: 'Stop', testOutput: '', configModel: 'custom-model' }
    )

    process.env.PATH = origPath

    assert.strictEqual(result.pass, true)
    assert.ok(result.reason.includes('--model') && result.reason.includes('haiku'),
      `Expected task-level --model haiku to win over configModel, got: ${result.reason}`)
    assert.ok(!result.reason.includes('custom-model'),
      `configModel should not appear when task-level model is set, got: ${result.reason}`)
  })

  it('uses default model for hook event when no model or command set', () => {
    // Create a 'claude' shim that echoes args so we can see --model
    const shimDir = path.join(tmpDir, 'bin')
    fs.mkdirSync(shimDir, { recursive: true })
    const shimPath = path.join(shimDir, 'claude')
    fs.writeFileSync(shimPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: args=$*"\n')
    fs.chmodSync(shimPath, 0o755)

    const origPath = process.env.PATH
    process.env.PATH = `${shimDir}:${origPath}`

    const result = runAgentCheck(
      { name: 'test-review', prompt: 'Review {{project_dir}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, hookEvent: 'Stop', testOutput: '' }
    )

    process.env.PATH = origPath

    assert.strictEqual(result.pass, true)
    assert.ok(result.reason.includes('--model') && result.reason.includes('haiku'),
      `Expected default --model haiku for Stop, got: ${result.reason}`)
  })

  it('does not apply default model when explicit command is set', () => {
    const reviewerPath = path.join(tmpDir, 'custom_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: args=$*"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review {{project_dir}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, hookEvent: 'Stop', testOutput: '' }
    )

    assert.strictEqual(result.pass, true)
    assert.ok(!result.reason.includes('--model'),
      `Expected no --model with explicit command, got: ${result.reason}`)
  })

  it('injects rule file contents into prompt', () => {
    const capturePath = path.join(tmpDir, 'captured.txt')
    const reviewerPath = path.join(tmpDir, 'capture_reviewer.sh')
    fs.writeFileSync(reviewerPath, `#!/usr/bin/env bash\ncat > "${capturePath}"\necho "PASS"\n`)
    fs.chmodSync(reviewerPath, 0o755)

    const ruleDir = path.join(tmpDir, '.claude', 'rules')
    fs.mkdirSync(ruleDir, { recursive: true })
    fs.writeFileSync(path.join(ruleDir, 'testing.md'), 'All code must have tests.\n')

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this', ruleFile: '.claude/rules/testing.md' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes('--- Rules ---'), 'Should contain rules section header')
    assert.ok(captured.includes('All code must have tests.'), 'Should contain rule file contents')
    assert.ok(captured.includes('--- End Rules ---'), 'Should contain rules section footer')
  })

  it('fails when ruleFile is missing', () => {
    const result = runAgentCheck(
      { name: 'test-review', prompt: 'Review this', ruleFile: '.claude/rules/nonexistent.md' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, false)
    assert.ok(result.reason.includes('ruleFile not found'),
      `Should mention ruleFile not found, got: ${result.reason}`)
    assert.ok(result.reason.includes('.claude/rules/nonexistent.md'),
      `Should include the path, got: ${result.reason}`)
  })

  it('prompt is unchanged when no ruleFile is set', () => {
    const capturePath = path.join(tmpDir, 'captured.txt')
    const reviewerPath = path.join(tmpDir, 'capture_reviewer.sh')
    fs.writeFileSync(reviewerPath, `#!/usr/bin/env bash\ncat > "${capturePath}"\necho "PASS"\n`)
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(!captured.includes('--- Rules ---'), 'Should not contain rules section when no ruleFile')
  })

  it('allows session vars when sessionId is present', () => {
    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Session: {{session_id}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: 'test-session', toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
  })

  it('suppresses PASS and RUNNING log when quiet: true', () => {
    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: all good"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const origDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
    const sid = 'test-session-quiet-agent'

    const result = runAgentCheck(
      { name: 'quiet-review', command: reviewerPath, prompt: 'Review this', quiet: true },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: sid, toolInput: null, testOutput: '' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sid}.jsonl`)
    const entries = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      : []

    if (origDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origDir

    assert.strictEqual(result.pass, true)
    assert.strictEqual(entries.length, 0, 'Quiet agent pass should produce no log entries')
  })

  it('still logs FAIL when quiet: true', () => {
    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: bad code"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const origDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
    const sid = 'test-session-quiet-agent-fail'

    const result = runAgentCheck(
      { name: 'quiet-review', command: reviewerPath, prompt: 'Review this', quiet: true },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: sid, toolInput: null, testOutput: '' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sid}.jsonl`)
    const entries = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      : []

    if (origDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origDir

    assert.strictEqual(result.pass, false)
    assert.ok(entries.some(e => e.status === 'FAIL'), 'Quiet agent fail should still log FAIL')
    assert.ok(!entries.some(e => e.status === 'RUNNING'), 'Quiet agent should not log RUNNING')
  })

  it('suppresses SKIP log when quiet: true', () => {
    const reviewerPath = path.join(tmpDir, 'skip_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "SKIP: unrelated changes"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const origDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
    const sid = 'test-session-quiet-agent-skip'

    const result = runAgentCheck(
      { name: 'quiet-review', command: reviewerPath, prompt: 'Review this', quiet: true },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: sid, toolInput: null, testOutput: '' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sid}.jsonl`)
    const entries = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      : []

    if (origDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origDir

    assert.strictEqual(result.skipped, true)
    assert.strictEqual(entries.length, 0, 'Quiet agent skip should produce no log entries')
  })

  it('passes configEnv through to reviewer subprocess', () => {
    const reviewerPath = path.join(tmpDir, 'env_reviewer.sh')
    fs.writeFileSync(reviewerPath, [
      '#!/usr/bin/env bash',
      'cat > /dev/null',
      'if [ "$MY_CUSTOM_VAR" = "hello" ]; then',
      '  echo "PASS: MY_CUSTOM_VAR is set"',
      'else',
      '  echo "FAIL: MY_CUSTOM_VAR was not set"',
      'fi'
    ].join('\n'))
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'env-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '', configEnv: { MY_CUSTOM_VAR: 'hello' } }
    )
    assert.strictEqual(result.pass, true, `Expected configEnv to reach reviewer, got: ${result.reason || result.error}`)
  })
})

describe('backchannel', () => {
  let tmpDir
  let origProveItDir
  const sessionId = 'test-session-abc123'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_bc_test_'))
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
    spawnSync('git', ['init'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (origProveItDir === undefined) {
      delete process.env.PROVE_IT_DIR
    } else {
      process.env.PROVE_IT_DIR = origProveItDir
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates backchannel README on FAIL', () => {
    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: missing tests"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const readmePath = backchannelReadmePath(tmpDir, sessionId, 'test-review')
    assert.ok(fs.existsSync(readmePath), 'Backchannel README should exist after FAIL')
    const content = fs.readFileSync(readmePath, 'utf8')
    assert.ok(content.includes('missing tests'), 'README should contain failure reason')
    assert.ok(content.includes('Write your recommendation'), 'README should contain instructions')
  })

  it('does not overwrite backchannel on repeated FAIL', () => {
    // Pre-create backchannel with dev content
    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    fs.mkdirSync(bcDir, { recursive: true })
    fs.writeFileSync(path.join(bcDir, 'README.md'), 'Dev response: I am doing planning work\n')

    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: still missing tests"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const content = fs.readFileSync(path.join(bcDir, 'README.md'), 'utf8')
    assert.ok(content.includes('Dev response: I am doing planning work'),
      'Original dev content should be preserved')
    assert.ok(!content.includes('still missing tests'),
      'New failure reason should NOT overwrite existing content')
  })

  it('cleans backchannel on PASS', () => {
    // Pre-create backchannel
    createBackchannel(tmpDir, sessionId, 'test-review', 'some failure')

    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: looks good"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    assert.ok(!fs.existsSync(bcDir), 'Backchannel dir should be removed after PASS')
  })

  it('cleans backchannel on SKIP', () => {
    // Pre-create backchannel
    createBackchannel(tmpDir, sessionId, 'test-review', 'some failure')

    const reviewerPath = path.join(tmpDir, 'skip_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "SKIP: unrelated changes"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    assert.ok(!fs.existsSync(bcDir), 'Backchannel dir should be removed after SKIP')
  })

  it('injects backchannel content into reviewer prompt', () => {
    // Pre-create backchannel with dev content
    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    fs.mkdirSync(bcDir, { recursive: true })
    fs.writeFileSync(path.join(bcDir, 'README.md'), 'I am doing planning work, not writing code.\n')

    const capturePath = path.join(tmpDir, 'captured.txt')
    const reviewerPath = path.join(tmpDir, 'capture_reviewer.sh')
    fs.writeFileSync(reviewerPath, `#!/usr/bin/env bash\ncat > "${capturePath}"\necho "PASS: acknowledged"\n`)
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes('--- Developer Backchannel ---'),
      'Prompt should contain backchannel header')
    assert.ok(captured.includes('I am doing planning work'),
      'Prompt should contain backchannel content')
    assert.ok(captured.includes('--- End Developer Backchannel ---'),
      'Prompt should contain backchannel footer')
  })

  it('logs RUNNING entry before reviewer execution', () => {
    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: all good"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
    assert.ok(fs.existsSync(logFile), `Log file should exist at ${logFile}`)
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.strictEqual(entries.length, 2)
    assert.strictEqual(entries[0].status, 'RUNNING')
    assert.strictEqual(entries[0].reviewer, 'test-review')
    assert.strictEqual(entries[1].status, 'PASS')
    assert.strictEqual(entries[1].reviewer, 'test-review')
  })

  it('logs RUNNING then FAIL when reviewer fails', () => {
    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: bad code"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.strictEqual(entries[0].status, 'RUNNING')
    assert.strictEqual(entries[entries.length - 1].status, 'FAIL')
  })

  it('includes hookEvent in RUNNING entry', () => {
    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '', hookEvent: 'Stop' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const running = entries.find(e => e.status === 'RUNNING')
    assert.ok(running, 'Should have a RUNNING entry')
    assert.strictEqual(running.hookEvent, 'Stop')
  })

  it('includes triggerProgress in RUNNING entry when present on context', () => {
    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '', _triggerProgress: 'linesChanged: 512/500' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const running = entries.find(e => e.status === 'RUNNING')
    assert.ok(running, 'Should have a RUNNING entry')
    assert.strictEqual(running.triggerProgress, 'linesChanged: 512/500')
  })

  it('logs APPEAL entry when backchannel exists', () => {
    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    fs.mkdirSync(bcDir, { recursive: true })
    fs.writeFileSync(path.join(bcDir, 'README.md'), 'I am doing planning work.\n')

    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS: acknowledged"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
    assert.ok(fs.existsSync(logFile), `Log file should exist at ${logFile}`)
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const appealEntry = entries.find(e => e.status === 'APPEAL')
    assert.ok(appealEntry, 'Should have an APPEAL entry')
    assert.strictEqual(appealEntry.reviewer, 'test-review')
    assert.strictEqual(appealEntry.reason, 'appealed via backchannel')
  })

  it('does not log APPEAL when no backchannel exists', () => {
    const reviewerPath = path.join(tmpDir, 'pass_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS"\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
    assert.ok(fs.existsSync(logFile), `Log file should exist at ${logFile}`)
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const appealEntry = entries.find(e => e.status === 'APPEAL')
    assert.strictEqual(appealEntry, undefined, 'Should not have an APPEAL entry')
  })

  it('no backchannel section in prompt when none exists', () => {
    const capturePath = path.join(tmpDir, 'captured.txt')
    const reviewerPath = path.join(tmpDir, 'capture_reviewer.sh')
    fs.writeFileSync(reviewerPath, `#!/usr/bin/env bash\ncat > "${capturePath}"\necho "PASS"\n`)
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(!captured.includes('Developer Backchannel'),
      'Prompt should not contain backchannel section when none exists')
  })

  it('backchannel survives crash', () => {
    // Pre-create backchannel
    createBackchannel(tmpDir, sessionId, 'test-review', 'some failure')

    const reviewerPath = path.join(tmpDir, 'crash_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\nexit 1\n')
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    const readmePath = backchannelReadmePath(tmpDir, sessionId, 'test-review')
    assert.ok(fs.existsSync(readmePath), 'Backchannel should survive reviewer crash')
  })

  it('FAIL reason includes backchannel path hint', () => {
    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: no tests"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    assert.strictEqual(result.pass, false)
    const bcDir = backchannelDir(tmpDir, sessionId, 'test-review')
    assert.ok(result.reason.includes(bcDir),
      `Reason should include backchannel path, got: ${result.reason}`)
    assert.ok(result.reason.includes('README.md'),
      `Reason should mention README.md, got: ${result.reason}`)
  })

  it('skips backchannel entirely when sessionId is null', () => {
    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: no tests"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )

    assert.strictEqual(result.pass, false)
    // No backchannel dir should be created
    const sessionsDir = path.join(tmpDir, '.claude', 'prove_it', 'sessions')
    assert.ok(!fs.existsSync(sessionsDir),
      'No sessions dir should be created when sessionId is null')
    // No backchannel hint in reason
    assert.ok(!result.reason.includes('backchannel'),
      `Reason should not mention backchannel when sessionId is null, got: ${result.reason}`)
  })

  it('multi-line failure reason is fully blockquoted in README', () => {
    const reason = 'missing tests for:\n- function foo\n- function bar'
    createBackchannel(tmpDir, sessionId, 'multiline-review', reason)

    const readmePath = backchannelReadmePath(tmpDir, sessionId, 'multiline-review')
    const content = fs.readFileSync(readmePath, 'utf8')
    assert.ok(content.includes('> missing tests for:'), 'First line should be blockquoted')
    assert.ok(content.includes('> - function foo'), 'Second line should be blockquoted')
    assert.ok(content.includes('> - function bar'), 'Third line should be blockquoted')
  })

  it('sanitizes task name with path traversal characters', () => {
    const bcDir = backchannelDir(tmpDir, sessionId, '../etc')
    assert.ok(bcDir.includes('.._etc'), `Path traversal should be sanitized, got: ${bcDir}`)
    assert.ok(!bcDir.includes('/../'), `Should not contain literal /../, got: ${bcDir}`)
  })

  it('sanitizes bare .. task name to prevent parent traversal', () => {
    const bcDir = backchannelDir(tmpDir, sessionId, '..')
    assert.ok(!bcDir.endsWith('/backchannel/..'),
      `Should not resolve to parent, got: ${bcDir}`)
    assert.ok(bcDir.includes('_..'), `Should prefix with _, got: ${bcDir}`)
  })

  it('createBackchannel does not crash on filesystem errors', () => {
    // Place a file where the directory would need to be created
    const blockingPath = path.join(tmpDir, '.claude', 'prove_it', 'sessions', sessionId, 'backchannel')
    fs.mkdirSync(path.dirname(blockingPath), { recursive: true })
    fs.writeFileSync(blockingPath, 'not a directory')

    // Should not throw — best-effort operation
    assert.doesNotThrow(() => {
      createBackchannel(tmpDir, sessionId, 'test-review', 'some failure')
    })
  })

  it('FAIL result is still returned when createBackchannel hits filesystem error', () => {
    // Place a file where the backchannel directory would go
    const blockingPath = path.join(tmpDir, '.claude', 'prove_it', 'sessions', sessionId, 'backchannel')
    fs.mkdirSync(path.dirname(blockingPath), { recursive: true })
    fs.writeFileSync(blockingPath, 'not a directory')

    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: no tests"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId, toolInput: null, testOutput: '' }
    )

    assert.strictEqual(result.pass, false, 'Should still return FAIL result')
    assert.ok(result.reason.includes('no tests'), 'Should still include failure reason')
  })
})

describe('defaultModel', () => {
  it('returns haiku for PreToolUse', () => {
    assert.strictEqual(defaultModel('PreToolUse', false), 'haiku')
  })

  it('returns haiku for Stop', () => {
    assert.strictEqual(defaultModel('Stop', false), 'haiku')
  })

  it('returns sonnet for pre-commit', () => {
    assert.strictEqual(defaultModel('pre-commit', false), 'sonnet')
  })

  it('returns sonnet for pre-push', () => {
    assert.strictEqual(defaultModel('pre-push', false), 'sonnet')
  })

  it('returns null for unknown events', () => {
    assert.strictEqual(defaultModel('SessionStart', false), null)
  })

  it('returns null when explicit command is set', () => {
    assert.strictEqual(defaultModel('Stop', true), null)
    assert.strictEqual(defaultModel('pre-commit', true), null)
  })
})
