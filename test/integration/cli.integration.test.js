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
  it('signal exits 1 outside hook context', () => {
    const r = runCli(['signal', 'done'])
    assert.strictEqual(r.exitCode, 1)
    assert.match(r.stderr, /must be run by Claude/)
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
      assert.ok(s.includes('prove_it hook claude:TaskCompleted'))
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

    // Sources-only customization → auto-upgraded (no prompt needed)
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg2.sources = ['src/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2) + '\n')

    const srcUpgrade = runCli(['init'], { cwd: tmpDir })
    assert.match(srcUpgrade.stdout, /upgraded to current defaults/)
    assert.match(srcUpgrade.stdout, /Preserved: sources globs from previous config/)
    const srcCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    assert.deepStrictEqual(srcCfg.sources, ['src/**/*.js'])

    // Non-sources customization → --no-overwrite preserves, --overwrite replaces
    const cfg3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg3.hooks = []
    cfg3.sources = ['src/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg3, null, 2) + '\n')

    assert.match(runCli(['init', '--no-overwrite'], { cwd: tmpDir }).stdout, /customized/)

    const ow = runCli(['init', '--overwrite'], { cwd: tmpDir })
    assert.match(ow.stdout, /overwritten with current defaults/)
    assert.match(ow.stdout, /Preserved: sources globs from previous config/)
    const newCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    assert.ok(newCfg.initSeed)
    assert.deepStrictEqual(newCfg.sources, ['src/**/*.js'])

    // --overwrite respects other flags (sources still preserved)
    const cfg5 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg5.hooks = []
    cfg5.sources = ['src/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg5, null, 2) + '\n')
    runCli(['init', '--overwrite', '--no-default-checks'], { cwd: tmpDir })
    const cfg6 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const allTasks = cfg6.hooks.flatMap(h => h.tasks || [])
    assert.ok(!allTasks.some(t => t.name === 'coverage-review'))
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
    assert.ok(serialized.includes('prove_it hook claude:TaskCompleted'))

    // No rules file (v2)
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'prove_it.md')))

    // Global config with defaults
    const configPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.ok(cfg.enabled)
    assert.ok(cfg.initSeed && cfg.initSeed.length === 12)
    assert.strictEqual(cfg.taskEnv.TURBOCOMMIT_DISABLED, '1')

    // Skill files (all 3)
    for (const name of ['prove', 'prove-coverage', 'prove-shipworthy']) {
      const skillPath = path.join(tmpDir, '.claude', 'skills', name, 'SKILL.md')
      assert.ok(fs.existsSync(skillPath), `Skill ${name} should exist`)
      const skillContent = fs.readFileSync(skillPath, 'utf8')
      assert.match(skillContent, new RegExp(`^---\\nname: ${name}\\n`))
      assert.match(skillContent, /disable-model-invocation: true/)
    }

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
    // Outdated hooks
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const ptGroup = s.hooks.PreToolUse.find(g => JSON.stringify(g).includes('prove_it hook'))
    ptGroup.matcher = 'Edit|Write'
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
    runCli(['install'], { env })
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const upGroup = updated.hooks.PreToolUse.find(g => JSON.stringify(g).includes('prove_it hook'))
    assert.strictEqual(upGroup.matcher, undefined)

    // Outdated taskEnv
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    delete cfg.taskEnv.TURBOCOMMIT_DISABLED
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
    runCli(['install'], { env })
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).taskEnv.TURBOCOMMIT_DISABLED, '1')

    // Outdated skill files (all 3)
    for (const name of ['prove', 'prove-coverage', 'prove-shipworthy']) {
      const sp = path.join(tmpDir, '.claude', 'skills', name, 'SKILL.md')
      fs.writeFileSync(sp, 'outdated content')
      runCli(['install'], { env })
      assert.ok(fs.readFileSync(sp, 'utf8') !== 'outdated content', `Skill ${name} should be upgraded`)
    }
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
    // Directory preserved but contents cleared
    const proveItDir = path.join(tmpDir, '.claude', 'prove_it')
    assert.ok(fs.existsSync(proveItDir), 'prove_it directory should still exist')
    assert.strictEqual(fs.readdirSync(proveItDir).length, 0, 'prove_it directory should be empty')
    for (const name of ['prove', 'prove-coverage', 'prove-shipworthy']) {
      assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'skills', name)), `Skill ${name} should be removed`)
    }
  })

  it('uninstall preserves directory when it is a symlink', () => {
    // Create a real prove_it directory with config
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_real_'))
    const realProveIt = path.join(realDir, 'prove_it')
    fs.mkdirSync(realProveIt, { recursive: true })
    fs.writeFileSync(path.join(realProveIt, 'config.json'), '{"enabled": true}')

    try {
      // Set up tmpDir with a symlink to the real directory
      const claudeDir = path.join(tmpDir, '.claude')
      fs.mkdirSync(claudeDir, { recursive: true })
      const symlinkPath = path.join(claudeDir, 'prove_it')
      fs.symlinkSync(realProveIt, symlinkPath)

      // Also need settings.json for uninstall to work
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}')

      const env = { ...process.env, HOME: tmpDir }
      runCli(['uninstall'], { env })

      // Symlink should still exist and still be a symlink
      assert.ok(fs.existsSync(symlinkPath), 'symlink should still exist')
      assert.ok(fs.lstatSync(symlinkPath).isSymbolicLink(), 'should still be a symlink')
      // Contents should be cleared
      assert.strictEqual(fs.readdirSync(symlinkPath).length, 0, 'contents should be removed')
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('uninstall backs up global config to tmpdir', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })

    // Customize the config
    const configPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    cfg.customField = 'my-custom-value'
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')

    const r = runCli(['uninstall'], { env })

    // stdout should contain the backup path
    assert.match(r.stdout, /Backup:/)
    // Extract the backup path from output
    const backupMatch = r.stdout.match(/Backup: (.+config\.json)/)
    assert.ok(backupMatch, 'should print backup path')
    const backupPath = backupMatch[1]
    assert.ok(fs.existsSync(backupPath), 'backup file should exist')
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    assert.strictEqual(backup.customField, 'my-custom-value')
  })
})

