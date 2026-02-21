const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const CLI_PATH = path.join(__dirname, '..', '..', 'cli.js')

function runCli (args, options = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    ...options
  })
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status
  }
}

describe('CLI', () => {
  // ---------- Story: help ----------
  it('shows help for no args, help command, and --help flag', () => {
    for (const args of [[], ['help'], ['--help']]) {
      const r = runCli(args)
      assert.match(r.stdout, /prove_it.*Config-driven/s)
    }
    assert.match(runCli([]).stdout, /install/)
    assert.match(runCli([]).stdout, /run_builtin/)
  })

  it('exits with error for unknown command', () => {
    const r = runCli(['foobar'])
    assert.strictEqual(r.exitCode, 1)
    assert.match(r.stderr, /Unknown command: foobar/)
  })

  // ---------- Story: run_builtin ----------
  it('run_builtin: usage, unknown, and config:lock invocation', () => {
    const r1 = runCli(['run_builtin'])
    assert.strictEqual(r1.exitCode, 1)
    assert.match(r1.stderr, /Usage/)

    const r2 = runCli(['run_builtin', 'nonexistent'])
    assert.strictEqual(r2.exitCode, 1)
    assert.match(r2.stderr, /Unknown builtin/)

    const r3 = runCli(['run_builtin', 'config:lock'])
    assert.strictEqual(r3.exitCode, 0)
  })

  // ---------- Story: signal ----------
  it('signal done exits 0 with confirmation', () => {
    const r = runCli(['signal', 'done'])
    assert.strictEqual(r.exitCode, 0)
    assert.match(r.stdout, /signal "done" recorded/)
  })

  it('signal with --message includes message in output', () => {
    const r = runCli(['signal', 'stuck', '--message', 'Cannot test async'])
    assert.strictEqual(r.exitCode, 0)
    assert.match(r.stdout, /signal "stuck" recorded/)
    assert.match(r.stdout, /Cannot test async/)
  })

  it('signal with -m shorthand works', () => {
    const r = runCli(['signal', 'idle', '-m', 'Between tasks'])
    assert.strictEqual(r.exitCode, 0)
    assert.match(r.stdout, /signal "idle" recorded/)
    assert.match(r.stdout, /Between tasks/)
  })

  it('signal clear exits 0', () => {
    const r = runCli(['signal', 'clear'])
    assert.strictEqual(r.exitCode, 0)
    assert.match(r.stdout, /signal cleared/)
  })

  it('signal bogus exits 1 with error', () => {
    const r = runCli(['signal', 'bogus'])
    assert.strictEqual(r.exitCode, 1)
    assert.match(r.stderr, /Unknown signal type/)
  })

  it('signal with no type exits 1 with usage', () => {
    const r = runCli(['signal'])
    assert.strictEqual(r.exitCode, 1)
    assert.match(r.stderr, /Usage/)
  })

  // ---------- Story: reinstall ----------
  it('reinstall uninstalls and reinstalls global hooks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_reinstall_'))
    try {
      const env = { ...process.env, HOME: tmpDir }
      runCli(['install'], { env })
      const r = runCli(['reinstall'], { env })
      assert.strictEqual(r.exitCode, 0)
      const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'))
      const s = JSON.stringify(settings.hooks)
      assert.ok(s.includes('prove_it hook claude:Stop'))
      assert.ok(s.includes('prove_it hook claude:PreToolUse'))
      assert.ok(s.includes('prove_it hook claude:SessionStart'))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('init/deinit', () => {
  let tmpDir

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_test_')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  // ---------- Story: init lifecycle ----------
  it('creates files, reports up-to-date on re-init, auto-upgrades outdated', () => {
    // Fresh init
    const r1 = runCli(['init'], { cwd: tmpDir })
    assert.strictEqual(r1.exitCode, 0)
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json')))
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.local.json')))
    assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test')))
    assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test_fast')))
    assert.ok(fs.statSync(path.join(tmpDir, 'script', 'test')).mode & fs.constants.S_IXUSR)
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), 'utf8'))
    assert.ok(Array.isArray(cfg.hooks))

    // Re-init → up to date
    assert.match(runCli(['init'], { cwd: tmpDir }).stdout, /up to date/)

    // Shows sources TODO when placeholder globs present
    assert.match(r1.stdout, /Replace the placeholder sources globs/)
  })

  // ---------- Story: init upgrade/overwrite ----------
  it('auto-upgrades outdated, --no-overwrite preserves edited, --overwrite replaces', () => {
    // Auto-upgrade: init without default checks, then re-init
    runCli(['init', '--no-default-checks'], { cwd: tmpDir })
    const upgrade = runCli(['init'], { cwd: tmpDir })
    assert.match(upgrade.stdout, /upgraded to current defaults/)
    assert.match(upgrade.stdout, /\[ \] Commit changes/)

    const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')

    // Customize the config
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg2.sources = ['src/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2) + '\n')

    // --no-overwrite → customized
    assert.match(runCli(['init', '--no-overwrite'], { cwd: tmpDir }).stdout, /customized/)

    // --overwrite → overwritten
    const ow = runCli(['init', '--overwrite'], { cwd: tmpDir })
    assert.match(ow.stdout, /overwritten with current defaults/)
    const newCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    assert.ok(newCfg.initSeed)
    assert.ok(!newCfg.sources.includes('src/**/*.js'))

    // --overwrite respects other flags
    const cfg3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg3.sources = ['src/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg3, null, 2) + '\n')
    runCli(['init', '--overwrite', '--no-default-checks'], { cwd: tmpDir })
    const cfg4 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const allTasks = cfg4.hooks.flatMap(h => h.tasks || [])
    assert.ok(!allTasks.some(t => t.name === 'code-quality-review'))
  })

  it('is non-destructive for legacy configs without hash', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), '{"custom": true}')
    runCli(['init'], { cwd: tmpDir })
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), 'utf8'),
      '{"custom": true}'
    )
  })

  // ---------- Story: init TODOs ----------
  it('shows sources/trap TODOs appropriately', () => {
    runCli(['init'], { cwd: tmpDir })

    // Customize sources → done
    const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.sources = ['src/**/*.js', 'test/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
    assert.match(runCli(['init'], { cwd: tmpDir }).stdout, /\[x\] Sources globs configured/)

    // Custom scripts without prove_it record → trap instructions
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'), '#!/usr/bin/env bash\nnpm test\n')
    fs.writeFileSync(path.join(tmpDir, 'script', 'test_fast'), '#!/usr/bin/env bash\nnpm run test:unit\n')
    const r2 = runCli(['init'], { cwd: tmpDir })
    assert.match(r2.stdout, /skip redundant test runs/)
    assert.match(r2.stdout, /trap 'prove_it record --name full-tests --result \$\?' EXIT/)

    // Scripts with prove_it record → done
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'),
      "#!/usr/bin/env bash\ntrap 'prove_it record --name full-tests --result $?' EXIT\nnpm test\n")
    fs.writeFileSync(path.join(tmpDir, 'script', 'test_fast'),
      "#!/usr/bin/env bash\ntrap 'prove_it record --name fast-tests --result $?' EXIT\nnpm run test:unit\n")
    const r3 = runCli(['init'], { cwd: tmpDir })
    assert.match(r3.stdout, /\[x\] script\/test records results/)
    assert.match(r3.stdout, /\[x\] script\/test_fast records results/)
  })

  // ---------- Story: reinit ----------
  it('reinit removes and recreates prove_it files', () => {
    runCli(['init'], { cwd: tmpDir })
    const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
    fs.unlinkSync(cfgPath)
    assert.ok(!fs.existsSync(cfgPath))
    runCli(['reinit'], { cwd: tmpDir })
    assert.ok(fs.existsSync(cfgPath))
  })

  // ---------- Story: deinit ----------
  it('removes configs, preserves custom scripts, removes stubs, handles rules', () => {
    runCli(['init'], { cwd: tmpDir })
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.local.json')))

    // Customize script/test
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'), '#!/usr/bin/env bash\nnpm test\n')

    // Deinit
    const r = runCli(['deinit'], { cwd: tmpDir })
    assert.strictEqual(r.exitCode, 0)

    // Config removed
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json')))
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.local.json')))

    // Custom script preserved
    assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test')))

    // Stub scripts removed (clean slate: remove custom script, re-init to get stubs)
    fs.rmSync(path.join(tmpDir, 'script'), { recursive: true, force: true })
    runCli(['init'], { cwd: tmpDir })
    runCli(['deinit'], { cwd: tmpDir })
    assert.ok(!fs.existsSync(path.join(tmpDir, 'script', 'test')))
    assert.ok(!fs.existsSync(path.join(tmpDir, 'script', 'test_fast')))

    // Default rule file removed
    runCli(['init'], { cwd: tmpDir })
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'testing.md')))
    runCli(['deinit'], { cwd: tmpDir })
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'testing.md')))

    // Customized rule file preserved
    runCli(['init'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'rules', 'testing.md'), '# Custom\n')
    const r2 = runCli(['deinit'], { cwd: tmpDir })
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'testing.md')))
    assert.match(r2.stdout, /customized/)

    // .claude/prove_it/ directory removed (including runtime state)
    runCli(['init'], { cwd: tmpDir })
    const proveItDir = path.join(tmpDir, '.claude', 'prove_it')
    const sessionDir = path.join(proveItDir, 'sessions', 'test-session', 'backchannel', 'test-review')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'README.md'), 'dev response')
    runCli(['deinit'], { cwd: tmpDir })
    assert.ok(!fs.existsSync(proveItDir))

    // Legacy flat-file configs removed
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'prove_it.json'), '{"old": true}')
    fs.writeFileSync(path.join(tmpDir, '.claude', 'prove_it.local.json'), '{"old": true}')
    runCli(['deinit'], { cwd: tmpDir })
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.json')))
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.local.json')))
  })
})

