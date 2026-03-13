const { describe, it, before, after, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  invokeDispatcher,
  cleanupTempDir,
  writeConfig,
  makeConfig,
  isolatedEnv,
  freshHarnessRepo,
  cleanRepo
} = require('./hook-harness')

/**
 * Early bail when effective config has no tasks.
 *
 * When hooks is empty or all hook entries have empty tasks arrays,
 * the dispatcher should exit immediately — no file tracking, no signal
 * interception, no phase tracking, no session cleanup.
 */

describe('Early bail for empty hooks', () => {
  let tmpDir

  before(() => {
    tmpDir = freshHarnessRepo()
  })

  afterEach(() => {
    cleanRepo(tmpDir)
  })

  after(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('exits silently with enabled: true and hooks: []', async () => {
    writeConfig(tmpDir, makeConfig([]))

    const result = await invokeDispatcher('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: 'test-empty-hooks',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output, null,
      'Should exit silently when hooks array is empty')
  })

  it('exits silently when all hook entries have empty tasks arrays', async () => {
    writeConfig(tmpDir, makeConfig([
      { type: 'claude', event: 'Stop', tasks: [] },
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] }
    ]))

    const result = await invokeDispatcher('claude:Stop', {
      hook_event_name: 'Stop',
      session_id: 'test-empty-tasks',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output, null,
      'Should exit silently when all hook entries have empty tasks')
  })

  it('does not intercept prove_it signal done when no tasks exist', async () => {
    writeConfig(tmpDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Bash', tasks: [] }
    ]))

    const result = await invokeDispatcher('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'test-signal-no-tasks',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it signal done' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(result.exitCode, 0)
    // Should NOT intercept the signal — just exit silently
    assert.strictEqual(result.output, null,
      'Should not intercept signals when no tasks exist')
  })

  it('does not track file edits when no tasks exist', async () => {
    writeConfig(tmpDir, makeConfig([
      { type: 'claude', event: 'PreToolUse', matcher: 'Edit|Write', tasks: [] }
    ]))

    const env = isolatedEnv(tmpDir)
    const result = await invokeDispatcher('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'test-no-track',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src', 'app.js'), old_string: 'a', new_string: 'b' },
      cwd: tmpDir
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output, null,
      'Should exit silently without tracking file edits')

    // No session log should be created
    const logPath = path.join(env.PROVE_IT_DIR, 'sessions', 'test-no-track.jsonl')
    assert.ok(!fs.existsSync(logPath),
      'Should not create session log when no tasks exist')
  })
})
