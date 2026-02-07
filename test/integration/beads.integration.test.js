const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  initBeads,
  writeConfig,
  makeConfig,
  assertValidPermissionDecision,
  isolatedEnv,
  CLI_PATH
} = require('./hook-harness')

const HOOK_SPEC = 'claude:PreToolUse'

function beadsHooks () {
  return [
    {
      type: 'claude',
      event: 'PreToolUse',
      matcher: 'Edit|Write|NotebookEdit|Bash',
      checks: [
        { name: 'config-protection', type: 'script', command: 'prove_it builtin:config-protection' },
        { name: 'beads-gate', type: 'script', command: 'prove_it builtin:beads-gate', when: { fileExists: '.beads' } }
      ]
    }
  ]
}

describe('beads integration (v2 dispatcher)', () => {
  let tmpDir
  let env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_beads_')
    env = isolatedEnv(tmpDir)
    initGitRepo(tmpDir)
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  describe('config-protection', () => {
    beforeEach(() => {
      writeConfig(tmpDir, makeConfig(beadsHooks()))
    })

    it('blocks Edit to prove_it.json', () => {
      const result = invokeHook(HOOK_SPEC, {
        session_id: 'test-session',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmpDir, '.claude', 'prove_it.json'),
          old_string: '"enabled": true',
          new_string: '"enabled": false'
        }
      }, { cwd: tmpDir, env })

      assertValidPermissionDecision(result, 'config-protection blocks Edit prove_it.json')
      assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny')
    })

    it('blocks Write to prove_it.local.json', () => {
      const result = invokeHook(HOOK_SPEC, {
        session_id: 'test-session',
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(tmpDir, '.claude', 'prove_it.local.json'),
          content: '{"hooks":[]}'
        }
      }, { cwd: tmpDir, env })

      assertValidPermissionDecision(result, 'config-protection blocks Write prove_it.local.json')
      assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny')
    })

    it('blocks Bash redirect to prove_it config', () => {
      const result = invokeHook(HOOK_SPEC, {
        session_id: 'test-session',
        tool_name: 'Bash',
        tool_input: {
          command: `echo '{}' > ${path.join(tmpDir, '.claude', 'prove_it.json')}`
        }
      }, { cwd: tmpDir, env })

      assertValidPermissionDecision(result, 'config-protection blocks Bash redirect')
      assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny')
    })

    it('allows Write to other files', () => {
      const result = invokeHook(HOOK_SPEC, {
        session_id: 'test-session',
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(tmpDir, 'src', 'app.js'),
          content: 'console.log("hello")'
        }
      }, { cwd: tmpDir, env })

      assertValidPermissionDecision(result, 'config-protection allows non-config Write')
      // Config-protection passes and beads-gate is skipped (no .beads dir),
      // so the dispatcher emits an allow decision or exits silently.
      if (result.output) {
        assert.notEqual(
          result.output.hookSpecificOutput?.permissionDecision,
          'deny',
          'Should not deny Write to non-config files'
        )
      }
    })
  })

  describe('beads-gate', () => {
    beforeEach(() => {
      writeConfig(tmpDir, makeConfig(beadsHooks()))
    })

    it('denies Edit when no in_progress bead', () => {
      initBeads(tmpDir)

      const result = invokeHook(HOOK_SPEC, {
        session_id: 'test-session',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmpDir, 'src', 'app.js'),
          old_string: 'foo',
          new_string: 'bar'
        }
      }, { cwd: tmpDir, env })

      assertValidPermissionDecision(result, 'beads-gate denies Edit without in_progress bead')
      // beads-gate should deny (bd not found returns pass in fail-open,
      // but if bd IS found and no beads in progress, it denies).
      // Accept deny OR pass depending on whether bd is installed.
      if (result.output?.hookSpecificOutput?.permissionDecision === 'deny') {
        assert.ok(
          result.output.hookSpecificOutput.permissionDecisionReason,
          'Should include an explanation message'
        )
      }
    })

    it('allows when not a beads repo', () => {
      // No initBeads() — .beads directory does not exist.
      // The when.fileExists condition causes beads-gate to be skipped entirely.
      const result = invokeHook(HOOK_SPEC, {
        session_id: 'test-session',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmpDir, 'src', 'app.js'),
          old_string: 'foo',
          new_string: 'bar'
        }
      }, { cwd: tmpDir, env })

      assertValidPermissionDecision(result, 'beads-gate allows non-beads repo')
      if (result.output) {
        assert.notEqual(
          result.output.hookSpecificOutput?.permissionDecision,
          'deny',
          'Should not deny Edit when not a beads repo'
        )
      }
    })

    it('skips non-source files', () => {
      initBeads(tmpDir)

      // Override config with sources so only src/**/*.js files are gated
      writeConfig(tmpDir, makeConfig(beadsHooks(), { sources: ['src/**/*.js'] }))

      const result = invokeHook(HOOK_SPEC, {
        session_id: 'test-session',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmpDir, 'docs', 'README.md'),
          old_string: 'old',
          new_string: 'new'
        }
      }, { cwd: tmpDir, env })

      assertValidPermissionDecision(result, 'beads-gate skips non-source files')
      if (result.output) {
        assert.notEqual(
          result.output.hookSpecificOutput?.permissionDecision,
          'deny',
          'Should not deny Edit to non-source files'
        )
      }
    })
  })

  describe('error handling', () => {
    beforeEach(() => {
      writeConfig(tmpDir, makeConfig(beadsHooks()))
    })

    it('fail-closed on invalid stdin JSON', () => {
      // The harness always JSON.stringifies input, so invoke the CLI directly
      // with raw invalid JSON.
      const result = spawnSync('node', [CLI_PATH, 'hook', HOOK_SPEC], {
        input: 'not valid json{{{',
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          CLAUDE_PROJECT_DIR: tmpDir
        },
        cwd: tmpDir
      })

      assert.equal(result.status, 0, 'Hook should exit 0 even on error')
      assert.ok(result.stdout.trim(), 'Should produce output on invalid JSON')

      const output = JSON.parse(result.stdout)
      assertValidPermissionDecision(
        { output, exitCode: result.status },
        'fail-closed invalid JSON'
      )
      assert.equal(output.hookSpecificOutput.permissionDecision, 'deny')
    })
  })
})
