const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { defaultConfig, matchGitEntries, runGitChecks } = require('../lib/dispatcher/git')

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
        { type: 'git', event: 'pre-commit', checks: [{ name: 'a' }] },
        { type: 'git', event: 'pre-push', checks: [{ name: 'b' }] },
        { type: 'claude', event: 'Stop', checks: [{ name: 'c' }] }
      ]
      const matched = matchGitEntries(hooks, 'pre-commit')
      assert.strictEqual(matched.length, 1)
      assert.strictEqual(matched[0].checks[0].name, 'a')
    })

    it('returns empty for no matches', () => {
      const hooks = [
        { type: 'git', event: 'pre-push', checks: [] }
      ]
      assert.deepStrictEqual(matchGitEntries(hooks, 'pre-commit'), [])
    })

    it('ignores claude-type entries', () => {
      const hooks = [
        { type: 'claude', event: 'pre-commit', checks: [{ name: 'x' }] }
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
        { type: 'git', event: 'pre-commit', checks: [{ name: 'a' }] },
        { type: 'git', event: 'pre-commit', checks: [{ name: 'b' }] }
      ]
      const matched = matchGitEntries(hooks, 'pre-commit')
      assert.strictEqual(matched.length, 2)
    })
  })

  describe('runGitChecks', () => {
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

    it('returns no failures when all checks pass', () => {
      const scriptPath = makeScript('script/test', '#!/bin/bash\nexit 0\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        checks: [{ name: 'tests', type: 'script', command: scriptPath }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failures } = runGitChecks(entries, context)
      assert.strictEqual(failures.length, 0)
    })

    it('collects failures from failing checks', () => {
      const scriptPath = makeScript('script/test', '#!/bin/bash\necho "broken" >&2\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        checks: [{ name: 'tests', type: 'script', command: scriptPath }]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failures } = runGitChecks(entries, context)
      assert.strictEqual(failures.length, 1)
      assert.ok(failures[0].includes('tests:'))
    })

    it('runs all checks in "all" mode (default)', () => {
      const pass = makeScript('pass.sh', '#!/bin/bash\nexit 0\n')
      const fail1 = makeScript('fail1.sh', '#!/bin/bash\nexit 1\n')
      const fail2 = makeScript('fail2.sh', '#!/bin/bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        checks: [
          { name: 'a', type: 'script', command: fail1 },
          { name: 'b', type: 'script', command: pass },
          { name: 'c', type: 'script', command: fail2 }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failures } = runGitChecks(entries, context)
      assert.strictEqual(failures.length, 2)
    })

    it('stops on first failure in "first-fail" mode', () => {
      const fail1 = makeScript('fail1.sh', '#!/bin/bash\nexit 1\n')
      const fail2 = makeScript('fail2.sh', '#!/bin/bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        mode: 'first-fail',
        checks: [
          { name: 'a', type: 'script', command: fail1 },
          { name: 'b', type: 'script', command: fail2 }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failures } = runGitChecks(entries, context)
      assert.strictEqual(failures.length, 1)
      assert.ok(failures[0].startsWith('a:'))
    })

    it('skips checks with unsatisfied when condition', () => {
      const fail = makeScript('fail.sh', '#!/bin/bash\nexit 1\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        checks: [
          { name: 'a', type: 'script', command: fail, when: { fileExists: 'nonexistent-xyz' } }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failures } = runGitChecks(entries, context)
      assert.strictEqual(failures.length, 0)
    })

    it('skips unknown check types', () => {
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        checks: [
          { name: 'a', type: 'unknown', command: 'whatever' }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      const { failures } = runGitChecks(entries, context)
      assert.strictEqual(failures.length, 0)
    })

    it('propagates test output between checks', () => {
      const script = makeScript('output.sh', '#!/bin/bash\necho "test output here"\nexit 0\n')
      const entries = [{
        type: 'git',
        event: 'pre-commit',
        checks: [
          { name: 'a', type: 'script', command: script }
        ]
      }]
      const context = { rootDir: tmpDir, projectDir: tmpDir, localCfgPath: null, sources: null, maxChars: 12000, testOutput: '' }
      runGitChecks(entries, context)
      assert.ok(context.testOutput.includes('test output'))
    })
  })
})
