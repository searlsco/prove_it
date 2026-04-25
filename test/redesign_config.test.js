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
        tasks: {
          protect_prove_it_config: { type: 'config_guard' },
          explain_check: { type: 'script', command: 'echo explain' }
        },
        agent_workflows: { pre_tool: { append: ['explain_check'] } }
      })

      process.env.HOME = home
      process.chdir(repo)
      console.log = message => { stdout += message }
      cmdExplain()
      const explained = JSON.parse(stdout)

      assert.deepStrictEqual(explained.effective.agent_workflows.pre_tool, [
        'protect_prove_it_config',
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
