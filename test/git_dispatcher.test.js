const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { defaultConfig, matchGitEntries, runGitTasks } = require('../lib/dispatcher/git')
const { readRef, churnSinceRef, sanitizeRefName } = require('../lib/git')

describe('git dispatcher', () => {
  describe('defaultConfig', () => {
    it('returns enabled: false', () => {
      assert.strictEqual(defaultConfig().enabled, false)
    })

    it('returns empty hooks array', () => {
      assert.deepStrictEqual(defaultConfig().hooks, [])
    })

    it('returns null sources', () => {
      assert.strictEqual(defaultConfig().sources, null)
    })

    it('returns no format key', () => {
      assert.strictEqual(defaultConfig().format, undefined)
    })
  })

  describe('matchGitEntries', () => {
    it('matches git entries for the given event', () => {
      const hooks = [
        { type: 'git', event: 'pre-commit', tasks: [{ name: 'a' }] },
        { type: 'git', event: 'pre-push', tasks: [{ name: 'b' }] },
        { type: 'claude', event: 'Stop', tasks: [{ name: 'c' }] }
      ]
      const matched = matchGitEntries(hooks, 'pre-commit')
      assert.strictEqual(matched.length, 1)
      assert.strictEqual(matched[0].tasks[0].name, 'a')
    })

    it('returns empty for no matches', () => {
      const hooks = [
        { type: 'git', event: 'pre-push', tasks: [] }
      ]
      assert.deepStrictEqual(matchGitEntries(hooks, 'pre-commit'), [])
    })

    it('ignores claude-type entries', () => {
      const hooks = [
        { type: 'claude', event: 'pre-commit', tasks: [{ name: 'x' }] }
      ]
      assert.deepStrictEqual(matchGitEntries(hooks, 'pre-commit'), [])
    })

    it('returns empty for null hooks', () => {
      assert.deepStrictEqual(matchGitEntries(null, 'pre-commit'), [])
    })

    it('returns empty for non-array hooks', () => {
      assert.deepStrictEqual(matchGitEntries('not-an-array', 'pre-commit'), [])
    })

    it('matches multiple entries for same event', () => {
      const hooks = [
        { type: 'git', event: 'pre-commit', tasks: [{ name: 'a' }] },
        { type: 'git', event: 'pre-commit', tasks: [{ name: 'b' }] }
      ]
      const matched = matchGitEntries(hooks, 'pre-commit')
      assert.strictEqual(matched.length, 2)
    })
  })

  describe('runGitTasks', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_git_test_'))
      spawnSync('git', ['init'], { cwd: tmpDir })
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
      fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '')
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'initial\n')
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    function makeScript (name, content) {
      const scriptPath = path.join(tmpDir, name)
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, content)
      fs.chmodSync(scriptPath, 0o755)
      return scriptPath
    }

    it('returns no failure when all tasks pass', () => {
      const scriptPath = makeScript('script/test', '#!/usr/bin/env bash\nexit 0\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [{ name: 'tests', type: 'script', command: scriptPath }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.strictEqual(failure, null)
    })

    it('returns failure from failing task', () => {
      const scriptPath = makeScript('script/test', '#!/usr/bin/env bash\necho "broken" >&2\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [{ name: 'tests', type: 'script', command: scriptPath }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.ok(failure)
      assert.ok(failure.includes('tests:'))
    })

    it('stops on first failure by default (first-fail)', () => {
      const fail1 = makeScript('fail1.sh', '#!/usr/bin/env bash\nexit 1\n')
      const fail2 = makeScript('fail2.sh', '#!/usr/bin/env bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [
          { name: 'a', type: 'script', command: fail1 },
          { name: 'b', type: 'script', command: fail2 }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.ok(failure, 'default mode should stop after first failure')
      assert.ok(failure.startsWith('a:'), 'should report first failing task')
    })

    it('always stops on first failure (fail-fast)', () => {
      const pass = makeScript('pass.sh', '#!/usr/bin/env bash\nexit 0\n')
      const fail1 = makeScript('fail1.sh', '#!/usr/bin/env bash\nexit 1\n')
      const fail2 = makeScript('fail2.sh', '#!/usr/bin/env bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [
          { name: 'a', type: 'script', command: fail1 },
          { name: 'b', type: 'script', command: pass },
          { name: 'c', type: 'script', command: fail2 }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.ok(failure, 'should report failure')
      assert.ok(failure.startsWith('a:'), 'should report first failing task')
    })

    it('skips tasks with unsatisfied when condition', () => {
      const fail = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [
          { name: 'a', type: 'script', command: fail, when: { fileExists: 'nonexistent-xyz' } }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.strictEqual(failure, null)
    })

    it('skips unknown task types', () => {
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [
          { name: 'a', type: 'unknown', command: 'whatever' }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.strictEqual(failure, null)
    })

    it('skips task with enabled: false', () => {
      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [{ name: 'disabled-task', type: 'script', command: failScript, enabled: false }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.strictEqual(failure, null, 'Disabled task should be skipped, not executed')
    })

    it('runs task with enabled: true', () => {
      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [{ name: 'enabled-task', type: 'script', command: failScript, enabled: true }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.ok(failure, 'Task with enabled: true should execute and report failure')
      assert.ok(failure.includes('enabled-task'), 'Failure should name the task')
    })

    it('propagates test output between tasks', () => {
      const script = makeScript('output.sh', '#!/usr/bin/env bash\necho "test output here"\nexit 0\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [
          { name: 'a', type: 'script', command: script }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      runGitTasks(entries, context)
      assert.ok(context.testOutput.includes('test output'))
    })

    it('advances churn ref on pass for linesChanged task', () => {
      // Bootstrap the ref
      churnSinceRef(tmpDir, sanitizeRefName('churn-check'), ['**/*.js'])

      // Create enough churn
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add code'], { cwd: tmpDir })

      const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
      const passScript = makeScript('pass.sh', '#!/usr/bin/env bash\nexit 0\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [{
          name: 'churn-check',
          type: 'script',
          command: passScript,
          when: { linesChanged: 5 }
        }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, hookEvent: 'pre-commit', localCfgPath: null, sources: ['**/*.js'], maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.strictEqual(failure, null, 'Task should pass')

      // Ref should now be at HEAD
      const ref = readRef(tmpDir, sanitizeRefName('churn-check'))
      assert.strictEqual(ref, headBefore, 'Ref should be advanced to HEAD after pass')

      // Running again with no new churn should skip
      const { failure: failure2 } = runGitTasks(entries, context)
      assert.strictEqual(failure2, null, 'Should pass (task skipped due to 0 churn)')
    })

    it('does NOT advance churn ref on failure by default (git hooks)', () => {
      churnSinceRef(tmpDir, sanitizeRefName('sticky-check'), ['**/*.js'])

      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add code'], { cwd: tmpDir })

      const refBefore = readRef(tmpDir, sanitizeRefName('sticky-check'))
      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [{
          name: 'sticky-check',
          type: 'script',
          command: failScript,
          when: { linesChanged: 5 }
        }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, hookEvent: 'pre-commit', localCfgPath: null, sources: ['**/*.js'], maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.ok(failure, 'Task should fail')

      // Ref should NOT have advanced
      const refAfter = readRef(tmpDir, sanitizeRefName('sticky-check'))
      assert.strictEqual(refAfter, refBefore, 'Ref should NOT advance on failure (git hook default)')
    })

    it('advances churn ref on failure when resetOnFail: true', () => {
      churnSinceRef(tmpDir, sanitizeRefName('reset-check'), ['**/*.js'])

      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add code'], { cwd: tmpDir })

      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [{
          name: 'reset-check',
          type: 'script',
          command: failScript,
          when: { linesChanged: 5 },
          resetOnFail: true
        }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, hookEvent: 'pre-commit', localCfgPath: null, sources: ['**/*.js'], maxChars: 12000, testOutput: '' }
      const { failure } = runGitTasks(entries, context)
      assert.ok(failure, 'Task should fail')

      // Ref should be advanced — re-running with no new churn should skip
      const { failure: failure2 } = runGitTasks(entries, context)
      assert.strictEqual(failure2, null, 'Should skip after resetOnFail advanced ref')
    })

    it('resetOnFail resets churn for uncommitted changes (deadlock fix)', () => {
      // Bootstrap
      churnSinceRef(tmpDir, sanitizeRefName('deadlock-check'), ['**/*.js'])

      // Simulate agent Write — uncommitted changes (no commit!)
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)

      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        tasks: [{
          name: 'deadlock-check',
          type: 'script',
          command: failScript,
          when: { linesChanged: 5 },
          resetOnFail: true
        }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, sessionId: null, hookEvent: 'pre-commit', localCfgPath: null, sources: ['**/*.js'], maxChars: 12000, testOutput: '' }

      // First run: fires and fails, resetOnFail should snapshot working tree
      const { failure } = runGitTasks(entries, context)
      assert.ok(failure, 'Task should fail')

      // Second run: if snapshot worked, churn is 0 and task is skipped (no deadlock)
      const { failure: failure2 } = runGitTasks(entries, context)
      assert.strictEqual(failure2, null,
        'Should skip after resetOnFail — ref should capture working tree, not just HEAD')
    })
  })
})
