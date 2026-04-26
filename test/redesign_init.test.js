const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { behaviorForCapability } = require('../lib/adapter_capabilities')

function tmpRepo () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_redesign_init_'))
}

function readJson (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

describe('redesign adapter-aware init/deinit', () => {
  it('creates strict .prove_it config with explicit adapters and owned Claude-native settings', () => {
    const { PROFILE_VERSION, validateConfig } = require('../lib/redesign/config')
    const { initStrictProject } = require('../lib/redesign/init')
    const repo = tmpRepo()

    try {
      const result = initStrictProject(repo, { adapters: ['pi', 'claude'] })
      const cfg = readJson(path.join(repo, '.prove_it', 'config.json'))
      const manifest = readJson(path.join(repo, '.prove_it', 'ownership.json'))
      const claudeSettings = readJson(path.join(repo, '.claude', 'settings.json'))

      assert.strictEqual(result.config.created, true)
      assert.strictEqual(cfg.profile_version, PROFILE_VERSION)
      assert.strictEqual(cfg.profile, 'strict')
      assert.strictEqual(cfg.adapters.pi.enabled, true)
      assert.strictEqual(cfg.adapters.claude.enabled, true)
      assert.doesNotThrow(() => validateConfig(cfg, '.prove_it/config.json'))
      assert.ok(!fs.existsSync(path.join(repo, '.claude', 'prove_it', 'config.json')))
      assert.match(JSON.stringify(claudeSettings), /prove_it hook claude:PreToolUse/)
      assert.match(JSON.stringify(claudeSettings), /prove_it hook claude:Stop/)
      assert.deepStrictEqual(
        manifest.artifacts.map(artifact => artifact.path).sort(),
        [
          '.claude/settings.json',
          '.prove_it/.gitignore',
          '.prove_it/config.json',
          '.prove_it/config.local.json'
        ]
      )
      assert.ok(manifest.artifacts.every(artifact => artifact.owner === 'prove_it'))
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('can safely re-run init to add adapters without losing ownership of existing artifacts', () => {
    const { initStrictProject, deinitStrictProject } = require('../lib/redesign/init')
    const repo = tmpRepo()

    try {
      initStrictProject(repo, { adapters: ['pi'] })
      initStrictProject(repo, { adapters: ['pi', 'claude'] })
      const cfg = readJson(path.join(repo, '.prove_it', 'config.json'))
      const manifest = readJson(path.join(repo, '.prove_it', 'ownership.json'))

      assert.strictEqual(cfg.profile, 'strict')
      assert.strictEqual(cfg.adapters.pi.enabled, true)
      assert.strictEqual(cfg.adapters.claude.enabled, true)
      assert.ok(manifest.artifacts.some(artifact => artifact.path === '.prove_it/config.json'))
      assert.ok(manifest.artifacts.some(artifact => artifact.path === '.claude/settings.json'))

      deinitStrictProject(repo)
      assert.ok(!fs.existsSync(path.join(repo, '.prove_it', 'config.json')))
      assert.ok(!fs.existsSync(path.join(repo, '.claude', 'settings.json')))
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('uses the strict profile for multi-adapter init so Pi does not inherit Claude-only defaults', () => {
    const { loadEffectiveConfig } = require('../lib/redesign/config')
    const { initStrictProject } = require('../lib/redesign/init')
    const repo = tmpRepo()

    try {
      initStrictProject(repo, { adapters: ['pi', 'claude'] })
      const cfg = loadEffectiveConfig(repo).effective

      assert.strictEqual(cfg.profile, 'strict')
      assert.deepStrictEqual(cfg.agent_workflows.pre_tool, ['protect_prove_it_config'])
      assert.deepStrictEqual(cfg.agent_workflows.agent_end, [])
      assert.ok(!Object.prototype.hasOwnProperty.call(cfg.tasks, 'done_review'))
      assert.strictEqual(cfg.adapters.pi.enabled, true)
      assert.strictEqual(cfg.adapters.claude.enabled, true)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('activates Claude parity profile defaults for initialized Claude strict projects', () => {
    const { loadEffectiveConfig } = require('../lib/redesign/config')
    const { runWorkflowEngine } = require('../lib/redesign/engine')
    const { normalizeLifecycleEvent } = require('../lib/redesign/events')
    const { initStrictProject } = require('../lib/redesign/init')
    const { createMemoryStatePort } = require('../lib/redesign/state_port')
    const repo = tmpRepo()

    try {
      initStrictProject(repo, { adapters: ['claude'] })
      const explained = loadEffectiveConfig(repo)
      const cfg = explained.effective

      assert.deepStrictEqual(explained.source_layers[0].kind, 'profile')
      assert.strictEqual(explained.source_layers[0].name, 'claude-parity')
      assert.deepStrictEqual(cfg.agent_workflows.pre_tool.slice(0, 2), [
        'protect_prove_it_config',
        'test_first'
      ])
      assert.strictEqual(cfg.tasks.protect_prove_it_config.type, 'config_guard')
      assert.strictEqual(cfg.tasks.full_tests.parallel, true)
      assert.deepStrictEqual(cfg.tasks.full_tests.when, { signal: 'done', sourceFilesEdited: true })
      assert.strictEqual(cfg.tasks.done_review.type, 'reviewer')
      assert.strictEqual(cfg.tasks.done_review.provider, 'claude')
      assert.strictEqual(cfg.tasks.done_review.parallel, true)
      assert.strictEqual(cfg.tasks.testing_antipatterns_review.type, 'reviewer')
      assert.strictEqual(cfg.tasks.testing_antipatterns_review.async, true)
      assert.ok(!fs.existsSync(path.join(repo, '.claude', 'prove_it', 'config.json')))

      const guardEffect = runWorkflowEngine({
        event: normalizeLifecycleEvent({
          adapterId: 'claude',
          rawEventName: 'PreToolUse',
          rawEvent: { session_id: 'session-guard', tool_name: 'Write', tool_input: { file_path: path.join(repo, '.prove_it', 'config.json') } },
          cwd: repo
        }),
        effectiveConfig: cfg
      })
      assert.strictEqual(guardEffect.effect, 'block')
      assert.match(guardEffect.reason, /\.prove_it\/config\.json/)

      const planEffect = runWorkflowEngine({
        event: normalizeLifecycleEvent({
          adapterId: 'claude',
          rawEventName: 'PreToolUse',
          rawEvent: { session_id: 'session-plan', tool_name: 'ExitPlanMode', tool_input: { plan: '### 1. Build' } },
          cwd: repo
        }),
        effectiveConfig: cfg,
        taskPort: {
          run ({ taskName }) {
            if (taskName !== 'verify_assumptions') return { pass: true, reason: 'ok', output: '' }
            return { pass: true, reason: 'verified', output: 'BLOCKING REQUIREMENT: audit every assumption' }
          }
        }
      })
      assert.strictEqual(planEffect.effect, 'allow')
      assert.match(planEffect.reason, /BLOCKING REQUIREMENT/)

      const statePort = createMemoryStatePort()
      statePort.writeSignal('session-done', { type: 'done', message: 'ready', at: 123 })
      const startedScripts = []
      const startedReviewers = []
      const taskPort = {
        startParallelTask ({ taskName }) {
          startedScripts.push(taskName)
          return { id: `${taskName}-parallel` }
        },
        settleParallelBatch (handles) {
          return handles.map(handle => ({ id: handle.id, taskName: handle.taskName, task: handle.task, result: { pass: true, reason: `${handle.taskName} passed` } }))
        },
        cleanupTasks () {}
      }
      const reviewerPort = {
        startParallelTask ({ taskName }) {
          startedReviewers.push(taskName)
          return { id: `${taskName}-parallel` }
        },
        settleParallelBatch (handles) {
          return handles.map(handle => ({ id: handle.id, taskName: handle.taskName, task: handle.task, result: { pass: true, reason: `${handle.taskName} passed` } }))
        },
        cleanupTasks () {}
      }
      const doneEffect = runWorkflowEngine({
        event: normalizeLifecycleEvent({
          adapterId: 'claude',
          rawEventName: 'Stop',
          rawEvent: { session_id: 'session-done' },
          cwd: repo
        }),
        effectiveConfig: cfg,
        adapterCapabilities: {
          completion_verification: behaviorForCapability('claude', 'completion_verification')
        },
        statePort,
        taskPort,
        reviewerPort,
        observationPort: {
          facts: {
            editedFiles: ['src/app.js']
          }
        }
      })
      assert.strictEqual(doneEffect.effect, 'approve')
      assert.deepStrictEqual(startedScripts, ['full_tests'])
      assert.deepStrictEqual(startedReviewers, ['done_review'])
      assert.strictEqual(doneEffect.signalLifecycle.action, 'clear')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('deinitializes only manifest-owned artifacts and preserves modified files', () => {
    const { initStrictProject, deinitStrictProject } = require('../lib/redesign/init')
    const repo = tmpRepo()

    try {
      initStrictProject(repo, { adapters: ['claude'] })
      fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ custom: true }, null, 2) + '\n')

      const result = deinitStrictProject(repo)

      assert.ok(fs.existsSync(path.join(repo, '.claude', 'settings.json')))
      assert.ok(!fs.existsSync(path.join(repo, '.prove_it', 'config.json')))
      assert.ok(!fs.existsSync(path.join(repo, '.prove_it', 'config.local.json')))
      assert.ok(result.removed.includes('.prove_it/config.json'))
      assert.ok(result.skipped.some(entry => entry.path === '.claude/settings.json' && entry.reason === 'modified'))
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('refuses manifest paths that escape the repository', () => {
    const { deinitStrictProject } = require('../lib/redesign/init')
    const repo = tmpRepo()
    const outside = path.join(os.tmpdir(), `prove_it_outside_${process.pid}_${Date.now()}`)

    try {
      fs.writeFileSync(outside, 'do not remove')
      fs.mkdirSync(path.join(repo, '.prove_it'), { recursive: true })
      fs.writeFileSync(path.join(repo, '.prove_it', 'ownership.json'), JSON.stringify({
        owner: 'prove_it',
        artifacts: [{ owner: 'prove_it', path: path.relative(repo, outside).split(path.sep).join('/') }]
      }, null, 2) + '\n')

      const result = deinitStrictProject(repo)

      assert.ok(fs.existsSync(outside))
      assert.ok(result.skipped.some(entry => entry.reason === 'unsafe path'))
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
      fs.rmSync(outside, { force: true })
    }
  })

  it('refuses to remove unowned strict config when no ownership manifest exists', () => {
    const { PROFILE_VERSION } = require('../lib/redesign/config')
    const { deinitStrictProject } = require('../lib/redesign/init')
    const repo = tmpRepo()

    try {
      fs.mkdirSync(path.join(repo, '.prove_it'), { recursive: true })
      fs.writeFileSync(path.join(repo, '.prove_it', 'config.json'), JSON.stringify({
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        adapters: { pi: { enabled: true } }
      }, null, 2) + '\n')

      const result = deinitStrictProject(repo)

      assert.ok(fs.existsSync(path.join(repo, '.prove_it', 'config.json')))
      assert.deepStrictEqual(result.removed, [])
      assert.ok(result.skipped.some(entry => entry.path === '.prove_it/' && entry.reason === 'missing ownership manifest'))
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
