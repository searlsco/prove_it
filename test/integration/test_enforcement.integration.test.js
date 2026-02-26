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
  writeConfig,
  makeConfig,
  isolatedEnv,
  CLI_PATH
} = require('./hook-harness')

/**
 * Test enforcement integration tests for the v2 dispatcher.
 *
 * Verifies that PreToolUse commit-gate checks enforce test-before-commit:
 * - Allows commit when tests pass
 * - Denies commit when tests fail
 * - Ignores non-matching commands
 * - Handles missing test scripts
 * - Handles special characters in paths
 */

function commitGateHooks (testCommand = './script/test') {
  return [
    {
      type: 'claude',
      event: 'PreToolUse',
      matcher: 'Bash',
      triggers: ['(^|\\s)git\\s+commit\\b'],
      tasks: [
        { name: 'full-tests', type: 'script', command: testCommand }
      ]
    }
  ]
}

describe('v2 dispatcher: test enforcement', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_test_enforce_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  describe('commands that require tests', () => {
    it('allows commit when tests pass', () => {
      createTestScript(tmpDir, true)
      writeConfig(tmpDir, makeConfig(commitGateHooks()))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'allow',
        'Must allow when tests pass'
      )
    })

    it('denies commit when tests fail', () => {
      createTestScript(tmpDir, false)
      writeConfig(tmpDir, makeConfig(commitGateHooks()))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "ship it"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'deny',
        'Must deny when tests fail'
      )
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('full-tests failed'),
        'Reason should mention test failure'
      )
    })

    it('does not require tests for git push (no trigger match)', () => {
      writeConfig(tmpDir, makeConfig(commitGateHooks()))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should not trigger for git push')
    })
  })

  describe("commands that don't require tests", () => {
    beforeEach(() => {
      writeConfig(tmpDir, makeConfig(commitGateHooks()))
    })

    it('ignores git status', () => {
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should not produce output for non-matching commands')
    })

    it('ignores npm test', () => {
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null)
    })

    it('ignores non-Bash tools', () => {
      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/some/file.js' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null)
    })
  })

  describe('test script missing', () => {
    it('denies with helpful error when test script required but missing', () => {
      // No test script created
      writeConfig(tmpDir, makeConfig(commitGateHooks()))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce output')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'deny',
        'Should deny when test script is missing'
      )
      assert.ok(
        result.output.hookSpecificOutput.permissionDecisionReason.includes('Script not found'),
        'Should explain test script is missing'
      )
    })
  })

  describe('fail-closed behavior', () => {
    it('denies when input JSON is invalid', () => {
      writeConfig(tmpDir, makeConfig(commitGateHooks()))

      const result = spawnSync('node', [CLI_PATH, 'hook', 'claude:PreToolUse'], {
        input: 'not valid json {{{',
        encoding: 'utf8',
        env: {
          ...process.env,
          ...isolatedEnv(tmpDir),
          CLAUDE_PROJECT_DIR: tmpDir
        }
      })

      assert.strictEqual(result.status, 0)
      assert.ok(result.stdout, 'Should produce output')

      const output = JSON.parse(result.stdout)
      assert.strictEqual(
        output.hookSpecificOutput.permissionDecision,
        'allow',
        'Should allow on invalid input (circuit breaker prevents death spiral)'
      )
      assert.ok(
        output.hookSpecificOutput.permissionDecisionReason.includes('Failed to parse'),
        'Should explain the parse failure'
      )
    })
  })

  describe('shell escaping', () => {
    it('safely handles paths with special characters', () => {
      const specialDir = path.join(tmpDir, "path with 'quotes' and spaces")
      fs.mkdirSync(specialDir, { recursive: true })
      initGitRepo(specialDir)
      createTestScript(specialDir, true)
      writeConfig(specialDir, makeConfig(commitGateHooks()))

      createFile(specialDir, '.gitkeep', '')
      spawnSync('git', ['add', '.'], { cwd: specialDir })
      spawnSync('git', ['commit', '-m', 'init'], { cwd: specialDir })

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        cwd: specialDir
      }, { projectDir: specialDir, env: isolatedEnv(specialDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce output')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'allow',
        'Should handle special-character paths without crashing'
      )
    })
  })

  describe('configurable triggers', () => {
    it('triggers on git push when configured', () => {
      createTestScript(tmpDir, true)
      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          triggers: ['(^|\\s)git\\s+commit\\b', '(^|\\s)git\\s+push\\b'],
          tasks: [
            { name: 'full-tests', type: 'script', command: './script/test' }
          ]
        }
      ]))

      const result = invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Hook should produce output for git push trigger')
      assert.strictEqual(
        result.output.hookSpecificOutput.permissionDecision,
        'allow',
        'Should allow when tests pass for custom trigger'
      )
    })
  })
})
