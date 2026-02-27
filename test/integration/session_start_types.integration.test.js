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
  makeExecutable,
  writeConfig,
  makeConfig,
  isolatedEnv
} = require('./hook-harness')

describe('SessionStart task types', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_ss_types_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  describe('script tasks emit structured JSON', () => {
    it('emits additionalContext on success', () => {
      createFile(tmpDir, 'hello.sh', '#!/usr/bin/env bash\necho "hello from session"\nexit 0\n')
      makeExecutable(path.join(tmpDir, 'hello.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'hello', type: 'script', command: './hello.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-script-pass',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      assert.ok(result.output.additionalContext, 'Should have additionalContext')
      assert.ok(result.output.additionalContext.includes('hello from session'),
        `additionalContext should include script output, got: ${result.output.additionalContext}`)
      assert.strictEqual(result.output.systemMessage, undefined,
        'No systemMessage on success')
    })

    it('emits both additionalContext and systemMessage on failure', () => {
      createFile(tmpDir, 'fail.sh', '#!/usr/bin/env bash\necho "setup problem" >&2\nexit 1\n')
      makeExecutable(path.join(tmpDir, 'fail.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'fail-check', type: 'script', command: './fail.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-script-fail',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      assert.ok(result.output.additionalContext, 'Should have additionalContext')
      assert.ok(result.output.systemMessage, 'Should have systemMessage on failure')
      assert.ok(result.output.systemMessage.includes('failed'),
        `systemMessage should mention failure, got: ${result.output.systemMessage}`)
    })

    it('continues after failure and includes passing task output', () => {
      createFile(tmpDir, 'fail.sh', '#!/usr/bin/env bash\necho "fail" >&2\nexit 1\n')
      createFile(tmpDir, 'pass.sh', '#!/usr/bin/env bash\necho "pass output"\nexit 0\n')
      makeExecutable(path.join(tmpDir, 'fail.sh'))
      makeExecutable(path.join(tmpDir, 'pass.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'fail-first', type: 'script', command: './fail.sh' },
            { name: 'pass-second', type: 'script', command: './pass.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-continue',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output.additionalContext.includes('pass output'),
        'Should include passing task output')
    })
  })

  describe('env tasks', () => {
    it('writes env vars to CLAUDE_ENV_FILE', () => {
      const envFile = path.join(tmpDir, '.claude_env')
      createFile(tmpDir, 'env.sh', '#!/usr/bin/env bash\necho "MY_VAR=hello"\necho "OTHER=world"\n')
      makeExecutable(path.join(tmpDir, 'env.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'setup-env', type: 'env', command: './env.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-env',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), CLAUDE_ENV_FILE: envFile } })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(fs.existsSync(envFile), 'CLAUDE_ENV_FILE should be created')
      const envContent = fs.readFileSync(envFile, 'utf8')
      assert.ok(envContent.includes('MY_VAR=hello'), `Should contain MY_VAR, got: ${envContent}`)
      assert.ok(envContent.includes('OTHER=world'), `Should contain OTHER, got: ${envContent}`)
    })

    it('reports env vars in additionalContext', () => {
      const envFile = path.join(tmpDir, '.claude_env')
      createFile(tmpDir, 'env.sh', '#!/usr/bin/env bash\necho "MY_VAR=hello"\n')
      makeExecutable(path.join(tmpDir, 'env.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'setup-env', type: 'env', command: './env.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-env-context',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), CLAUDE_ENV_FILE: envFile } })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      assert.ok(result.output.additionalContext.includes('MY_VAR'),
        `additionalContext should mention env var names, got: ${result.output.additionalContext}`)
    })

    it('reports errors in both channels when env script fails', () => {
      createFile(tmpDir, 'bad_env.sh', '#!/usr/bin/env bash\necho "env error" >&2\nexit 1\n')
      makeExecutable(path.join(tmpDir, 'bad_env.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'bad-env', type: 'env', command: './bad_env.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-env-fail',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(result.output, 'Should produce JSON output')
      assert.ok(result.output.systemMessage, 'Should have systemMessage on env failure')
      assert.ok(result.output.additionalContext, 'Should have additionalContext on env failure')
      assert.ok(result.output.systemMessage.includes('failed'),
        `systemMessage should mention failure, got: ${result.output.systemMessage}`)
    })

    it('skips env tasks on clear source', () => {
      const envFile = path.join(tmpDir, '.claude_env')
      createFile(tmpDir, 'env.sh', '#!/usr/bin/env bash\necho "MY_VAR=hello"\n')
      makeExecutable(path.join(tmpDir, 'env.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'setup-env', type: 'env', command: './env.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-env-clear',
        source: 'clear',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), CLAUDE_ENV_FILE: envFile } })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(!fs.existsSync(envFile), 'CLAUDE_ENV_FILE should not be created on clear')
    })

    it('skips env tasks on compact source', () => {
      const envFile = path.join(tmpDir, '.claude_env')
      createFile(tmpDir, 'env.sh', '#!/usr/bin/env bash\necho "MY_VAR=hello"\n')
      makeExecutable(path.join(tmpDir, 'env.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'setup-env', type: 'env', command: './env.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-env-compact',
        source: 'compact',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), CLAUDE_ENV_FILE: envFile } })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(!fs.existsSync(envFile), 'CLAUDE_ENV_FILE should not be created on compact')
    })

    it('runs env tasks on resume source', () => {
      const envFile = path.join(tmpDir, '.claude_env')
      createFile(tmpDir, 'env.sh', '#!/usr/bin/env bash\necho "MY_VAR=hello"\n')
      makeExecutable(path.join(tmpDir, 'env.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'setup-env', type: 'env', command: './env.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-env-resume',
        source: 'resume',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), CLAUDE_ENV_FILE: envFile } })

      assert.strictEqual(result.exitCode, 0)
      assert.ok(fs.existsSync(envFile), 'CLAUDE_ENV_FILE should be created on resume')
    })

    it('merges multiple env tasks in order', () => {
      const envFile = path.join(tmpDir, '.claude_env')
      createFile(tmpDir, 'env1.sh', '#!/usr/bin/env bash\necho "A=1"\necho "B=first"\n')
      createFile(tmpDir, 'env2.sh', '#!/usr/bin/env bash\necho "B=second"\necho "C=3"\n')
      makeExecutable(path.join(tmpDir, 'env1.sh'))
      makeExecutable(path.join(tmpDir, 'env2.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'env1', type: 'env', command: './env1.sh' },
            { name: 'env2', type: 'env', command: './env2.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-env-merge',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), CLAUDE_ENV_FILE: envFile } })

      assert.strictEqual(result.exitCode, 0)
      const envContent = fs.readFileSync(envFile, 'utf8')
      assert.ok(envContent.includes('A=1'), 'Should contain A from first task')
      assert.ok(envContent.includes('B=second'), 'Later task should override B')
      assert.ok(envContent.includes('C=3'), 'Should contain C from second task')
    })

    it('handles JSON env output', () => {
      const envFile = path.join(tmpDir, '.claude_env')
      createFile(tmpDir, 'env.sh', '#!/usr/bin/env bash\necho \'{"API_KEY": "abc123", "DEBUG": "true"}\'\n')
      makeExecutable(path.join(tmpDir, 'env.sh'))

      writeConfig(tmpDir, makeConfig([
        {
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'json-env', type: 'env', command: './env.sh' }
          ]
        }
      ]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-env-json',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: { ...isolatedEnv(tmpDir), CLAUDE_ENV_FILE: envFile } })

      assert.strictEqual(result.exitCode, 0)
      const envContent = fs.readFileSync(envFile, 'utf8')
      assert.ok(envContent.includes('API_KEY=abc123'), `Should contain API_KEY, got: ${envContent}`)
      assert.ok(envContent.includes('DEBUG=true'), `Should contain DEBUG, got: ${envContent}`)
    })
  })

  describe('no output when no tasks match', () => {
    it('exits silently with no config', () => {
      writeConfig(tmpDir, makeConfig([]))

      const result = invokeHook('claude:SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'test-ss-empty',
        source: 'startup',
        cwd: tmpDir
      }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output, null, 'Should produce no output when no hooks match')
    })
  })
})
