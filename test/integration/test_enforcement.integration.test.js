const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createTestScript
} = require('./hook-harness')

describe('prove_it_done.js integration', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_test_')
    initGitRepo(tmpDir)
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  describe('PreToolUse event', () => {
    describe('commands that require tests', () => {
      it('runs tests at hook time and allows commit when tests pass', () => {
        createTestScript(tmpDir, true)

        const result = invokeHook(
          'prove_it_done.js',
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "test"' },
            cwd: tmpDir
          },
          { projectDir: tmpDir }
        )

        assert.strictEqual(result.exitCode, 0)
        assert.ok(result.output, 'Should produce JSON output')
        assert.ok(result.output.hookSpecificOutput, 'Should have hookSpecificOutput')
        assert.ok(
          result.output.hookSpecificOutput.permissionDecisionReason.includes('tests passed'),
          'Should report tests passed'
        )
        assert.ok(
          !result.output.hookSpecificOutput.updatedInput,
          'Command should not be modified when tests pass'
        )
      })

      it('does not require tests for git push by default', () => {
        // git push is no longer blocked by default - commit already runs full tests
        const result = invokeHook(
          'prove_it_done.js',
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'git push origin main' },
            cwd: tmpDir
          },
          { projectDir: tmpDir }
        )

        assert.strictEqual(result.exitCode, 0)
        assert.strictEqual(result.output, null, 'Should not require tests for git push')
      })

      it('does not wrap bd done by default', () => {
        createTestScript(tmpDir, true)

        const result = invokeHook(
          'prove_it_done.js',
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'bd done 123' },
            cwd: tmpDir
          },
          { projectDir: tmpDir }
        )

        assert.strictEqual(result.exitCode, 0)
        assert.strictEqual(result.output, null, 'bd done should not trigger tests by default')
      })
    })

    describe("commands that don't require tests", () => {
      it('ignores git status', () => {
        const result = invokeHook(
          'prove_it_done.js',
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'git status' },
            cwd: tmpDir
          },
          { projectDir: tmpDir }
        )

        assert.strictEqual(result.exitCode, 0)
        assert.strictEqual(result.output, null, "Should not produce output for commands that don't require tests")
      })

      it('ignores npm test', () => {
        const result = invokeHook(
          'prove_it_done.js',
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            cwd: tmpDir
          },
          { projectDir: tmpDir }
        )

        assert.strictEqual(result.exitCode, 0)
        assert.strictEqual(result.output, null)
      })

      it('ignores non-Bash tools', () => {
        const result = invokeHook(
          'prove_it_done.js',
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Edit',
            tool_input: { file_path: '/some/file.js' },
            cwd: tmpDir
          },
          { projectDir: tmpDir }
        )

        assert.strictEqual(result.exitCode, 0)
        assert.strictEqual(result.output, null)
      })
    })

    describe('test script missing', () => {
      it('blocks with helpful error when test script required but missing', () => {
        // Don't create test script

        const result = invokeHook(
          'prove_it_done.js',
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "test"' },
            cwd: tmpDir
          },
          { projectDir: tmpDir }
        )

        assert.strictEqual(result.exitCode, 0)
        assert.ok(result.output, 'Should produce output')
        assert.ok(result.output.hookSpecificOutput, 'Should have hookSpecificOutput')
        assert.strictEqual(
          result.output.hookSpecificOutput.permissionDecision,
          'deny',
          'Should deny when test script is missing'
        )
        assert.ok(
          result.output.hookSpecificOutput.permissionDecisionReason.includes('Test script not found'),
          'Should explain test script is missing'
        )
      })
    })
  })

  describe('fail-closed behavior', () => {
    it('blocks when input JSON is invalid', () => {
      // This tests the fail-closed behavior - invalid input should block, not silently pass
      const { spawnSync } = require('child_process')
      const path = require('path')

      const hookPath = path.join(__dirname, '..', '..', 'lib', 'hooks', 'prove_it_done.js')

      const result = spawnSync('node', [hookPath], {
        input: 'not valid json {{{',
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
      })

      assert.strictEqual(result.status, 0)
      assert.ok(result.stdout, 'Should produce output')

      const output = JSON.parse(result.stdout)
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny', 'Should deny on invalid input')
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('Failed to parse'), 'Should explain the parse failure')
    })
  })

  describe('shell escaping', () => {
    it('safely handles paths with special characters', () => {
      // Create a directory with special characters
      const fs = require('fs')
      const path = require('path')
      const specialDir = path.join(tmpDir, "path with 'quotes' and spaces")
      fs.mkdirSync(specialDir, { recursive: true })
      initGitRepo(specialDir)
      createTestScript(specialDir, true)

      // Initial commit so git HEAD exists
      fs.writeFileSync(path.join(specialDir, '.gitkeep'), '')
      spawnSync('git', ['add', '.'], { cwd: specialDir })
      spawnSync('git', ['commit', '-m', 'init'], { cwd: specialDir })

      const result = invokeHook(
        'prove_it_done.js',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          cwd: specialDir
        },
        { projectDir: specialDir }
      )

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce output')
      // Tests run at hook time — verify they passed without crashing on special paths
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('tests passed'),
        'Should handle special-character paths without crashing'
      )
    })
  })

  describe('test root resolution', () => {
    const fs = require('fs')
    const path = require('path')

    it('finds script/test in cwd first', () => {
      createTestScript(tmpDir, true)
      const subDir = path.join(tmpDir, 'subdir')
      fs.mkdirSync(subDir, { recursive: true })
      createTestScript(subDir, true) // subdir has its own script/test

      const result = invokeHook(
        'prove_it_done.js',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          cwd: subDir
        },
        { projectDir: subDir }
      )

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce output')
      // Tests run at hook time — verify they passed (found script/test in subdir)
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('tests passed'),
        'Should find and run script/test from cwd'
      )
    })

    it('walks up to find script/test in parent', () => {
      createTestScript(tmpDir, true) // only root has script/test
      const subDir = path.join(tmpDir, 'subdir')
      fs.mkdirSync(subDir, { recursive: true })
      // subdir has no script/test

      const result = invokeHook(
        'prove_it_done.js',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          cwd: subDir
        },
        { projectDir: subDir }
      )

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce output')
      // Tests run at hook time — verify they passed (walked up to find script/test)
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('tests passed'),
        'Should walk up to find script/test in parent'
      )
    })

    it('stops at .claude/prove_it.json marker even without script/test', () => {
      createTestScript(tmpDir, true) // root has script/test
      const subDir = path.join(tmpDir, 'subproject')
      fs.mkdirSync(path.join(subDir, '.claude'), { recursive: true })
      fs.writeFileSync(
        path.join(subDir, '.claude', 'prove_it.json'),
        JSON.stringify({ enabled: true })
      )
      // subDir has prove_it.json but no script/test

      const result = invokeHook(
        'prove_it_done.js',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          cwd: subDir
        },
        { projectDir: subDir }
      )

      assert.strictEqual(result.exitCode, 0)
      // Should stop at subDir (has prove_it.json) and report missing script/test
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'deny',
        'Should deny when test script missing in subproject'
      )
    })

    it('does not walk above git root', () => {
      // Create a nested git repo
      const innerRepo = path.join(tmpDir, 'inner')
      fs.mkdirSync(innerRepo, { recursive: true })
      initGitRepo(innerRepo)
      createTestScript(tmpDir, true) // outer has script/test
      // inner repo has no script/test

      const result = invokeHook(
        'prove_it_done.js',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          cwd: innerRepo
        },
        { projectDir: innerRepo }
      )

      assert.strictEqual(result.exitCode, 0)
      // Should not find outer script/test - stops at inner git root
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'deny',
        'Should not inherit script/test from outside git root'
      )
    })
  })
})
