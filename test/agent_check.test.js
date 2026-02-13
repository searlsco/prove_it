const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { defaultModel, runAgentCheck } = require('../lib/checks/agent')

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
