const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { getGitTasks, runGitTasks } = require('../../lib/dispatcher/git')
const { configDefaults } = require('../../lib/defaults')
const { readRef, churnSinceRef, sanitizeRefName } = require('../../lib/git')
const { freshRepo } = require('../helpers')

describe('git dispatcher', () => {
  it('configDefaults returns fully-qualified config', () => {
    const cfg = configDefaults()
    assert.strictEqual(cfg.enabled, false)
    assert.deepStrictEqual(cfg.hooks, {})
    assert.deepStrictEqual(cfg.sources, [])
    assert.deepStrictEqual(cfg.format, { maxOutputChars: 12000 })
    assert.strictEqual(cfg.maxAgentTurns, 20)
  })

  describe('getGitTasks', () => {
    it('returns tasks for matching event', () => {
      const hooks = {
        git: {
          'pre-commit': [{ name: 'a' }, { name: 'd' }],
          'pre-push': [{ name: 'b' }]
        },
        claude: {
          Stop: [{ name: 'c' }]
        }
      }

      const matched = getGitTasks(hooks, 'pre-commit')
      assert.strictEqual(matched.length, 2, 'should return both pre-commit tasks')
      assert.strictEqual(matched[0].name, 'a')
      assert.strictEqual(matched[1].name, 'd')

      // Returns empty for unmatched event
      assert.deepStrictEqual(getGitTasks(hooks, 'post-merge'), [])

      // Does not return claude tasks
      assert.deepStrictEqual(getGitTasks(hooks, 'Stop'), [])
    })

    it('handles edge cases', () => {
      assert.deepStrictEqual(getGitTasks({}, 'pre-commit'), [])
      assert.deepStrictEqual(getGitTasks({ git: {} }, 'pre-commit'), [])
      assert.deepStrictEqual(getGitTasks({ claude: { Stop: [] } }, 'pre-commit'), [])
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
        sources: [],
        maxChars: 12000,
        testOutput: '',
        ...overrides
      }
    }

    it('basic execution: pass/fail, fail-fast, output propagation', () => {
      const pass = makeScript('pass.sh', '#!/usr/bin/env bash\nexit 0\n')
      const fail1 = makeScript('fail1.sh', '#!/usr/bin/env bash\necho "broken" >&2\nexit 1\n')
      const fail2 = makeScript('fail2.sh', '#!/usr/bin/env bash\nexit 1\n')
      const outputScript = makeScript('output.sh', '#!/usr/bin/env bash\necho "test output here"\nexit 0\n')

      // All pass → no failure
      const ctx1 = makeContext()
      const { failure: f1 } = runGitTasks(
        [{ name: 'tests', type: 'script', command: pass }],
        ctx1
      )
      assert.strictEqual(f1, null)

      // Single failure → reported with task name
      const { failure: f2 } = runGitTasks(
        [{ name: 'tests', type: 'script', command: fail1 }],
        makeContext()
      )
      assert.ok(f2)
      assert.ok(f2.includes('tests:'))

      // Fail-fast: stops on first failure, does not run subsequent tasks
      const { failure: f3 } = runGitTasks(
        [
          { name: 'a', type: 'script', command: fail1 },
          { name: 'b', type: 'script', command: pass },
          { name: 'c', type: 'script', command: fail2 }
        ],
        makeContext()
      )
      assert.ok(f3, 'should report failure')
      assert.ok(f3.startsWith('a:'), 'should report first failing task')

      // Output propagation between tasks
      const ctx4 = makeContext()
      runGitTasks(
        [{ name: 'a', type: 'script', command: outputScript }],
        ctx4
      )
      assert.ok(ctx4.testOutput.includes('test output'))
    })

    it('skip conditions: when, unknown type, enabled flag', () => {
      const fail = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')

      // Unsatisfied when condition → skip (no failure)
      const { failure: f1 } = runGitTasks(
        [{ name: 'a', type: 'script', command: fail, when: { fileExists: 'nonexistent-xyz' } }],
        makeContext()
      )
      assert.strictEqual(f1, null, 'unsatisfied when should skip')

      // Unknown task type → skip (no failure)
      const { failure: f2 } = runGitTasks(
        [{ name: 'a', type: 'unknown', command: 'whatever' }],
        makeContext()
      )
      assert.strictEqual(f2, null, 'unknown type should skip')

      // enabled: false → skip (no failure despite failing script)
      const { failure: f3 } = runGitTasks(
        [{ name: 'disabled-task', type: 'script', command: fail, enabled: false }],
        makeContext()
      )
      assert.strictEqual(f3, null, 'disabled task should be skipped')

      // enabled: true → runs (failure reported)
      const { failure: f4 } = runGitTasks(
        [{ name: 'enabled-task', type: 'script', command: fail, enabled: true }],
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
      const churnTasks = [{
        name: 'churn-check',
        type: 'script',
        command: passScript,
        when: { linesChanged: 5 }
      }]
      const churnCtx = makeContext({ sources: ['**/*.js'] })
      const { failure: f1 } = runGitTasks(churnTasks, churnCtx)
      assert.strictEqual(f1, null, 'task should pass')

      const ref = readRef(tmpDir, sanitizeRefName('churn-check'))
      assert.strictEqual(ref, headBefore, 'ref should advance to HEAD after pass')

      // Re-running with no new churn → skip (no failure)
      const { failure: f1b } = runGitTasks(churnTasks, churnCtx)
      assert.strictEqual(f1b, null, 'should pass (task skipped due to 0 churn)')

      // --- Sticky on fail (ref does NOT advance) ---
      churnSinceRef(tmpDir, sanitizeRefName('sticky-check'), ['**/*.js'])

      const lines2 = Array.from({ length: 10 }, (_, i) => `sticky${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines2)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'more code'], { cwd: tmpDir })

      const refBefore = readRef(tmpDir, sanitizeRefName('sticky-check'))
      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const stickyTasks = [{
        name: 'sticky-check',
        type: 'script',
        command: failScript,
        when: { linesChanged: 5 }
      }]
      const { failure: f2 } = runGitTasks(stickyTasks, makeContext({ sources: ['**/*.js'] }))
      assert.ok(f2, 'task should fail')

      const refAfter = readRef(tmpDir, sanitizeRefName('sticky-check'))
      assert.strictEqual(refAfter, refBefore, 'ref should NOT advance on failure')

      // --- resetOnFail: true → advance even on failure ---
      churnSinceRef(tmpDir, sanitizeRefName('reset-check'), ['**/*.js'])

      const lines3 = Array.from({ length: 10 }, (_, i) => `reset${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines3)
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'reset code'], { cwd: tmpDir })

      const resetTasks = [{
        name: 'reset-check',
        type: 'script',
        command: failScript,
        when: { linesChanged: 5 },
        resetOnFail: true
      }]
      const { failure: f3 } = runGitTasks(resetTasks, makeContext({ sources: ['**/*.js'] }))
      assert.ok(f3, 'task should fail')

      // Re-running with no new churn → skip
      const { failure: f3b } = runGitTasks(resetTasks, makeContext({ sources: ['**/*.js'] }))
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
      const skipTasks = [{
        name: 'skip-check',
        type: 'agent',
        prompt: 'Review {{project_dir}}',
        command: skipReviewer,
        when: { linesChanged: 5 }
      }]
      const { failure: f1 } = runGitTasks(skipTasks, makeContext({ sources: ['**/*.js'] }))
      assert.strictEqual(f1, null, 'SKIP should not cause failure')

      const refAfter = readRef(tmpDir, sanitizeRefName('skip-check'))
      assert.strictEqual(refAfter, refBefore, 'ref should NOT advance on SKIP')

      // --- resetOnFail deadlock fix for uncommitted changes ---
      churnSinceRef(tmpDir, sanitizeRefName('deadlock-check'), ['**/*.js'])

      // Simulate agent Write—uncommitted changes (no commit!)
      const lines2 = Array.from({ length: 10 }, (_, i) => `deadlock${i}`).join('\n') + '\n'
      fs.writeFileSync(path.join(tmpDir, 'app.js'), lines2)

      const failScript = makeScript('fail.sh', '#!/usr/bin/env bash\nexit 1\n')
      const deadlockTasks = [{
        name: 'deadlock-check',
        type: 'script',
        command: failScript,
        when: { linesChanged: 5 },
        resetOnFail: true
      }]
      const deadlockCtx = makeContext({ sources: ['**/*.js'] })

      // First run: fires and fails, resetOnFail should snapshot working tree
      const { failure: f2 } = runGitTasks(deadlockTasks, deadlockCtx)
      assert.ok(f2, 'task should fail')

      // Second run: if snapshot worked, churn is 0 and task is skipped (no deadlock)
      const { failure: f2b } = runGitTasks(deadlockTasks, deadlockCtx)
      assert.strictEqual(f2b, null,
        'should skip after resetOnFail—ref should capture working tree, not just HEAD')
    })

    it('logs BOOM and continues when a task throws', () => {
      const origDir = process.env.PROVE_IT_DIR
      process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
      const sid = 'test-git-boom'

      try {
        // command: null causes runScriptCheck to throw a TypeError
        const tasks = [
          { name: 'crash-task', type: 'script', command: null }
        ]
        const ctx = makeContext({ sessionId: sid })
        const { failure } = runGitTasks(tasks, ctx)

        // Crash should not block — treated as a soft skip
        assert.strictEqual(failure, null, 'crash should not block the hook')

        // BOOM should be logged to the session file
        const logFile = path.join(process.env.PROVE_IT_DIR, 'sessions', `${sid}.jsonl`)
        const logEntries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
        const boom = logEntries.find(e => e.status === 'BOOM')
        assert.ok(boom, 'should log a BOOM entry')
        assert.ok(boom.reason.includes('crash-task crashed'), 'reason should name the task')
        assert.strictEqual(boom.reviewer, 'crash-task')
      } finally {
        if (origDir === undefined) delete process.env.PROVE_IT_DIR
        else process.env.PROVE_IT_DIR = origDir
      }
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
          [{ name: 'quiet-disabled', type: 'script', command: fail, enabled: false, quiet: true }],
          makeContext({ sessionId: sid })
        )

        // When-skipped task with quiet: true → no log
        runGitTasks(
          [{ name: 'quiet-gated', type: 'script', command: pass, quiet: true, when: { fileExists: 'nonexistent-xyz' } }],
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

  describe('strict Clean Runtime dispatch', () => {
    function writeJson (filePath, value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
    }

    function writeStrictConfig (repo, event, task) {
      const { PROFILE_VERSION } = require('../../lib/redesign/config')
      const workflowKey = event === 'pre-commit' ? 'pre_commit' : 'pre_push'
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: { strict_task: task },
        git_workflows: { [workflowKey]: ['strict_task'] },
        adapters: { claude: { enabled: true } }
      })
    }

    function writeLegacyFailingConfig (repo) {
      writeJson(path.join(repo, '.claude', 'prove_it', 'config.json'), {
        enabled: true,
        hooks: {
          git: {
            'pre-commit': [{ name: 'legacy-pre-commit', type: 'script', command: 'node -e "process.exit(9)"' }],
            'pre-push': [{ name: 'legacy-pre-push', type: 'script', command: 'node -e "process.exit(9)"' }]
          }
        }
      })
    }

    function invokeGitHook (repo, event, env = {}) {
      const cli = path.join(__dirname, '..', '..', 'cli.js')
      const home = fs.mkdtempSync(path.join(repo, 'home_'))
      return spawnSync('node', [cli, 'hook', `git:${event}`], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          CLAUDECODE: '1',
          ...env
        }
      })
    }

    for (const event of ['pre-commit', 'pre-push']) {
      it(`runs passing ${event} script tasks from strict .prove_it config with params and task-local env while ignoring stale legacy config`, () => {
        const repo = freshRepo()
        try {
          const probePath = path.join(repo, 'git-probe.js')
          fs.writeFileSync(probePath, `#!/usr/bin/env node
const fs = require('fs')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
function ok (condition, message) {
  if (!condition) {
    console.error(message)
    process.exit(1)
  }
}
ok(input.hook_event_name === '${event}', 'missing git hook event')
ok(input.adapter_id === 'git', 'missing git adapter id')
ok(input.workflow_stage === '${event === 'pre-commit' ? 'pre_commit' : 'pre_push'}', 'missing workflow stage')
ok(input.params && input.params.mode === 'strict', 'missing params')
ok(process.env.GIT_TASK_LOCAL_ENV === 'available', 'missing task-local env')
ok(Array.isArray(input.sources), 'missing source globs')
ok(Array.isArray(input.tests), 'missing test globs')
fs.appendFileSync('ran.txt', 'strict\\n')
`)
          fs.chmodSync(probePath, 0o755)
          writeStrictConfig(repo, event, {
            type: 'script',
            command: './git-probe.js',
            params: { mode: 'strict' },
            env: { GIT_TASK_LOCAL_ENV: 'available' },
            timeout_ms: 120000
          })
          writeLegacyFailingConfig(repo)

          const result = invokeGitHook(repo, event)

          assert.strictEqual(result.status, 0, result.stderr)
          assert.match(result.stderr, /prove_it: all checks passed/)
          assert.strictEqual(fs.readFileSync(path.join(repo, 'ran.txt'), 'utf8'), 'strict\n')
        } finally {
          fs.rmSync(repo, { recursive: true, force: true })
        }
      })

      it(`suppresses routine pass output for failures-only ${event} tasks`, () => {
        const repo = freshRepo()
        try {
          writeStrictConfig(repo, event, {
            type: 'script',
            command: 'node -e "console.log(\'routine pass details\')"',
            output: 'failures_only'
          })

          const result = invokeGitHook(repo, event)

          assert.strictEqual(result.status, 0, result.stderr)
          assert.strictEqual(result.stderr, '')
          assert.doesNotMatch(result.stdout, /routine pass details/)
        } finally {
          fs.rmSync(repo, { recursive: true, force: true })
        }
      })

      it(`blocks failing ${event} script tasks from strict .prove_it config`, () => {
        const repo = freshRepo()
        try {
          writeStrictConfig(repo, event, {
            type: 'script',
            command: 'node -e "console.error(\'strict failed\'); process.exit(7)"'
          })
          writeLegacyFailingConfig(repo)

          const result = invokeGitHook(repo, event)

          assert.strictEqual(result.status, 1)
          assert.match(result.stderr, /prove_it:/)
          assert.match(result.stderr, /strict_task/)
          assert.match(result.stderr, /strict failed/)
        } finally {
          fs.rmSync(repo, { recursive: true, force: true })
        }
      })
    }
  })
})
