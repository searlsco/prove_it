const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  writeConfig,
  makeConfig,
  assertValidPermissionDecision,
  isolatedEnv,
  createFastTestScript
} = require('./hook-harness')

describe('backchannel bypass on PreToolUse', () => {
  let tmpDir, projectDir, env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_bcbypass_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)
    createFile(projectDir, 'src/app.js', 'module.exports = {}')
    spawnSync('git', ['add', '.'], { cwd: projectDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: projectDir })
    env = isolatedEnv(tmpDir)
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  it('allows Write to backchannel path even when tasks would deny', () => {
    createFastTestScript(projectDir, false) // always-failing script
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        tasks: [
          { name: 'always-fail', type: 'script', command: './script/test_fast' }
        ]
      }
    ]))

    const sessionId = 'bc-bypass-test-1'
    const bcPath = path.join(projectDir, '.claude', 'prove_it', 'sessions', sessionId, 'backchannel', 'always-fail', 'README.md')

    const result = invokeHook('claude:PreToolUse', {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: bcPath, content: 'Appeal text' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assertValidPermissionDecision(result, 'backchannel Write')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('allows Edit to backchannel path', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        tasks: [
          { name: 'always-fail', type: 'script', command: './script/test_fast' }
        ]
      }
    ]))

    const sessionId = 'bc-bypass-test-2'
    const bcPath = path.join(projectDir, '.claude', 'prove_it', 'sessions', sessionId, 'backchannel', 'always-fail', 'README.md')

    const result = invokeHook('claude:PreToolUse', {
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: bcPath, old_string: 'x', new_string: 'y' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('allows NotebookEdit to backchannel path via notebook_path', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        tasks: [
          { name: 'always-fail', type: 'script', command: './script/test_fast' }
        ]
      }
    ]))

    const sessionId = 'bc-bypass-test-nb'
    const bcPath = path.join(projectDir, '.claude', 'prove_it', 'sessions', sessionId, 'backchannel', 'always-fail', 'appeal.ipynb')

    const result = invokeHook('claude:PreToolUse', {
      session_id: sessionId,
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: bcPath, new_source: 'appeal' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assertValidPermissionDecision(result, 'backchannel NotebookEdit')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('does not bypass for writes outside backchannel', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        tasks: [
          { name: 'always-fail', type: 'script', command: './script/test_fast' }
        ]
      }
    ]))

    const normalPath = path.join(projectDir, 'src', 'app.js')

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'bc-bypass-test-3',
      tool_name: 'Write',
      tool_input: { file_path: normalPath, content: 'module.exports = { changed: true }' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    // The failing task should deny this write
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
  })

  it('does not bypass for other sessions backchannel', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        tasks: [
          { name: 'always-fail', type: 'script', command: './script/test_fast' }
        ]
      }
    ]))

    // Write targets a different session's backchannel
    const otherSessionBc = path.join(projectDir, '.claude', 'prove_it', 'sessions', 'other-session', 'backchannel', 'always-fail', 'README.md')

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'bc-bypass-test-4',
      tool_name: 'Write',
      tool_input: { file_path: otherSessionBc, content: 'sneaky' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    // Should NOT be allowed by the bypass — different session
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
  })
})
