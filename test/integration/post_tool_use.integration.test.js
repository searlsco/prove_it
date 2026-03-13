const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  makeExecutable,
  writeConfig,
  makeConfig,
  isolatedEnv
} = require('./hook-harness')

describe('PostToolUse dispatch', () => {
  let tmpDir, env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_postuse_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
    env = isolatedEnv(tmpDir)
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('dispatches PostToolUse tasks matched by tool name', () => {
    createFile(tmpDir, 'post-check.sh', '#!/usr/bin/env bash\ncat /dev/stdin | node -e "const d=JSON.parse(require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\')); process.stdout.write(d.tool_name || \'no-tool\')"\n')
    makeExecutable(path.join(tmpDir, 'post-check.sh'))

    // Use a simpler script that just echoes something
    createFile(tmpDir, 'echo-tool.sh', '#!/usr/bin/env bash\necho "post-tool-ran"\n')
    makeExecutable(path.join(tmpDir, 'echo-tool.sh'))

    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PostToolUse',
        matcher: 'Bash',
        tasks: [
          { name: 'post-check', type: 'script', command: './echo-tool.sh' }
        ]
      }
    ]))

    const result = invokeHook('claude:PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: 'test-post-use',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'Tests passed'
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Should produce JSON output')
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'PostToolUse')
  })

  it('does not match PostToolUse tasks when tool name differs', () => {
    createFile(tmpDir, 'echo-tool.sh', '#!/usr/bin/env bash\necho "should-not-run"\n')
    makeExecutable(path.join(tmpDir, 'echo-tool.sh'))

    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PostToolUse',
        matcher: 'Bash',
        tasks: [
          { name: 'post-check', type: 'script', command: './echo-tool.sh' }
        ]
      }
    ]))

    const result = invokeHook('claude:PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: 'test-post-use-nomatch',
      tool_name: 'Edit',
      tool_input: {}
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    // No matching hook → no output
    assert.strictEqual(result.output, null)
  })

  it('passes tool_response to script task via stdin', () => {
    // Script reads stdin JSON and outputs the tool_response field
    createFile(tmpDir, 'read-response.sh', '#!/usr/bin/env bash\nread input\necho "$input" | node -e "process.stdin.on(\'data\',d=>{const j=JSON.parse(d);process.stdout.write(j.tool_response||\'none\')})"\n')
    makeExecutable(path.join(tmpDir, 'read-response.sh'))

    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PostToolUse',
        matcher: 'Bash',
        tasks: [
          { name: 'read-response', type: 'script', command: './read-response.sh' }
        ]
      }
    ]))

    const result = invokeHook('claude:PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: 'test-post-use-response',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'All 42 tests passed'
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
  })
})

describe('PostToolUseFailure dispatch', () => {
  let tmpDir, env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_postfail_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
    env = isolatedEnv(tmpDir)
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('dispatches PostToolUseFailure tasks matched by tool name', () => {
    createFile(tmpDir, 'echo-fail.sh', '#!/usr/bin/env bash\necho "failure-handled"\n')
    makeExecutable(path.join(tmpDir, 'echo-fail.sh'))

    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PostToolUseFailure',
        matcher: 'Bash',
        tasks: [
          { name: 'fail-handler', type: 'script', command: './echo-fail.sh' }
        ]
      }
    ]))

    const result = invokeHook('claude:PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'test-post-fail',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'Tests failed: 3 failures'
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Should produce JSON output')
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'PostToolUseFailure')
  })

  it('does not include decision field in PostToolUseFailure output', () => {
    createFile(tmpDir, 'echo-fail.sh', '#!/usr/bin/env bash\necho "noted"\n')
    makeExecutable(path.join(tmpDir, 'echo-fail.sh'))

    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PostToolUseFailure',
        matcher: 'Bash',
        tasks: [
          { name: 'fail-handler', type: 'script', command: './echo-fail.sh' }
        ]
      }
    ]))

    const result = invokeHook('claude:PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'test-post-fail-nodecision',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'exit code 1'
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output)
    assert.strictEqual(result.output.decision, undefined,
      'PostToolUseFailure should not have decision field')
  })
})