describe('init safety guards', () => {
  let tmpDir

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_guard_')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('init refuses to run in home directory', () => {
    const env = { ...process.env, HOME: tmpDir }
    const r = runCli(['init'], { cwd: tmpDir, env })
    assert.strictEqual(r.exitCode, 1)
    assert.match(r.stderr, /project directory/)
  })

  it('init refuses to run inside ~/.claude/', () => {
    const claudeDir = path.join(tmpDir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    const env = { ...process.env, HOME: tmpDir }
    const r = runCli(['init'], { cwd: claudeDir, env })
    assert.strictEqual(r.exitCode, 1)
    assert.match(r.stderr, /project directory/)
  })

  it('deinit refuses to run in home directory', () => {
    const env = { ...process.env, HOME: tmpDir }
    const r = runCli(['deinit'], { cwd: tmpDir, env })
    assert.strictEqual(r.exitCode, 1)
    assert.match(r.stderr, /project directory/)
  })

  it('deinit refuses to run inside ~/.claude/', () => {
    const claudeDir = path.join(tmpDir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    const env = { ...process.env, HOME: tmpDir }
    const r = runCli(['deinit'], { cwd: claudeDir, env })
    assert.strictEqual(r.exitCode, 1)
    assert.match(r.stderr, /project directory/)
  })
})

describe('skill source', () => {
  const skillsDir = path.join(__dirname, '..', '..', 'lib', 'skills')

  it('prove.md has valid frontmatter', () => {
    const content = fs.readFileSync(path.join(skillsDir, 'prove.md'), 'utf8')
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

  for (const name of ['prove-coverage', 'prove-shipworthy']) {
    it(`${name}.md has valid frontmatter`, () => {
      const content = fs.readFileSync(path.join(skillsDir, `${name}.md`), 'utf8')
      assert.ok(content.startsWith('---\n') && !content.startsWith('---\n---'))
      const endIdx = content.indexOf('\n---\n', 4)
      assert.ok(endIdx > 0)
      const fm = content.slice(4, endIdx)
      assert.match(fm, new RegExp(`^name: ${name}$`, 'm'))
      assert.match(fm, /disable-model-invocation: true/)
      assert.match(fm, /allowed-tools:/)
    })
  }
})
