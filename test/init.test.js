const { describe, it } = require('node:test')
const assert = require('node:assert')
const { configHash } = require('../lib/config')
const {
  buildConfig,
  hasExecLine,
  isProveItAfterExec,
  PROVE_IT_SHIM_MARKER
} = require('../lib/init')

function allTasks (hooks) {
  const tasks = []
  for (const events of Object.values(hooks || {})) {
    for (const arr of Object.values(events || {})) {
      if (Array.isArray(arr)) tasks.push(...arr)
    }
  }
  return tasks
}

describe('init', () => {
  describe('buildConfig', () => {
    it('returns full config with defaults (all features)', () => {
      const cfg = buildConfig()
      assert.ok(cfg.enabled)
      assert.ok(typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks))
      // Should have SessionStart hook
      assert.ok(cfg.hooks.claude && cfg.hooks.claude.SessionStart,
        'Should have SessionStart tasks')
      // Should have git hooks
      assert.ok(cfg.hooks.git && cfg.hooks.git['pre-commit'])
      assert.ok(!cfg.hooks.git['pre-push'])
      // Should have default checks
      const allChecks = allTasks(cfg.hooks)
      assert.ok(allChecks.some(c => c.name === 'session-briefing'),
        'Should have session-briefing task')
      assert.ok(allChecks.some(c => c.name === 'coverage-review'))
      assert.ok(allChecks.some(c => c.name === 'done-review'))
      // commit-review and ensure-tests should NOT be in defaults
      assert.ok(!allChecks.some(c => c.name === 'commit-review'))
      assert.ok(!allChecks.some(c => c.name === 'ensure-tests'))
    })

    it('SessionStart has session-briefing task', () => {
      const cfg = buildConfig()
      const tasks = cfg.hooks.claude.SessionStart
      assert.ok(tasks.length > 0)
      assert.strictEqual(tasks[0].name, 'session-briefing')
      assert.strictEqual(tasks[0].command, '$(prove_it prefix)/libexec/briefing')
    })

    it('omits git hooks when gitHooks is false', () => {
      const cfg = buildConfig({ gitHooks: false })
      assert.ok(cfg.enabled)
      assert.ok(!cfg.hooks.git)
    })

    it('omits default checks when defaultChecks is false', () => {
      const cfg = buildConfig({ defaultChecks: false })
      assert.ok(cfg.enabled)
      const checks = allTasks(cfg.hooks)
      assert.ok(!checks.some(c => c.name === 'coverage-review'))
      assert.ok(!checks.some(c => c.name === 'done-review'))
    })

    it('returns base-only config with both features off', () => {
      const cfg = buildConfig({ gitHooks: false, defaultChecks: false })
      assert.ok(cfg.enabled)
      assert.ok(!cfg.hooks.git)
      const checks = allTasks(cfg.hooks)
      assert.ok(!checks.some(c => c.name === 'coverage-review'))
      assert.ok(!checks.some(c => c.name === 'done-review'))
      // Should still have base checks
      assert.ok(checks.some(c => c.name === 'lock-config'))
      assert.ok(checks.some(c => c.name === 'fast-tests'))
    })

    it('coverage-review uses type agent with promptType skill, async, and net churn threshold', () => {
      const cfg = buildConfig()
      const tasks = allTasks(cfg.hooks)
      const coverageReview = tasks.find(t => t.name === 'coverage-review')
      assert.ok(coverageReview, 'Should have coverage-review task')
      assert.strictEqual(coverageReview.type, 'agent')
      assert.strictEqual(coverageReview.async, true)
      assert.strictEqual(coverageReview.promptType, 'skill')
      assert.strictEqual(coverageReview.prompt, 'prove-coverage')
      assert.strictEqual(coverageReview.when.linesChanged, 541)
    })

    it('all default agent tasks are in Stop entry', () => {
      const cfg = buildConfig()
      const stopEntry = { tasks: cfg.hooks.claude && cfg.hooks.claude.Stop }
      assert.ok(stopEntry, 'Should have Stop entry')
      assert.ok(stopEntry.tasks.some(t => t.name === 'coverage-review'),
        'coverage-review should be in Stop entry')
      assert.ok(stopEntry.tasks.some(t => t.name === 'done-review'),
        'done-review should be in Stop entry')
    })

    it('done-review uses signal when condition, opus model, and is synchronous', () => {
      const cfg = buildConfig()
      const tasks = allTasks(cfg.hooks)
      const signalReview = tasks.find(t => t.name === 'done-review')
      assert.ok(signalReview, 'Should have done-review task')
      assert.strictEqual(signalReview.type, 'agent')
      assert.strictEqual(signalReview.promptType, 'skill')
      assert.strictEqual(signalReview.prompt, 'prove-done')
      assert.strictEqual(signalReview.model, 'opus')
      assert.deepStrictEqual(signalReview.when, { signal: 'done' })
      assert.strictEqual(signalReview.async, undefined,
        'done-review should be synchronous (no async property)')
    })

    it('done-review uses done.md ruleFile', () => {
      const cfg = buildConfig()
      const tasks = allTasks(cfg.hooks)
      const doneReview = tasks.find(t => t.name === 'done-review')
      assert.strictEqual(doneReview.ruleFile, '.claude/rules/done.md')
    })

    it('coverage-review uses testing.md ruleFile', () => {
      const cfg = buildConfig()
      const tasks = allTasks(cfg.hooks)
      const task = tasks.find(t => t.name === 'coverage-review')
      assert.strictEqual(task.ruleFile, '.claude/rules/testing.md')
    })

    it('approach-review has no ruleFile', () => {
      const cfg = buildConfig()
      const tasks = allTasks(cfg.hooks)
      const task = tasks.find(t => t.name === 'approach-review')
      assert.strictEqual(task.ruleFile, undefined)
    })

    it('lock-config task has quiet: true', () => {
      const cfg = buildConfig()
      const tasks = allTasks(cfg.hooks)
      const lockConfig = tasks.find(t => t.name === 'lock-config')
      assert.ok(lockConfig, 'Should have lock-config task')
      assert.strictEqual(lockConfig.quiet, true, 'lock-config should have quiet: true')
    })

    it('session-briefing task has quiet: true', () => {
      const cfg = buildConfig()
      const tasks = allTasks(cfg.hooks)
      const briefing = tasks.find(t => t.name === 'session-briefing')
      assert.ok(briefing, 'Should have session-briefing task')
      assert.strictEqual(briefing.quiet, true, 'session-briefing should have quiet: true')
    })

    it('ui-design-review is in Stop entry with parallel, sonnet model, and signal+fileExists when condition', () => {
      const cfg = buildConfig()
      const stopTasks = cfg.hooks.claude.Stop
      const task = stopTasks.find(t => t.name === 'ui-design-review')
      assert.ok(task, 'Should have ui-design-review task in Stop')
      assert.strictEqual(task.type, 'agent')
      assert.strictEqual(task.parallel, true)
      assert.strictEqual(task.promptType, 'skill')
      assert.strictEqual(task.prompt, 'prove-ui-design')
      assert.strictEqual(task.model, 'sonnet')
      assert.deepStrictEqual(task.when, { signal: 'done', fileExists: '.claude/rules/ui-design.md' })
    })

    it('ui-design-review uses ui-design.md ruleFile', () => {
      const cfg = buildConfig()
      const tasks = allTasks(cfg.hooks)
      const task = tasks.find(t => t.name === 'ui-design-review')
      assert.strictEqual(task.ruleFile, '.claude/rules/ui-design.md')
    })

    it('ui-design-review not present when defaultChecks is false', () => {
      const cfg = buildConfig({ defaultChecks: false })
      const checks = allTasks(cfg.hooks)
      assert.ok(!checks.some(c => c.name === 'ui-design-review'))
    })

    it('generated config passes validation', () => {
      const { validateConfig } = require('../lib/validate')
      const cfg = buildConfig()
      const { errors } = validateConfig(cfg)
      assert.deepStrictEqual(errors, [], `buildConfig() should produce valid config, got errors: ${errors.join('; ')}`)
    })
  })

  describe('hasExecLine', () => {
    it('returns true for line starting with exec', () => {
      assert.ok(hasExecLine('#!/usr/bin/env bash\nexec other-tool hook pre-commit "$@"\n'))
    })

    it('returns false for exec in a comment', () => {
      assert.ok(!hasExecLine('#!/usr/bin/env bash\n# exec other-tool hook pre-commit\nrun-lint\n'))
    })

    it('returns false when no exec present', () => {
      assert.ok(!hasExecLine('#!/usr/bin/env bash\nrun-lint\nnpm test\n'))
    })

    it('returns true for indented exec', () => {
      assert.ok(hasExecLine('#!/usr/bin/env bash\n  exec other-tool hook pre-commit "$@"\n'))
    })
  })

  describe('isProveItAfterExec', () => {
    it('returns true when prove_it section is after exec', () => {
      const content = [
        '#!/usr/bin/env bash',
        'exec other-tool hook pre-commit "$@"',
        '',
        PROVE_IT_SHIM_MARKER,
        'prove_it hook git:pre-commit',
        PROVE_IT_SHIM_MARKER
      ].join('\n')
      assert.ok(isProveItAfterExec(content))
    })

    it('returns false when prove_it section is before exec', () => {
      const content = [
        '#!/usr/bin/env bash',
        PROVE_IT_SHIM_MARKER,
        'prove_it hook git:pre-commit',
        PROVE_IT_SHIM_MARKER,
        '',
        'exec other-tool hook pre-commit "$@"'
      ].join('\n')
      assert.ok(!isProveItAfterExec(content))
    })

    it('returns false when no exec present', () => {
      const content = [
        '#!/usr/bin/env bash',
        'run-lint',
        PROVE_IT_SHIM_MARKER,
        'prove_it hook git:pre-commit',
        PROVE_IT_SHIM_MARKER
      ].join('\n')
      assert.ok(!isProveItAfterExec(content))
    })
  })

  describe('configHash', () => {
    it('returns consistent hash for same content', () => {
      const cfg = { enabled: true, hooks: [] }
      assert.strictEqual(configHash(cfg), configHash(cfg))
    })

    it('returns different hash for different content', () => {
      const cfg1 = { enabled: true, hooks: [] }
      const cfg2 = { enabled: false, hooks: [] }
      assert.notStrictEqual(configHash(cfg1), configHash(cfg2))
    })

    it('ignores initSeed field', () => {
      const cfg1 = { hooks: [] }
      const cfg2 = { hooks: [], initSeed: 'abc123def456' }
      assert.strictEqual(configHash(cfg1), configHash(cfg2))
    })
  })
})
