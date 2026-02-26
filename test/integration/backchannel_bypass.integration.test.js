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
  let tmpDir, projectDir, resolvedProjectDir, env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_bcbypass_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)
    // resolvedProjectDir matches rootDir inside the dispatcher (realpath-resolved).
    // Arbiter constructs backchannel paths from rootDir, so Claude's tool_input
    // will contain the resolved form.
    resolvedProjectDir = fs.realpathSync(projectDir)
    createFile(projectDir, 'src/app.js', 'module.exports = {}')
    spawnSync('git', ['add', '.'], { cwd: projectDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: projectDir })
    env = isolatedEnv(tmpDir)
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  function failingConfig () {
    return makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        tasks: [
          { name: 'always-fail', type: 'script', command: './script/test_fast' }
        ]
      }
    ])
  }

  function bcPath (sessionId, taskName, filename) {
    return path.join(resolvedProjectDir, '.claude', 'prove_it', 'sessions', sessionId, 'backchannel', taskName, filename)
  }

  it('allows Write to backchannel path even when tasks would deny', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, failingConfig())

    const sessionId = 'bc-bypass-test-1'
    const result = invokeHook('claude:PreToolUse', {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: bcPath(sessionId, 'always-fail', 'README.md'), content: 'Appeal text' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assertValidPermissionDecision(result, 'backchannel Write')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('allows Edit to backchannel path', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, failingConfig())

    const sessionId = 'bc-bypass-test-2'
    const result = invokeHook('claude:PreToolUse', {
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: bcPath(sessionId, 'always-fail', 'README.md'), old_string: 'x', new_string: 'y' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('allows MultiEdit to backchannel path', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, failingConfig())

    const sessionId = 'bc-bypass-test-me'
    const result = invokeHook('claude:PreToolUse', {
      session_id: sessionId,
      tool_name: 'MultiEdit',
      tool_input: { file_path: bcPath(sessionId, 'always-fail', 'README.md'), edits: [] }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('allows NotebookEdit to backchannel path via notebook_path', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, failingConfig())

    const sessionId = 'bc-bypass-test-nb'
    const result = invokeHook('claude:PreToolUse', {
      session_id: sessionId,
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: bcPath(sessionId, 'always-fail', 'appeal.ipynb'), new_source: 'appeal' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assertValidPermissionDecision(result, 'backchannel NotebookEdit')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('works when CLAUDE_PROJECT_DIR is a symlink (bypass uses rootDir)', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, failingConfig())

    // Create a symlink to projectDir and pass it as CLAUDE_PROJECT_DIR.
    // The dispatcher resolves rootDir via realpathSync, so the bypass prefix
    // uses the resolved form. Claude's file_path (from arbiter) also uses
    // the resolved form. This test proves both sides match.
    const symlinkDir = path.join(tmpDir, 'symlinked-project')
    fs.symlinkSync(projectDir, symlinkDir)

    const symEnv = { ...env, CLAUDE_PROJECT_DIR: symlinkDir }
    const sessionId = 'bc-bypass-symlink'
    // bcPath uses resolvedProjectDir — matching what arbiter would give Claude
    const result = invokeHook('claude:PreToolUse', {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: bcPath(sessionId, 'always-fail', 'README.md'), content: 'Appeal' }
    }, { projectDir: symlinkDir, env: symEnv })

    assert.strictEqual(result.exitCode, 0)
    assertValidPermissionDecision(result, 'symlink backchannel Write')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('does not bypass for writes outside backchannel', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, failingConfig())

    const normalPath = path.join(resolvedProjectDir, 'src', 'app.js')

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'bc-bypass-test-3',
      tool_name: 'Write',
      tool_input: { file_path: normalPath, content: 'module.exports = { changed: true }' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
  })

  it('does not bypass for other sessions backchannel', () => {
    createFastTestScript(projectDir, false)
    writeConfig(projectDir, failingConfig())

    const result = invokeHook('claude:PreToolUse', {
      session_id: 'bc-bypass-test-4',
      tool_name: 'Write',
      tool_input: { file_path: bcPath('other-session', 'always-fail', 'README.md'), content: 'sneaky' }
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
  })
})
