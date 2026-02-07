const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { runAgentCheck } = require('../lib/checks/agent')

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
    fs.writeFileSync(reviewerPath, '#!/bin/bash\ncat > /dev/null\necho "PASS"\n')
    fs.chmodSync(reviewerPath, 0o755)

    const result = runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Review {{project_dir}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, true)
  })

  it('fails when reviewer returns FAIL', () => {
    const reviewerPath = path.join(tmpDir, 'fail_reviewer.sh')
    fs.writeFileSync(reviewerPath, '#!/bin/bash\ncat > /dev/null\necho "FAIL: untested code"\n')
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
    fs.writeFileSync(reviewerPath, `#!/bin/bash\ncat > "${capturePath}"\necho "PASS"\n`)
    fs.chmodSync(reviewerPath, 0o755)

    runAgentCheck(
      { name: 'test-review', command: reviewerPath, prompt: 'Project at {{project_dir}}' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )

    assert.ok(fs.existsSync(capturePath), 'Should have captured stdin')
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes(tmpDir), `Prompt should contain expanded project_dir, got: ${captured}`)
  })

  it('fails when reviewer binary not found', () => {
    const result = runAgentCheck(
      { name: 'test-review', command: '/nonexistent/binary', prompt: 'Review this' },
      { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, testOutput: '' }
    )
    assert.strictEqual(result.pass, false)
  })
})
