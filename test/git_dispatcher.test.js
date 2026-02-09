const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { defaultConfig, matchGitEntries, runGitTasks } = require('../lib/dispatcher/git')

describe('git dispatcher', () => {
  describe('defaultConfig', () => {
    it('returns enabled: true', () => {
      assert.strictEqual(defaultConfig().enabled, true)
    })

    it('returns empty hooks array', () => {
      assert.deepStrictEqual(defaultConfig().hooks, [])
    })

    it('returns null sources', () => {
      assert.strictEqual(defaultConfig().sources, null)
    })

    it('returns format with maxOutputChars', () => {
      assert.strictEqual(defaultConfig().format.maxOutputChars, 12000)
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
  })
})
