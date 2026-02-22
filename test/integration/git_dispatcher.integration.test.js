const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { defaultConfig, matchGitEntries, runGitTasks } = require('../../lib/dispatcher/git')
const { readRef, churnSinceRef, sanitizeRefName } = require('../../lib/git')
const { freshRepo } = require('../helpers')

describe('git dispatcher', () => {
  it('defaultConfig returns safe defaults', () => {
    const cfg = defaultConfig()
    assert.strictEqual(cfg.enabled, false)
    assert.deepStrictEqual(cfg.hooks, [])
    assert.strictEqual(cfg.sources, null)
    assert.strictEqual(cfg.format, undefined)
  })

  describe('matchGitEntries', () => {
    it('matches git entries by event, ignoring non-git types', () => {
      const hooks = [
        { type: 'git', event: 'pre-commit', tasks: [{ name: 'a' }] },
        { type: 'git', event: 'pre-push', tasks: [{ name: 'b' }] },
        { type: 'claude', event: 'Stop', tasks: [{ name: 'c' }] },
        { type: 'git', event: 'pre-commit', tasks: [{ name: 'd' }] },
        { type: 'claude', event: 'pre-commit', tasks: [{ name: 'e' }] }
      ]

      // Matches correct event
      const matched = matchGitEntries(hooks, 'pre-commit')
      assert.strictEqual(matched.length, 2, 'should match both pre-commit git entries')
      assert.strictEqual(matched[0].tasks[0].name, 'a')
      assert.strictEqual(matched[1].tasks[0].name, 'd')

      // Returns empty for unmatched event
      assert.deepStrictEqual(matchGitEntries(hooks, 'post-merge'), [])

      // Ignores claude-type entries even when event matches
      const claudeOnly = [{ type: 'claude', event: 'pre-commit', tasks: [{ name: 'x' }] }]
      assert.deepStrictEqual(matchGitEntries(claudeOnly, 'pre-commit'), [])
    })

    it('handles edge cases', () => {
      assert.deepStrictEqual(matchGitEntries(null, 'pre-commit'), [])
      assert.deepStrictEqual(matchGitEntries('not-an-array', 'pre-commit'), [])
      assert.deepStrictEqual(matchGitEntries(undefined, 'pre-commit'), [])
    })
  })

  describe('runGitTasks', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = freshRepo((dir) => {
        fs.writeFileSync(path.join(dir, 'app.js'), 'initial\n')
      })
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

    function makeContext (overrides = {}) {
      return {
        rootDir: tmpDir,
        projectDir: tmpDir,
        sessionId: null,
        hookEvent: 'pre-commit',
        localCfgPath: null,
        sources: null,
        maxChars: 12000,
        testOutput: '',
        ...overrides
      }
    }

    function makeEntries (tasks) {
      return [{ type: 'git', event: 'pre-commit', tasks }]
    }

    it('basic execution: pass/fail, fail-fast, output propagation', () => {
      const pass = makeScript('pass.sh', '#!/usr/bin/env bash\nexit 0\n')
      const fail1 = makeScript('fail1.sh', '#!/usr/bin/env bash\necho "broken" >&2\nexit 1\n')
      const fail2 = makeScript('fail2.sh', '#!/usr/bin/env bash\nexit 1\n')
      const outputScript = makeScript('output.sh', '#!/usr/bin/env bash\necho "test output here"\nexit 0\n')

      // All pass → no failure
      const ctx1 = makeContext()
      const { failure: f1 } = runGitTasks(
        makeEntries([{ name: 'tests', type: 'script', command: pass }]),
        ctx1
      )
      assert.strictEqual(f1, null)

      // Single failure → reported with task name
      const { failure: f2 } = runGitTasks(
        makeEntries([{ name: 'tests', type: 'script', command: fail1 }]),
        makeContext()
      )
      assert.ok(f2)
      assert.ok(f2.includes('tests:'))

      // Fail-fast: stops on first failure, does not run subsequent tasks
      const { failure: f3 } = runGitTasks(
        makeEntries([
          { name: 'a', type: 'script', command: fail1 },
          { name: 'b', type: 'script', command: pass },
          { name: 'c', type: 'script', command: fail2 }
        ]),
        makeContext()
      )
      assert.ok(f3, 'should report failure')
      assert.ok(f3.startsWith('a:'), 'should report first failing task')

      // Output propagation between tasks
      const ctx4 = makeContext()
      runGitTasks(
        makeEntries([{ name: 'a', type: 'script', command: outputScript }]),
        ctx4
      )
      assert.ok(ctx4.testOutput.includes('test output'))
    })

    it('skip conditions: when, unknown type, enabled flag', () => {
      const fail = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')

      // Unsatisfied when condition → skip (no failure)
      const { failure: f1 } = runGitTasks(
        makeEntries([{ name: 'a', type: 'script', command: fail, when: { fileExists: 'nonexistent-xyz' } }]),
        makeContext()
      )
      assert.strictEqual(f1, null, 'unsatisfied when should skip')

      // Unknown task type → skip (no failure)
      const { failure: f2 } = runGitTasks(
        makeEntries([{ name: 'a', type: 'unknown', command: 'whatever' }]),
        makeContext()
      )
      assert.strictEqual(f2, null, 'unknown type should skip')

      // enabled: false → skip (no failure despite failing script)
      const { failure: f3 } = runGitTasks(
        makeEntries([{ name: 'disabled-task', type: 'script', command: fail, enabled: false }]),
        makeContext()
      )
      assert.strictEqual(f3, null, 'disabled task should be skipped')

      // enabled: true → runs (failure reported)
      const { failure: f4 } = runGitTasks(
        makeEntries([{ name: 'enabled-task', type: 'script', command: fail, enabled: true }]),
        makeContext()
      )
      assert.ok(f4, 'enabled task should execute and report failure')
      assert.ok(f4.includes('enabled-task'), 'failure should name the task')
    })

    it('churn advancement: advance on pass, sticky on fail, resetOnFail', () => {
      // --- Advance on pass ---
      churnSinceRef(tmpDir, sanitizeRefName('churn-check'), ['**/*.js'])

      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add code'], { cwd: tmpDir })

      const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
      const passScript = makeScript('pass.sh', '#!/usr/bin/env bash\nexit 0\n')
      const churnEntries = makeEntries([{
        name: 'churn-check',
        type: 'script',
        command: passScript,
        when: { linesChanged: 5 }
      }])
      const churnCtx = makeContext({ sources: ['**/*.js'] })
      const { failure: f1 } = runGitTasks(churnEntries, churnCtx)
      assert.strictEqual(f1, null, 'task should pass')

      const ref = readRef(tmpDir, sanitizeRefName('churn-check'))
      assert.strictEqual(ref, headBefore, 'ref should advance to HEAD after pass')

      // Re-running with no new churn → skip (no failure)
      const { failure: f1b } = runGitTasks(churnEntries, churnCtx)
      assert.strictEqual(f1b, null, 'should pass (task skipped due to 0 churn)')

      // --- Sticky on fail (ref does NOT advance) ---
      churnSinceRef(tmpDir, sanitizeRefName('sticky-check'), ['**/*.js'])

      const lines2 = Array.from({ length: 10 }, (_, i) => `sticky${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines2)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'more code'], { cwd: tmpDir })

      const refBefore = readRef(tmpDir, sanitizeRefName('sticky-check'))
      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const stickyEntries = makeEntries([{
        name: 'sticky-check',
        type: 'script',
        command: failScript,
        when: { linesChanged: 5 }
      }])
      const { failure: f2 } = runGitTasks(stickyEntries, makeContext({ sources: ['**/*.js'] }))
      assert.ok(f2, 'task should fail')

      const refAfter = readRef(tmpDir, sanitizeRefName('sticky-check'))
      assert.strictEqual(refAfter, refBefore, 'ref should NOT advance on failure')

      // --- resetOnFail: true → advance even on failure ---
      churnSinceRef(tmpDir, sanitizeRefName('reset-check'), ['**/*.js'])

      const lines3 = Array.from({ length: 10 }, (_, i) => `reset${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines3)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'reset code'], { cwd: tmpDir })

      const resetEntries = makeEntries([{
        name: 'reset-check',
        type: 'script',
        command: failScript,
        when: { linesChanged: 5 },
        resetOnFail: true
      }])
      const { failure: f3 } = runGitTasks(resetEntries, makeContext({ sources: ['**/*.js'] }))
      assert.ok(f3, 'task should fail')

      // Re-running with no new churn → skip
      const { failure: f3b } = runGitTasks(resetEntries, makeContext({ sources: ['**/*.js'] }))
      assert.strictEqual(f3b, null, 'should skip after resetOnFail advanced ref')
    })

    it('churn edge cases: no advance on SKIP, resetOnFail deadlock fix for uncommitted changes', () => {
      // --- No advance on SKIP ---
      churnSinceRef(tmpDir, sanitizeRefName('skip-check'), ['**/*.js'])

      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'add code'], { cwd: tmpDir })

      const refBefore = readRef(tmpDir, sanitizeRefName('skip-check'))

      const skipReviewer = makeScript('skip_reviewer.sh', '#!/usr/bin/env bash\ncat > /dev/null\necho "SKIP: mid-refactor"\n')
      const skipEntries = makeEntries([{
        name: 'skip-check',
        type: 'agent',
        prompt: 'Review {{project_dir}}',
        command: skipReviewer,
        when: { linesChanged: 5 }
      }])
      const { failure: f1 } = runGitTasks(skipEntries, makeContext({ sources: ['**/*.js'] }))
      assert.strictEqual(f1, null, 'SKIP should not cause failure')

      const refAfter = readRef(tmpDir, sanitizeRefName('skip-check'))
      assert.strictEqual(refAfter, refBefore, 'ref should NOT advance on SKIP')

      // --- resetOnFail deadlock fix for uncommitted changes ---
      churnSinceRef(tmpDir, sanitizeRefName('deadlock-check'), ['**/*.js'])

      // Simulate agent Write—uncommitted changes (no commit!)
      const lines2 = Array.from({ length: 10 }, (_, i) => `deadlock${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines2)

      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const deadlockEntries = makeEntries([{
        name: 'deadlock-check',
        type: 'script',
        command: failScript,
        when: { linesChanged: 5 },
        resetOnFail: true
      }])
      const deadlockCtx = makeContext({ sources: ['**/*.js'] })

      // First run: fires and fails, resetOnFail should snapshot working tree
      const { failure: f2 } = runGitTasks(deadlockEntries, deadlockCtx)
      assert.ok(f2, 'task should fail')

      // Second run: if snapshot worked, churn is 0 and task is skipped (no deadlock)
      const { failure: f2b } = runGitTasks(deadlockEntries, deadlockCtx)
      assert.strictEqual(f2b, null,
        'should skip after resetOnFail—ref should capture working tree, not just HEAD')
    })

    it('quiet flag suppresses SKIP log entries', () => {
      const origDir = process.env.PROVE_IT_DIR
      process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
      const sid = 'test-git-quiet'

      try {
        const fail = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
        const pass = makeScript('pass.sh', '#!/usr/bin/env bash\nexit 0\n')

        // Disabled task with quiet: true → no log
        runGitTasks(
          makeEntries([{ name: 'quiet-disabled', type: 'script', command: fail, enabled: false, quiet: true }]),
          makeContext({ sessionId: sid })
        )

        // When-skipped task with quiet: true → no log
        runGitTasks(
          makeEntries([{ name: 'quiet-gated', type: 'script', command: pass, quiet: true, when: { fileExists: 'nonexistent-xyz' } }]),
          makeContext({ sessionId: sid })
        )

        const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sid}.jsonl`)
        const logEntries = fs.existsSync(logFile)
          ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
          : []

        assert.strictEqual(logEntries.length, 0, 'quiet SKIP tasks should produce no log entries')
      } finally {
        if (origDir === undefined) delete process.env.PROVE_IT_DIR
        else process.env.PROVE_IT_DIR = origDir
      }
    })
  })
})
