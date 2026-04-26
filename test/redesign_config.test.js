const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

function tmpDir (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

describe('redesign strict .prove_it config/profile model', () => {
  it('resolves global, project, and local layers over a pinned built-in profile with lineage and task shadowing', () => {
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')

    try {
      writeJson(path.join(home, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        globs: { source: ['lib/**/*.js'], test: ['test/**/*.js'] },
        tasks: {
          global_check: { type: 'script', command: 'npm test' },
          shadowed_check: { type: 'script', command: 'echo global' }
        },
        agent_workflows: {
          pre_tool: { append: ['global_check', 'shadowed_check'] }
        },
        git_workflows: {
          pre_commit: { append: ['global_check'] }
        },
        adapters: { pi: { enabled: true } }
      })

      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        project: { name: 'demo' },
        tasks: {
          project_check: { type: 'script', command: './script/test_fast' },
          shadowed_check: { type: 'script', command: 'echo project' }
        },
        agent_workflows: {
          pre_tool: { remove: ['global_check'], append: ['project_check'] }
        },
        git_workflows: {
          pre_push: { replace_tasks: ['project_check'] }
        },
        adapters: { claude: { enabled: true } }
      })

      writeJson(path.join(repo, '.prove_it', 'config.local.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          local_check: { type: 'script', command: 'echo local' }
        },
        agent_workflows: {
          pre_tool: { prepend: ['local_check'] }
        }
      })

      const explained = loadEffectiveConfig(repo, { homeDir: home, explain: true })

      assert.strictEqual(explained.effective.profile_version, PROFILE_VERSION)
      assert.strictEqual(explained.effective.project.name, 'demo')
      assert.deepStrictEqual(explained.effective.globs, {
        source: ['lib/**/*.js'],
        test: ['test/**/*.js']
      })
      assert.deepStrictEqual(explained.effective.agent_workflows.pre_tool, [
        'local_check',
        'protect_prove_it_config',
        'shadowed_check',
        'project_check'
      ])
      assert.deepStrictEqual(explained.effective.git_workflows.pre_commit, ['global_check'])
      assert.deepStrictEqual(explained.effective.git_workflows.pre_push, ['project_check'])
      assert.strictEqual(explained.effective.tasks.shadowed_check.command, 'echo project')
      assert.strictEqual(explained.effective.adapters.pi.enabled, true)
      assert.strictEqual(explained.effective.adapters.claude.enabled, true)

      assert.deepStrictEqual(explained.source_layers.map(layer => [layer.kind, layer.present]), [
        ['profile', true],
        ['global', true],
        ['project', true],
        ['local', true]
      ])
      assert.deepStrictEqual(explained.task_shadowing.shadowed_check.map(entry => entry.kind), ['global', 'project'])
      assert.ok(explained.lineage.agent_workflows.pre_tool.some(entry => entry.operation === 'remove' && entry.tasks.includes('global_check')))
      assert.ok(explained.lineage.agent_workflows.pre_tool.some(entry => entry.operation === 'prepend' && entry.tasks.includes('local_check')))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('accepts strict task lifecycle flags for background async and parallel work', () => {
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          background_check: { type: 'script', command: './script/background', async: true },
          parallel_check: { type: 'script', command: './script/parallel', parallel: true }
        },
        agent_workflows: {
          post_tool: { append: ['background_check'] },
          agent_end: { append: ['parallel_check'] }
        }
      })

      const explained = loadEffectiveConfig(repo, { homeDir: home })

      assert.strictEqual(explained.effective.tasks.background_check.async, true)
      assert.strictEqual(explained.effective.tasks.parallel_check.parallel, true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('rejects tasks configured as both async and parallel', () => {
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          impossible: { type: 'script', command: './script/check', async: true, parallel: true }
        }
      })

      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /tasks\.impossible cannot be both async and parallel/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('accepts strict script task params, env, and timeout_ms and rejects invalid shapes', () => {
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          custom_check: {
            type: 'script',
            command: './script/check',
            params: { mode: 'strict', nested: { ok: true }, paths: ['src/**/*.js'] },
            env: { TURBOCOMMIT_DISABLED: '1', MODE: 'strict' },
            timeout_ms: 120000
          }
        },
        agent_workflows: { pre_tool: { append: ['custom_check'] } }
      })
      assert.deepStrictEqual(loadEffectiveConfig(repo, { homeDir: home }).effective.tasks.custom_check, {
        type: 'script',
        command: './script/check',
        params: { mode: 'strict', nested: { ok: true }, paths: ['src/**/*.js'] },
        env: { TURBOCOMMIT_DISABLED: '1', MODE: 'strict' },
        timeout_ms: 120000
      })

      for (const [label, params] of [['array', []], ['string', 'strict'], ['null', null]]) {
        writeJson(path.join(repo, '.prove_it', 'config.json'), {
          schema_version: 1,
          profile_version: PROFILE_VERSION,
          tasks: { bad_params: { type: 'script', command: './script/check', params } }
        })
        assert.throws(
          () => loadEffectiveConfig(repo, { homeDir: home }),
          /tasks\.bad_params\.params must be an object/,
          `expected ${label} params to be rejected`
        )
      }

      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: { bad_env: { type: 'script', command: './script/check', env: { FLAG: true } } }
      })
      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /tasks\.bad_env\.env\.FLAG must be a string/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('accepts strict task when conditions and preserves them in explain diagnostics', () => {
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        globs: { source: ['src/**/*.js'], test: ['test/**/*.js'] },
        tasks: {
          gated_check: {
            type: 'script',
            command: './script/check',
            when: [
              { signal: 'done', sourceFilesEdited: true, linesChanged: 10 },
              { signal: 'stuck', testFilesEdited: true, linesWritten: 25, sourcesModifiedSinceLastRun: true }
            ]
          }
        },
        agent_workflows: { pre_tool: { append: ['gated_check'] } },
        adapters: { claude: { enabled: true } }
      })

      const explained = loadEffectiveConfig(repo, { homeDir: home, explain: true })

      assert.deepStrictEqual(explained.effective.tasks.gated_check.when, [
        { signal: 'done', sourceFilesEdited: true, linesChanged: 10 },
        { signal: 'stuck', testFilesEdited: true, linesWritten: 25, sourcesModifiedSinceLastRun: true }
      ])
      assert.ok(JSON.stringify(explained).includes('sourceFilesEdited'))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('accepts and rejects strict task when.phase conditions', () => {
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          implement_only: { type: 'script', command: 'true', when: { phase: 'implement' } }
        },
        agent_workflows: { pre_tool: { append: ['implement_only'] } }
      })
      assert.strictEqual(loadEffectiveConfig(repo, { homeDir: home }).effective.tasks.implement_only.when.phase, 'implement')

      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          bad_phase: { type: 'script', command: 'true', when: { phase: 'design' } }
        }
      })
      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /tasks\.bad_phase\.when\.phase must be one of unknown, plan, implement, refactor/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('rejects invalid strict task when condition shapes', () => {
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          bad_signal: { type: 'script', command: 'true', when: { signal: 'finished' } }
        }
      })
      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /tasks\.bad_signal\.when\.signal must be one of done, stuck, idle/)

      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          bad_key: { type: 'script', command: 'true', when: { claudeHookEvent: 'Stop' } }
        }
      })
      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /unknown tasks\.bad_key\.when key "claudeHookEvent"/)

      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {
          bad_threshold: { type: 'script', command: 'true', when: { linesChanged: -1 } }
        }
      })
      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /tasks\.bad_threshold\.when\.linesChanged must be a non-negative integer/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('strictly rejects unknown fields, legacy hook-shaped config, and invalid task references', () => {
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        hooks: { claude: { Stop: [] } },
        tasks: {},
        agent_workflows: {}
      })
      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /unknown top-level key "hooks"/)

      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: { bad: { type: 'script', command: 'npm test', legacyMatcher: '*' } },
        agent_workflows: { pre_tool: ['bad'] }
      })
      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /unknown tasks\.bad key "legacyMatcher"/)

      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        tasks: {},
        agent_workflows: { pre_tool: { append: ['missing_task'] } }
      })
      assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), /agent_workflows\.pre_tool references unknown task "missing_task"/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('exposes the built-in strict profile as structured default data with a pinned profile version', () => {
    const { BUILT_IN_PROFILE, PROFILE_VERSION } = require('../lib/redesign/config')

    assert.strictEqual(BUILT_IN_PROFILE.profile_version, PROFILE_VERSION)
    assert.deepStrictEqual(Object.keys(BUILT_IN_PROFILE.config).sort(), [
      'adapters',
      'agent_workflows',
      'git_workflows',
      'globs',
      'project',
      'schema_version',
      'tasks'
    ])
    assert.deepStrictEqual(BUILT_IN_PROFILE.config.agent_workflows.pre_tool, ['protect_prove_it_config'])
    assert.deepStrictEqual(BUILT_IN_PROFILE.config.tasks.protect_prove_it_config, {
      type: 'config_guard',
      protected_paths: ['.prove_it/config.json', '.prove_it/config.local.json']
    })
  })

  it('selects the Claude parity profile without making Pi inherit Claude-only defaults', () => {
    const { CLAUDE_PARITY_PROFILE, PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const claudeRepo = tmpDir('prove_it_claude_profile_')
    const piRepo = tmpDir('prove_it_pi_profile_')

    try {
      writeJson(path.join(claudeRepo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        profile: 'claude',
        adapters: { claude: { enabled: true } }
      })
      writeJson(path.join(piRepo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        adapters: { pi: { enabled: true } }
      })

      const claude = loadEffectiveConfig(claudeRepo).effective
      const pi = loadEffectiveConfig(piRepo).effective

      assert.strictEqual(CLAUDE_PARITY_PROFILE.profile_version, PROFILE_VERSION)
      assert.deepStrictEqual(claude.agent_workflows.pre_tool, [
        'protect_prove_it_config',
        'test_first',
        'verify_assumptions'
      ])
      assert.deepStrictEqual(claude.agent_workflows.post_tool, ['testing_antipatterns_review'])
      assert.deepStrictEqual(claude.agent_workflows.agent_end, [
        'fast_tests',
        'full_tests',
        'coverage_review',
        'done_review',
        'approach_review'
      ])
      assert.deepStrictEqual(claude.git_workflows.pre_commit, ['git_full_tests'])
      assert.deepStrictEqual(claude.tasks.protect_prove_it_config.protected_paths, [
        '.prove_it/config.json',
        '.prove_it/config.local.json'
      ])
      assert.deepStrictEqual(claude.tasks.full_tests.when, { signal: 'done', sourceFilesEdited: true })
      assert.strictEqual(claude.tasks.full_tests.parallel, true)
      assert.strictEqual(claude.tasks.testing_antipatterns_review.type, 'reviewer')
      assert.strictEqual(claude.tasks.testing_antipatterns_review.provider, 'claude')
      assert.strictEqual(claude.tasks.testing_antipatterns_review.async, true)
      assert.strictEqual(claude.tasks.done_review.type, 'reviewer')
      assert.strictEqual(claude.tasks.done_review.provider, 'claude')
      assert.strictEqual(claude.tasks.done_review.parallel, true)
      assert.strictEqual(claude.tasks.approach_review.when.signal, 'stuck')

      assert.deepStrictEqual(pi.agent_workflows.pre_tool, ['protect_prove_it_config'])
      assert.deepStrictEqual(pi.agent_workflows.post_tool, [])
      assert.deepStrictEqual(pi.agent_workflows.agent_end, [])
      assert.ok(!Object.prototype.hasOwnProperty.call(pi.tasks, 'done_review'))
      assert.strictEqual(pi.profile, 'strict')
    } finally {
      fs.rmSync(claudeRepo, { recursive: true, force: true })
      fs.rmSync(piRepo, { recursive: true, force: true })
    }
  })

  it('passes strict script task inputs and effective context into the script task provider', () => {
    const { createScriptTaskPort } = require('../lib/redesign/script_task_port')
    const { normalizeLifecycleEvent } = require('../lib/redesign/events')
    const { PROFILE_VERSION, loadEffectiveConfig } = require('../lib/redesign/config')
    const repo = tmpDir('prove_it_script_context_')

    try {
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        profile: 'claude',
        tasks: {
          test_first: {
            type: 'script',
            command: './script/check',
            params: { mode: 'strict' },
            env: { TASK_LOCAL: 'yes' },
            timeout_ms: 1234
          }
        },
        adapters: { claude: { enabled: true } }
      })
      const cfg = loadEffectiveConfig(repo).effective
      let receivedCheck
      let receivedContext
      const port = createScriptTaskPort({
        runScript (check, context) {
          receivedCheck = check
          receivedContext = context
          return { pass: true, reason: 'ok', output: '' }
        }
      })
      const event = normalizeLifecycleEvent({
        adapterId: 'claude',
        rawEventName: 'PreToolUse',
        rawEvent: { session_id: 'session-1', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } },
        cwd: repo,
        projectDir: repo,
        rootDir: repo
      })

      port.run({
        taskName: 'test_first',
        task: cfg.tasks.test_first,
        event,
        effectiveConfig: cfg
      })

      assert.strictEqual(receivedCheck.name, 'test_first')
      assert.deepStrictEqual(receivedCheck.params, { mode: 'strict' })
      assert.strictEqual(receivedCheck.timeout, 1234)
      assert.deepStrictEqual(receivedContext.configEnv, { TASK_LOCAL: 'yes' })
      assert.strictEqual(receivedContext.normalizedEvent, event)
      assert.deepStrictEqual(receivedContext.targetPaths, ['src/app.js'])
      assert.strictEqual(receivedContext.cwd, repo)
      assert.strictEqual(receivedContext.projectDir, repo)
      assert.strictEqual(receivedContext.rootDir, repo)
      assert.deepStrictEqual(receivedContext.sources, cfg.globs.source)
      assert.deepStrictEqual(receivedContext.tests, cfg.globs.test)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('explain command reports effective pipelines, source layers, lineage, and task shadowing without legacy loading', () => {
    const { PROFILE_VERSION } = require('../lib/redesign/config')
    const { cmdExplain } = require('../lib/commands/explain')
    const home = tmpDir('prove_it_home_')
    const repo = tmpDir('prove_it_repo_')
    const originalHome = process.env.HOME
    const originalCwd = process.cwd()
    const originalLog = console.log
    let stdout = ''

    try {
      writeJson(path.join(repo, '.claude', 'prove_it', 'config.json'), {
        hooks: { claude: { Stop: [{ name: 'legacy', command: 'false' }] } }
      })
      writeJson(path.join(repo, '.prove_it', 'config.json'), {
        schema_version: 1,
        profile_version: PROFILE_VERSION,
        profile: 'claude',
        tasks: {
          protect_prove_it_config: { type: 'config_guard' },
          explain_check: { type: 'script', command: 'echo explain', when: { signal: 'done', sourceFilesEdited: true } }
        },
        agent_workflows: { pre_tool: { append: ['explain_check'] } }
      })

      process.env.HOME = home
      process.chdir(repo)
      console.log = message => { stdout += message }
      cmdExplain()
      const explained = JSON.parse(stdout)

      assert.strictEqual(explained.source_layers[0].name, 'claude-parity')
      assert.deepStrictEqual(explained.effective.agent_workflows.pre_tool, [
        'protect_prove_it_config',
        'test_first',
        'verify_assumptions',
        'explain_check'
      ])
      assert.deepStrictEqual(explained.source_layers.map(layer => layer.kind), [
        'profile',
        'global',
        'project',
        'local'
      ])
      assert.ok(explained.lineage.tasks.protect_prove_it_config.length >= 2)
      assert.ok(explained.task_shadowing.protect_prove_it_config)
      assert.deepStrictEqual(explained.effective.tasks.explain_check.when, { signal: 'done', sourceFilesEdited: true })
      assert.doesNotMatch(stdout, /legacy/)
      assert.doesNotMatch(stdout, /\.claude\/prove_it/)
    } finally {
      console.log = originalLog
      process.chdir(originalCwd)
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
