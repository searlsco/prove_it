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
  setupSessionWithDiffs
} = require('./hook-harness')

/**
 * GAPs 10, 12: Reviewer prompt passthrough.
 *
 * Verifies that the reviewer receives the correct diff content in its prompt
 * and that custom reviewer prompts from config are passed through.
 *
 * Uses a mock reviewer script that captures its arguments to a file.
 */

describe('Reviewer prompt passthrough', () => {
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
      `#!/bin/bash\ncat > "${captureFile}"\necho "PASS"\n`)
    makeExecutable(path.join(tmpDir, 'capture_reviewer.sh'))
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  function isolatedEnv () {
    return {
      HOME: tmpDir,
      PROVE_IT_DIR: path.join(tmpDir, '.prove_it_test')
    }
  }

  // ──── GAP 10: Reviewer gets correct diff ────

  describe('Reviewer receives correct diff content', () => {
    it('done reviewer receives staged diff in prompt', () => {
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        hooks: {
          done: {
            reviewer: {
              enabled: true,
              command: `${path.join(tmpDir, 'capture_reviewer.sh')}`
            }
          }
        }
      }))

      // Stage a file so git diff --cached has content
      createFile(tmpDir, 'src/app.js', 'function app() { return 1; }\n')
      spawnSync('git', ['add', 'src/app.js'], { cwd: tmpDir })

      const result = invokeHook('prove_it_done.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "add app"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(fs.existsSync(captureFile),
        'Capture file should exist (reviewer was called)')

      const captured = fs.readFileSync(captureFile, 'utf8')
      assert.ok(captured.includes('src/app.js'),
        `Reviewer prompt should contain staged file name, got: ${captured.slice(0, 200)}`)
    })

    it('stop reviewer receives session diffs in prompt', () => {
      const sessionId = 'test-reviewer-diff'
      setupSessionWithDiffs(tmpDir, sessionId, tmpDir)

      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        hooks: {
          stop: {
            reviewer: {
              enabled: true,
              command: `${path.join(tmpDir, 'capture_reviewer.sh')}`
            }
          }
        }
      }))

      // Create test_fast so stop hook has something to run
      createFile(tmpDir, 'script/test_fast', '#!/bin/bash\nexit 0\n')
      makeExecutable(path.join(tmpDir, 'script', 'test_fast'))

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(fs.existsSync(captureFile),
        'Capture file should exist (reviewer was called)')

      const captured = fs.readFileSync(captureFile, 'utf8')
      assert.ok(captured.includes('feature.js'),
        `Reviewer prompt should contain diff file name, got: ${captured.slice(0, 200)}`)
    })
  })

  // ──── GAP 12: Custom reviewer prompt ────

  describe('Custom reviewer prompt from config', () => {
    it('done reviewer uses custom prompt from config', () => {
      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        hooks: {
          done: {
            reviewer: {
              enabled: true,
              command: `${path.join(tmpDir, 'capture_reviewer.sh')}`,
              prompt: 'Check for SQL injection only'
            }
          }
        }
      }))

      createFile(tmpDir, 'src/db.js', 'function query(sql) { return sql; }\n')
      spawnSync('git', ['add', 'src/db.js'], { cwd: tmpDir })

      const result = invokeHook('prove_it_done.js', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "add db"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(fs.existsSync(captureFile),
        'Capture file should exist (reviewer was called)')

      const captured = fs.readFileSync(captureFile, 'utf8')
      assert.ok(captured.includes('Check for SQL injection only'),
        `Reviewer prompt should contain custom prompt text, got: ${captured.slice(0, 200)}`)
    })

    it('stop reviewer uses custom prompt from config', () => {
      const sessionId = 'test-custom-prompt'
      setupSessionWithDiffs(tmpDir, sessionId, tmpDir)

      createFile(tmpDir, '.claude/prove_it.json', JSON.stringify({
        hooks: {
          stop: {
            reviewer: {
              enabled: true,
              command: `${path.join(tmpDir, 'capture_reviewer.sh')}`,
              prompt: 'Check for SQL injection only'
            }
          }
        }
      }))

      createFile(tmpDir, 'script/test_fast', '#!/bin/bash\nexit 0\n')
      makeExecutable(path.join(tmpDir, 'script', 'test_fast'))

      const result = invokeHook('prove_it_stop.js', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv() })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(fs.existsSync(captureFile),
        'Capture file should exist (reviewer was called)')

      const captured = fs.readFileSync(captureFile, 'utf8')
      assert.ok(captured.includes('Check for SQL injection only'),
        `Reviewer prompt should contain custom prompt text, got: ${captured.slice(0, 200)}`)
    })
  })
})
