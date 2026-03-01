const { describe, it } = require('node:test')
const assert = require('node:assert')
const { configHash } = require('../lib/config')
const {
  buildConfig,
  hasExecLine,
  isProveItAfterExec,
  PROVE_IT_SHIM_MARKER
} = require('../lib/init')

describe('init', () => {
  describe('buildConfig', () => {
    it('returns full config with defaults (all features)', () => {
      const cfg = buildConfig()
      assert.ok(cfg.enabled)
      assert.ok(Array.isArray(cfg.hooks))
      // Should have SessionStart hook
      assert.ok(cfg.hooks.some(h => h.type === 'claude' && h.event === 'SessionStart'),
        'Should have SessionStart hook entry')
      // Should have git hooks
      assert.ok(cfg.hooks.some(h => h.type === 'git' && h.event === 'pre-commit'))
      assert.ok(!cfg.hooks.some(h => h.type === 'git' && h.event === 'pre-push'))
      // Should have default checks
      const allChecks = cfg.hooks.flatMap(h => h.tasks || [])
      assert.ok(allChecks.some(c => c.name === 'session-briefing'),
        'Should have session-briefing task')
      assert.ok(allChecks.some(c => c.name === 'coverage-review'))
      assert.ok(allChecks.some(c => c.name === 'done-review'))
      // commit-review and ensure-tests should NOT be in defaults
      assert.ok(!allChecks.some(c => c.name === 'commit-review'))
      assert.ok(!allChecks.some(c => c.name === 'ensure-tests'))
    })

    it('SessionStart entry is first in hooks array', () => {
      const cfg = buildConfig()
      assert.strictEqual(cfg.hooks[0].event, 'SessionStart',
        'SessionStart should be the first hook entry')
      assert.strictEqual(cfg.hooks[0].tasks[0].name, 'session-briefing')
      assert.strictEqual(cfg.hooks[0].tasks[0].command, '$(prove_it prefix)/libexec/briefing')
    })

    it('omits git hooks when gitHooks is false', () => {
      const cfg = buildConfig({ gitHooks: false })
      assert.ok(cfg.enabled)
      assert.ok(!cfg.hooks.some(h => h.type === 'git'))
    })

    it('omits default checks when defaultChecks is false', () => {
      const cfg = buildConfig({ defaultChecks: false })
      assert.ok(cfg.enabled)
      const allChecks = cfg.hooks.flatMap(h => h.tasks || [])
      assert.ok(!allChecks.some(c => c.name === 'coverage-review'))
      assert.ok(!allChecks.some(c => c.name === 'done-review'))
    })

    it('returns base-only config with both features off', () => {
      const cfg = buildConfig({ gitHooks: false, defaultChecks: false })
      assert.ok(cfg.enabled)
      assert.ok(!cfg.hooks.some(h => h.type === 'git'))
      const allChecks = cfg.hooks.flatMap(h => h.tasks || [])
      assert.ok(!allChecks.some(c => c.name === 'coverage-review'))
      assert.ok(!allChecks.some(c => c.name === 'done-review'))
      // Should still have base checks
      assert.ok(allChecks.some(c => c.name === 'lock-config'))
      assert.ok(allChecks.some(c => c.name === 'fast-tests'))
    })

    it('coverage-review uses type agent with promptType skill, async, and net churn threshold', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      const coverageReview = allTasks.find(t => t.name === 'coverage-review')
      assert.ok(coverageReview, 'Should have coverage-review task')
      assert.strictEqual(coverageReview.type, 'agent')
      assert.strictEqual(coverageReview.async, true)
      assert.strictEqual(coverageReview.promptType, 'skill')
      assert.strictEqual(coverageReview.prompt, 'prove-coverage')
      assert.strictEqual(coverageReview.when.linesChanged, 541)
    })

    it('all default agent tasks are in Stop entry', () => {
      const cfg = buildConfig()
      const stopEntry = cfg.hooks.find(h => h.type === 'claude' && h.event === 'Stop')
      assert.ok(stopEntry, 'Should have Stop entry')
      assert.ok(stopEntry.tasks.some(t => t.name === 'coverage-review'),
        'coverage-review should be in Stop entry')
      assert.ok(stopEntry.tasks.some(t => t.name === 'done-review'),
        'done-review should be in Stop entry')
    })

    it('done-review uses signal when condition, opus model, and is synchronous', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      const signalReview = allTasks.find(t => t.name === 'done-review')
      assert.ok(signalReview, 'Should have done-review task')
      assert.strictEqual(signalReview.type, 'agent')
      assert.strictEqual(signalReview.promptType, 'skill')
      assert.strictEqual(signalReview.prompt, 'prove-done')
      assert.strictEqual(signalReview.model, 'opus')
      assert.deepStrictEqual(signalReview.when, { signal: 'done' })
      assert.strictEqual(signalReview.async, undefined,
        'done-review should be synchronous (no async property)')
    })

    it('all default agent tasks include ruleFile', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      const agentTasks = allTasks.filter(t => t.type === 'agent')
      assert.ok(agentTasks.length >= 2, 'Should have at least 2 agent tasks')
      for (const task of agentTasks) {
        assert.ok(typeof task.ruleFile === 'string' && task.ruleFile.length > 0,
          `Agent task "${task.name}" should have a non-empty ruleFile`)
      }
    })

    it('done-review uses done.md ruleFile', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      const doneReview = allTasks.find(t => t.name === 'done-review')
      assert.strictEqual(doneReview.ruleFile, '.claude/rules/done.md')
    })

    it('coverage-review and approach-review use testing.md ruleFile', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      for (const name of ['coverage-review', 'approach-review']) {
        const task = allTasks.find(t => t.name === name)
        assert.strictEqual(task.ruleFile, '.claude/rules/testing.md',
          `${name} should use testing.md ruleFile`)
      }
    })

    it('lock-config task has quiet: true', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      const lockConfig = allTasks.find(t => t.name === 'lock-config')
      assert.ok(lockConfig, 'Should have lock-config task')
      assert.strictEqual(lockConfig.quiet, true, 'lock-config should have quiet: true')
    })

    it('session-briefing task has quiet: true', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      const briefing = allTasks.find(t => t.name === 'session-briefing')
      assert.ok(briefing, 'Should have session-briefing task')
      assert.strictEqual(briefing.quiet, true, 'session-briefing should have quiet: true')
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
