const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function tmpDir (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function captureStdout (fn) {
  const originalLog = console.log
  let stdout = ''
  try {
    console.log = message => { stdout += String(message) + '\n' }
    const result = fn()
    return { stdout, result }
  } finally {
    console.log = originalLog
  }
}

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function makeStrictConfig (patch = {}) {
  const { PROFILE_VERSION } = require('../lib/redesign/config')
  return {
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    ...patch
  }
}

describe('Claude parity acceptance harness', () => {
  it('documents the acceptance flow, manual checklist, retired fields, and coverage map', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'claude-parity-acceptance.md'), 'utf8')
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')

    for (const heading of [
      '# Claude parity acceptance harness',
      '## Quick automated validation',
      '## Fresh-project non-interactive acceptance harness',
      '## Manual Claude Code checklist',
      '## Retained vs retired behavior',
      '## Troubleshooting',
      '## Automated coverage map'
    ]) {
      assert.match(doc, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }

    for (const phrase of [
      'Workflow Engine',
      'Clean Runtime',
      'Harness',
      'Adapter',
      'Claude Parity Cutover',
      '.prove_it/config.json',
      '.claude/prove_it/config.json',
      '.claude/prove_it/config.local.json',
      'ignored by normal Claude and Git dispatch'
    ]) {
      assert.match(doc, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }

    for (const retiredField of [
      'type: "env"',
      'ruleFile',
      'quiet',
      'briefing',
      'enabled',
      'promptType',
      'taskEnv',
      'taskAllowedTools',
      'taskBypassPermissions',
      'fileEditingTools',
      'timeout'
    ]) {
      assert.match(doc, new RegExp(retiredField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }

    for (const replacement of [
      'session_env',
      'context_files',
      'output: "failures_only"',
      'timeout_ms',
      'params',
      'task-local `env`',
      'adapters.claude.file_editing_tools',
      'pipeline `remove` / task shadowing'
    ]) {
      assert.match(doc, new RegExp(replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }

    for (const testFile of [
      'test/claude_clean_runtime_route.test.js',
      'test/claude_clean_observations.test.js',
      'test/claude_reviewer_backend.test.js',
      'test/integration/claude_clean_pre_tool_script.integration.test.js',
      'test/integration/claude_clean_signal_interception.integration.test.js',
      'test/integration/claude_clean_stop.integration.test.js',
      'test/integration/claude_clean_phase_plan.integration.test.js',
      'test/integration/claude_clean_task_completed.integration.test.js',
      'test/integration/git_dispatcher.integration.test.js',
      'test/cancel.test.js',
      'test/disable.test.js',
      'test/redesign_config.test.js',
      'test/redesign_engine.test.js'
    ]) {
      assert.match(doc, new RegExp(testFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }

    assert.match(readme, /docs\/claude-parity-acceptance\.md/)
  })

  it('validates the fresh init, doctor, and explain acceptance path without reading stale legacy config', () => {
    const { initStrictProject } = require('../lib/redesign/init')
    const { cmdDoctor } = require('../lib/commands/doctor')
    const { cmdExplain } = require('../lib/commands/explain')
    const repo = tmpDir('prove_it_claude_acceptance_repo_')
    const home = tmpDir('prove_it_claude_acceptance_home_')
    const originalHome = process.env.HOME
    const originalCwd = process.cwd()

    try {
      fs.mkdirSync(path.join(repo, 'script'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'script', 'test'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
      fs.writeFileSync(path.join(repo, 'script', 'test_fast'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

      const init = initStrictProject(repo, { adapters: ['claude'] })
      assert.deepStrictEqual(init.adapters, ['claude'])
      assert.ok(init.created.includes('.prove_it/config.json'))
      assert.ok(init.created.includes('.claude/settings.json'))

      const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.prove_it', 'config.json'), 'utf8'))
      const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'))
      assert.strictEqual(cfg.profile, 'claude')
      assert.strictEqual(cfg.adapters.claude.enabled, true)
      assert.ok(!fs.existsSync(path.join(repo, '.claude', 'prove_it', 'config.json')))
      assert.match(JSON.stringify(settings), /prove_it hook claude:SessionStart/)
      assert.match(JSON.stringify(settings), /prove_it hook claude:PreToolUse/)
      assert.match(JSON.stringify(settings), /prove_it hook claude:Stop/)
      assert.doesNotMatch(JSON.stringify(settings), /agent_workflows|git_workflows|profile_version/)

      fs.mkdirSync(path.join(repo, '.claude', 'prove_it'), { recursive: true })
      fs.writeFileSync(path.join(repo, '.claude', 'prove_it', 'config.json'), '{ invalid legacy json')
      fs.writeFileSync(path.join(repo, '.claude', 'prove_it', 'config.local.json'), '{ invalid legacy local json')
      writeJson(path.join(repo, '.prove_it', 'config.local.json'), makeStrictConfig({
        tasks: {
          fast_tests: { type: 'script', command: './script/test_fast', output: 'failures_only' }
        }
      }))

      process.env.HOME = home
      process.chdir(repo)

      const doctor = captureStdout(() => cmdDoctor())
      assert.match(doctor.stdout, /Strict \.prove_it effective config/)
      assert.match(doctor.stdout, /Strict \.prove_it adapters enabled: claude/)
      assert.match(doctor.stdout, /Stale legacy Claude config present: \.claude\/prove_it\/config\.json/)
      assert.match(doctor.stdout, /Stale legacy Claude config present: \.claude\/prove_it\/config\.local\.json/)
      assert.match(doctor.stdout, /Stale legacy Claude config ignored by normal hooks/)

      const explain = captureStdout(() => cmdExplain())
      const explained = JSON.parse(explain.stdout)
      assert.strictEqual(explained.source_layers[0].name, 'claude-parity')
      assert.strictEqual(explained.effective.profile, 'claude')
      assert.deepStrictEqual(explained.effective.agent_workflows.pre_tool.slice(0, 2), [
        'protect_prove_it_config',
        'test_first'
      ])
      assert.ok(explained.lineage.agent_workflows.pre_tool.length > 0)
      assert.deepStrictEqual(explained.task_shadowing.fast_tests.map(entry => entry.kind), ['profile', 'local'])
      assert.doesNotMatch(explain.stdout, /invalid legacy json|invalid legacy local json/)
    } finally {
      process.chdir(originalCwd)
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      fs.rmSync(repo, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps retired legacy fields invalid in strict .prove_it config and names clean replacements', () => {
    const { loadEffectiveConfig } = require('../lib/redesign/config')
    const repo = tmpDir('prove_it_retired_fields_repo_')
    const home = tmpDir('prove_it_retired_fields_home_')
    const cases = [
      ['legacy env task type', { tasks: { legacy_env: { type: 'env', command: './script/env' } } }, /tasks\.legacy_env\.type must be one of/],
      ['ruleFile', { tasks: { review: { type: 'reviewer', prompt: 'Review.', ruleFile: '.claude/rules/testing.md' } } }, /unknown tasks\.review key "ruleFile"/],
      ['quiet', { tasks: { check: { type: 'script', command: './script/check', quiet: true } } }, /unknown tasks\.check key "quiet"/],
      ['briefing', { tasks: { check: { type: 'script', command: './script/check', briefing: 'Do TDD.' } } }, /unknown tasks\.check key "briefing"/],
      ['enabled', { tasks: { check: { type: 'script', command: './script/check', enabled: false } } }, /unknown tasks\.check key "enabled"/],
      ['promptType', { tasks: { review: { type: 'reviewer', prompt: 'prove-done', promptType: 'skill' } } }, /unknown tasks\.review key "promptType"/],
      ['taskEnv', { taskEnv: { FLAG: '1' } }, /unknown top-level key "taskEnv"/],
      ['taskAllowedTools', { taskAllowedTools: ['Read'] }, /unknown top-level key "taskAllowedTools"/],
      ['taskBypassPermissions', { taskBypassPermissions: true }, /unknown top-level key "taskBypassPermissions"/],
      ['top-level reviewer command default', { reviewerCommand: 'claude' }, /unknown top-level key "reviewerCommand"/],
      ['fileEditingTools', { fileEditingTools: ['Edit'] }, /unknown top-level key "fileEditingTools"/],
      ['adapter legacy fileEditingTools', { adapters: { claude: { enabled: true, fileEditingTools: ['Edit'] } } }, /unknown adapters\.claude key "fileEditingTools"/],
      ['timeout', { tasks: { check: { type: 'script', command: './script/check', timeout: 5000 } } }, /unknown tasks\.check key "timeout"/]
    ]

    try {
      for (const [label, patch, expected] of cases) {
        writeJson(path.join(repo, '.prove_it', 'config.json'), makeStrictConfig(patch))
        assert.throws(() => loadEffectiveConfig(repo, { homeDir: home }), expected, label)
      }

      writeJson(path.join(repo, '.prove_it', 'config.json'), makeStrictConfig({
        tasks: {
          env: { type: 'session_env', command: './script/env', params: { mode: 'dev' }, env: { FLAG: '1' }, timeout_ms: 1000 },
          review: { type: 'reviewer', prompt: 'skill:prove-done', context_files: ['docs/review.md'] },
          quiet: { type: 'script', command: './script/check', output: 'failures_only' },
          shadowed: { type: 'script', command: './script/new' }
        },
        agent_workflows: {
          session_start: ['env'],
          agent_end: { remove: ['done_review'], append: ['quiet', 'review', 'shadowed'] }
        },
        adapters: { claude: { enabled: true, file_editing_tools: ['Edit', 'Write'] } }
      }))
      const effective = loadEffectiveConfig(repo, { homeDir: home }).effective
      assert.strictEqual(effective.tasks.env.type, 'session_env')
      assert.deepStrictEqual(effective.tasks.env.params, { mode: 'dev' })
      assert.deepStrictEqual(effective.tasks.env.env, { FLAG: '1' })
      assert.strictEqual(effective.tasks.env.timeout_ms, 1000)
      assert.deepStrictEqual(effective.tasks.review.context_files, ['docs/review.md'])
      assert.strictEqual(effective.tasks.quiet.output, 'failures_only')
      assert.deepStrictEqual(effective.adapters.claude.file_editing_tools, ['Edit', 'Write'])
      assert.ok(!effective.agent_workflows.agent_end.includes('done_review'))
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
