const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  createTestScript,
  makeExecutable,
  writeConfig,
  makeConfig,
  isolatedEnv
} = require('./hook-harness')

/**
 * Reviewer prompt passthrough for the v2 dispatcher.
 *
 * Verifies that agent checks receive the correct diff content in their prompt
 * and that custom reviewer prompts from config are passed through.
 *
 * Uses a mock reviewer script that captures its stdin to a file.
 */

describe('Reviewer prompt passthrough (v2)', () => {
  let tmpDir
  let captureFile

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_reviewer_')
    initGitRepo(tmpDir)

    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })

    createTestScript(tmpDir, true)

    // Create capture file path
    captureFile = path.join(tmpDir, 'reviewer_capture.txt')

    // Create mock reviewer that captures stdin prompt and outputs PASS
    createFile(tmpDir, 'capture_reviewer.sh',
      `#!/usr/bin/env bash\ncat > "${captureFile}"\necho "PASS"\n`)
    makeExecutable(path.join(tmpDir, 'capture_reviewer.sh'))
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  describe('Reviewer receives correct diff content', () => {
    it('commit reviewer receives staged diff in prompt', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          triggers: ['(^|\\s)git\\s+commit\\b'],
          checks: [
            { name: 'full-tests', type: 'script', command: './script/test' },
            {
              name: 'commit-review',
              type: 'agent',
              command: path.join(tmpDir, 'capture_reviewer.sh'),
              prompt: 'Review these staged changes:\n\n{{staged_diff}}'
            }
          ]
        }
      ]))

      // Stage a file so git diff --cached has content
      createFile(tmpDir, 'src/app.js', 'function app() { return 1; }\n')
      spawnSync('git', ['add', 'src/app.js'], { cwd: tmpDir })

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "add app"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(fs.existsSync(captureFile),
        'Capture file should exist (reviewer was called)')

      const captured = fs.readFileSync(captureFile, 'utf8')
      assert.ok(captured.includes('src/app.js'),
        `Reviewer prompt should contain staged file name, got: ${captured.slice(0, 200)}`)
    })
  })

  describe('Custom reviewer prompt from config', () => {
    it('reviewer uses custom prompt template', () => {
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          triggers: ['(^|\\s)git\\s+commit\\b'],
          checks: [
            { name: 'full-tests', type: 'script', command: './script/test' },
            {
              name: 'sql-review',
              type: 'agent',
              command: path.join(tmpDir, 'capture_reviewer.sh'),
              prompt: 'Check for SQL injection only\n\n{{staged_diff}}'
            }
          ]
        }
      ]))

      createFile(tmpDir, 'src/db.js', 'function query(sql) { return sql; }\n')
      spawnSync('git', ['add', 'src/db.js'], { cwd: tmpDir })

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "add db"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(fs.existsSync(captureFile),
        'Capture file should exist (reviewer was called)')

      const captured = fs.readFileSync(captureFile, 'utf8')
      assert.ok(captured.includes('Check for SQL injection only'),
        `Reviewer prompt should contain custom prompt text, got: ${captured.slice(0, 200)}`)
    })
  })

  describe('Reviewer failure denies commit', () => {
    it('denies commit when reviewer returns FAIL', () => {
      // Create a failing reviewer
      createFile(tmpDir, 'fail_reviewer.sh',
        '#!/usr/bin/env bash\ncat > /dev/null\necho "FAIL: untested code"\n')
      makeExecutable(path.join(tmpDir, 'fail_reviewer.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          triggers: ['(^|\\s)git\\s+commit\\b'],
          checks: [
            { name: 'full-tests', type: 'script', command: './script/test' },
            {
              name: 'commit-review',
              type: 'agent',
              command: path.join(tmpDir, 'fail_reviewer.sh'),
              prompt: 'Review these changes:\n\n{{staged_diff}}'
            }
          ]
        }
      ]))

      createFile(tmpDir, 'src/new.js', 'function untested() {}\n')
      spawnSync('git', ['add', 'src/new.js'], { cwd: tmpDir })

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "add untested"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce output when reviewer fails')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'deny',
        'Should deny when reviewer returns FAIL'
      )
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('untested code'),
        'Denial reason should include reviewer feedback'
      )
    })
  })
})