describe('install/uninstall', () => {
  let tmpDir

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_install_')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  // ---------- Story: install lifecycle ----------
  it('creates hooks/config/skill, is idempotent, upgrades outdated', () => {
    const env = { ...process.env, HOME: tmpDir }

    // Fresh install
    runCli(['install'], { env })
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const serialized = JSON.stringify(settings.hooks)
    assert.ok(serialized.includes('prove_it hook claude:Stop'))
    assert.ok(serialized.includes('prove_it hook claude:PreToolUse'))
    assert.ok(serialized.includes('prove_it hook claude:SessionStart'))

    // No rules file (v2)
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'prove_it.md')))

    // Global config with defaults
    const configPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.ok(cfg.enabled)
    assert.ok(cfg.initSeed && cfg.initSeed.length === 12)
    assert.strictEqual(cfg.taskEnv.TURBOCOMMIT_DISABLED, '1')

    // Skill file
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'prove', 'SKILL.md')
    assert.ok(fs.existsSync(skillPath))
    const skillContent = fs.readFileSync(skillPath, 'utf8')
    assert.match(skillContent, /^---\nname: prove\n/)
    assert.match(skillContent, /disable-model-invocation: true/)

    // Idempotent
    runCli(['install'], { env })
    const s2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    for (const [event, groups] of Object.entries(s2.hooks)) {
      const proveItGroups = groups.filter(g => JSON.stringify(g).includes('prove_it hook'))
      assert.strictEqual(proveItGroups.length, 1, `${event}: exactly 1 prove_it dispatcher`)
    }

    // Reports "up to date" on second run
    const r2 = runCli(['install'], { env })
    assert.match(r2.stdout, /already up to date/)
    assert.ok(!r2.stdout.includes('Restart Claude Code'))
  })

  it('upgrades outdated hooks, config taskEnv, and skill file', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
    const configPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'prove', 'SKILL.md')

    // Outdated hooks
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const ptGroup = s.hooks.PreToolUse.find(g => JSON.stringify(g).includes('prove_it hook'))
    ptGroup.matcher = 'Edit|Write'
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
    runCli(['install'], { env })
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const upGroup = updated.hooks.PreToolUse.find(g => JSON.stringify(g).includes('prove_it hook'))
    assert.strictEqual(upGroup.matcher, 'Edit|Write|NotebookEdit|Bash')

    // Outdated taskEnv
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    delete cfg.taskEnv.TURBOCOMMIT_DISABLED
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
    runCli(['install'], { env })
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).taskEnv.TURBOCOMMIT_DISABLED, '1')

    // Outdated skill file
    fs.writeFileSync(skillPath, 'outdated content')
    runCli(['install'], { env })
    assert.ok(fs.readFileSync(skillPath, 'utf8') !== 'outdated content')
  })

  it('preserves existing global config fields and handles legacy configs', () => {
    const env = { ...process.env, HOME: tmpDir }
    const configPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')

    // Preserves existing fields
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ ignoredPaths: ['~/tmp'], taskEnv: { MY_VAR: 'keep' } }, null, 2))
    runCli(['install'], { env })
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.deepStrictEqual(cfg.ignoredPaths, ['~/tmp'])
    assert.strictEqual(cfg.taskEnv.MY_VAR, 'keep')
    assert.strictEqual(cfg.taskEnv.TURBOCOMMIT_DISABLED, '1')

    // Auto-upgrade unedited global config
    const { configHash } = require('../../lib/config')
    const oldConfig = { taskEnv: { OLD_VAR: '1' } }
    oldConfig.initSeed = configHash(oldConfig)
    fs.writeFileSync(configPath, JSON.stringify(oldConfig, null, 2) + '\n')
    runCli(['install'], { env })
    const upgraded = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.strictEqual(upgraded.taskEnv.TURBOCOMMIT_DISABLED, '1')
    assert.ok(!upgraded.taskEnv.OLD_VAR)

    // Legacy config (no initSeed) preserved
    fs.writeFileSync(configPath, JSON.stringify({
      ignoredPaths: ['~/legacy'],
      taskEnv: { CUSTOM: 'yes' }
    }, null, 2) + '\n')
    runCli(['install'], { env })
    const legacy = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.deepStrictEqual(legacy.ignoredPaths, ['~/legacy'])
    assert.strictEqual(legacy.taskEnv.CUSTOM, 'yes')
    assert.ok(!legacy.initSeed)

    // Strips configVersion from edited config
    fs.writeFileSync(configPath, JSON.stringify({
      configVersion: 3,
      ignoredPaths: ['~/legacy'],
      taskEnv: { CUSTOM: 'yes' }
    }, null, 2) + '\n')
    runCli(['install'], { env })
    const stripped = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.ok(!('configVersion' in stripped))
    assert.deepStrictEqual(stripped.ignoredPaths, ['~/legacy'])

    // Edited config: install preserves edits but restores env defaults
    runCli(['install'], { env })
    const edit = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    edit.ignoredPaths = ['~/my-project']
    delete edit.taskEnv.TURBOCOMMIT_DISABLED
    fs.writeFileSync(configPath, JSON.stringify(edit, null, 2) + '\n')
    runCli(['install'], { env })
    const fixed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.deepStrictEqual(fixed.ignoredPaths, ['~/my-project'])
    assert.strictEqual(fixed.taskEnv.TURBOCOMMIT_DISABLED, '1')
  })

  // ---------- Story: uninstall ----------
  it('removes hooks, config, and skill directory', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })
    assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'))).includes('prove_it hook'))

    runCli(['uninstall'], { env })

    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'))
    assert.ok(!JSON.stringify(settings).includes('prove_it hook'))
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'prove_it')))
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'prove')))
  })
})

describe('skill source', () => {
  it('has valid frontmatter', () => {
    const content = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'skills', 'prove.md'), 'utf8')
    assert.ok(content.startsWith('---\n') && !content.startsWith('---\n---'))
    const endIdx = content.indexOf('\n---\n', 4)
    assert.ok(endIdx > 0)
    const fm = content.slice(4, endIdx)
    assert.match(fm, /^name: prove$/m)
    assert.match(fm, /disable-model-invocation: true/)
    assert.match(fm, /allowed-tools:/)
    assert.match(fm, /- Bash/)
    assert.match(fm, /argument-hint:/)
  })
})
