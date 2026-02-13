const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const CLI_PATH = path.join(__dirname, '..', 'cli.js')

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
  describe('help', () => {
    it('shows help with no arguments', () => {
      const result = runCli([])
      assert.match(result.stdout, /prove_it.*Config-driven/s)
      assert.match(result.stdout, /install/)
      assert.match(result.stdout, /uninstall/)
      assert.match(result.stdout, /init/)
      assert.match(result.stdout, /deinit/)
    })

    it('shows help with help command', () => {
      const result = runCli(['help'])
      assert.match(result.stdout, /prove_it.*Config-driven/s)
    })

    it('shows help with --help flag', () => {
      const result = runCli(['--help'])
      assert.match(result.stdout, /prove_it.*Config-driven/s)
    })
  })

  describe('unknown command', () => {
    it('exits with error for unknown command', () => {
      const result = runCli(['foobar'])
      assert.strictEqual(result.exitCode, 1)
      assert.match(result.stderr, /Unknown command: foobar/)
    })
  })

  describe('reinstall', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_reinstall_'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('uninstalls and reinstalls global hooks', () => {
      const env = { ...process.env, HOME: tmpDir }
      runCli(['install'], { env })
      const result = runCli(['reinstall'], { env })
      assert.strictEqual(result.exitCode, 0)

      const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'))
      const serialized = JSON.stringify(settings.hooks)
      assert.ok(serialized.includes('prove_it hook claude:Stop'))
      assert.ok(serialized.includes('prove_it hook claude:PreToolUse'))
      assert.ok(serialized.includes('prove_it hook claude:SessionStart'))
    })
  })

  describe('run_builtin', () => {
    it('shows usage with no arguments', () => {
      const result = runCli(['run_builtin'])
      assert.strictEqual(result.exitCode, 1)
      assert.match(result.stderr, /Usage/)
    })

    it('exits with error for unknown builtin', () => {
      const result = runCli(['run_builtin', 'nonexistent'])
      assert.strictEqual(result.exitCode, 1)
      assert.match(result.stderr, /Unknown builtin/)
    })

    it('help text mentions run_builtin', () => {
      const result = runCli(['help'])
      assert.match(result.stdout, /run_builtin/)
    })

    it('successfully invokes config:lock (passes with no tool context)', () => {
      const result = runCli(['run_builtin', 'config:lock'])
      assert.strictEqual(result.exitCode, 0,
        `config:lock should pass when no tool context, stderr: ${result.stderr}`)
    })
  })
})

describe('init/deinit', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_test_'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('init creates expected files', () => {
    const result = runCli(['init'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)

    // Check files exist
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.json')))
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.local.json')))
    assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test')))
    assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test_fast')))

    // Check script/test is executable
    const stat = fs.statSync(path.join(tmpDir, 'script', 'test'))
    assert.ok(stat.mode & fs.constants.S_IXUSR, 'script/test should be executable')

    // Check config is v3 format
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.json'), 'utf8'))
    assert.strictEqual(cfg.configVersion, 3)
    assert.ok(Array.isArray(cfg.hooks), 'hooks should be an array')
  })

  it('init is non-destructive for legacy configs without hash', () => {
    // Create a custom prove_it.json first (no _generatedHash = legacy)
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'prove_it.json'), '{"custom": true}')

    runCli(['init'], { cwd: tmpDir })

    // Custom content should be preserved (non-interactive → no overwrite prompt)
    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.json'), 'utf8')
    assert.strictEqual(content, '{"custom": true}')
  })

  it('init reports "(up to date)" when config matches current defaults', () => {
    // First init creates with hash
    runCli(['init'], { cwd: tmpDir })
    // Second init should detect up-to-date
    const result = runCli(['init'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /up to date/)
  })

  it('init auto-upgrades outdated unedited config', () => {
    // First init with no default checks
    runCli(['init', '--no-default-checks'], { cwd: tmpDir })
    // Re-init with default checks — should auto-upgrade
    const result = runCli(['init'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /Updated:.*upgraded to current defaults/)
  })

  it('init --no-overwrite reports "(customized)" for edited config', () => {
    // Init to create config with hash
    runCli(['init'], { cwd: tmpDir })
    // Modify the config
    const cfgPath = path.join(tmpDir, '.claude', 'prove_it.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.sources = ['src/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

    const result = runCli(['init', '--no-overwrite'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /customized/)
  })

  it('init --overwrite overwrites edited config', () => {
    // Init to create config with hash
    runCli(['init'], { cwd: tmpDir })
    // Modify the config
    const cfgPath = path.join(tmpDir, '.claude', 'prove_it.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.sources = ['src/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

    const result = runCli(['init', '--overwrite'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /Updated:.*overwritten with current defaults/)
    // Config should now have default sources, not the customized ones
    const newCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    assert.ok(newCfg.initSeed, 'should have initSeed')
    assert.ok(!newCfg.sources.includes('src/**/*.js'))
  })

  it('init --overwrite respects other flags', () => {
    // Init with defaults (includes default checks)
    runCli(['init'], { cwd: tmpDir })
    // Modify the config so it's "edited"
    const cfgPath = path.join(tmpDir, '.claude', 'prove_it.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.sources = ['src/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

    // Overwrite with --no-default-checks
    const result = runCli(['init', '--overwrite', '--no-default-checks'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    const newCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    assert.ok(newCfg.initSeed)
    const allTasks = newCfg.hooks.flatMap(h => h.tasks || [])
    assert.ok(!allTasks.some(t => t.name === 'commit-review'), 'should not have default checks')
    assert.ok(!allTasks.some(t => t.name === 'coverage-review'), 'should not have default checks')
  })

  it('init shows "Commit changes" TODO after auto-upgrade', () => {
    // Init with --no-default-checks, then re-init with defaults to trigger upgrade
    runCli(['init', '--no-default-checks'], { cwd: tmpDir })
    const result = runCli(['init'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /\[ \] Commit changes/)
  })

  it('init shows sources TODO when placeholder globs are present', () => {
    const result = runCli(['init'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /Replace the placeholder sources globs/)
  })

  it('init shows sources done when globs are customized', () => {
    // Init first
    runCli(['init'], { cwd: tmpDir })
    // Customize sources
    const cfgPath = path.join(tmpDir, '.claude', 'prove_it.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.sources = ['src/**/*.js', 'test/**/*.js']
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
    // Re-run init
    const result = runCli(['init'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /\[x\] Sources globs configured/)
  })

  it('init shows trap instructions when scripts lack prove_it record', () => {
    // Create customized scripts without prove_it record
    fs.mkdirSync(path.join(tmpDir, 'script'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'), '#!/usr/bin/env bash\nnpm test\n')
    fs.writeFileSync(path.join(tmpDir, 'script', 'test_fast'), '#!/usr/bin/env bash\nnpm run test:unit\n')

    const result = runCli(['init'], { cwd: tmpDir })
    assert.match(result.stdout, /skip redundant test runs/)
    assert.match(result.stdout, /trap 'prove_it record --name full-tests --result \$\?' EXIT/)
    assert.match(result.stdout, /trap 'prove_it record --name fast-tests --result \$\?' EXIT/)
  })

  it('init TODO shows done when script has prove_it record', () => {
    fs.mkdirSync(path.join(tmpDir, 'script'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'),
      "#!/usr/bin/env bash\ntrap 'prove_it record --name full-tests --result $?' EXIT\nnpm test\n")
    fs.writeFileSync(path.join(tmpDir, 'script', 'test_fast'),
      "#!/usr/bin/env bash\ntrap 'prove_it record --name fast-tests --result $?' EXIT\nnpm run test:unit\n")

    const result = runCli(['init'], { cwd: tmpDir })
    assert.match(result.stdout, /\[x\] script\/test records results/)
    assert.match(result.stdout, /\[x\] script\/test_fast records results/)
  })

  it('reinit removes and recreates prove_it files', () => {
    // Init first with custom content
    runCli(['init'], { cwd: tmpDir })
    const cfgPath = path.join(tmpDir, '.claude', 'prove_it.json')
    assert.ok(fs.existsSync(cfgPath))

    // Manually delete the config to prove reinit recreates it
    fs.unlinkSync(cfgPath)
    assert.ok(!fs.existsSync(cfgPath))

    const result = runCli(['reinit'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)
    assert.ok(fs.existsSync(cfgPath), 'reinit should recreate prove_it.json')
  })

  it('deinit removes prove_it files', () => {
    // First init
    runCli(['init'], { cwd: tmpDir })
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.local.json')))

    // Then deinit
    const result = runCli(['deinit'], { cwd: tmpDir })
    assert.strictEqual(result.exitCode, 0)

    // Files should be gone
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.json')))
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.local.json')))
  })

  it('deinit preserves customized script/test', () => {
    // Init first
    runCli(['init'], { cwd: tmpDir })

    // Customize script/test
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'), '#!/usr/bin/env bash\nnpm test\n')

    // Deinit
    runCli(['deinit'], { cwd: tmpDir })

    // script/test should still exist since it was customized
    assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test')))
  })

  it('deinit removes stub script/test and script/test_fast', () => {
    // Init creates stubs
    runCli(['init'], { cwd: tmpDir })

    // Deinit should remove them since they're still stubs
    runCli(['deinit'], { cwd: tmpDir })

    assert.ok(!fs.existsSync(path.join(tmpDir, 'script', 'test')))
    assert.ok(!fs.existsSync(path.join(tmpDir, 'script', 'test_fast')))
  })

  it('deinit removes default rule file', () => {
    runCli(['init'], { cwd: tmpDir })
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'testing.md')))

    runCli(['deinit'], { cwd: tmpDir })
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'testing.md')))
  })

  it('deinit preserves customized rule file', () => {
    runCli(['init'], { cwd: tmpDir })
    const rulePath = path.join(tmpDir, '.claude', 'rules', 'testing.md')
    fs.writeFileSync(rulePath, '# My custom rules\n')

    const result = runCli(['deinit'], { cwd: tmpDir })
    assert.ok(fs.existsSync(rulePath), 'Customized rule file should be preserved')
    assert.match(result.stdout, /customized/)
  })
})

describe('install/uninstall', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_install_'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('install creates hooks in settings.json', () => {
    runCli(['install'], { env: { ...process.env, HOME: tmpDir } })

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
    assert.ok(fs.existsSync(settingsPath), 'settings.json should exist')

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const serialized = JSON.stringify(settings.hooks)

    assert.ok(serialized.includes('prove_it hook claude:Stop'),
      'Should have Stop dispatcher')
    assert.ok(serialized.includes('prove_it hook claude:PreToolUse'),
      'Should have PreToolUse dispatcher')
    assert.ok(serialized.includes('prove_it hook claude:SessionStart'),
      'Should have SessionStart dispatcher')
  })

  it('install does not create rules file (v2 has no global rules)', () => {
    runCli(['install'], { env: { ...process.env, HOME: tmpDir } })

    const rulesPath = path.join(tmpDir, '.claude', 'rules', 'prove_it.md')
    assert.ok(!fs.existsSync(rulesPath),
      'prove_it.md rules file should not exist in v2')
  })

  it('install does not create global config (v2 is project-only)', () => {
    runCli(['install'], { env: { ...process.env, HOME: tmpDir } })

    const configPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
    assert.ok(!fs.existsSync(configPath),
      'Global config should not exist in v2')
  })

  it('install is idempotent', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })
    runCli(['install'], { env })

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))

    // Each hook event should have exactly 1 prove_it dispatcher
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const proveItGroups = groups.filter(g =>
        JSON.stringify(g).includes('prove_it hook')
      )
      assert.strictEqual(proveItGroups.length, 1,
        `${event} should have exactly 1 prove_it dispatcher`)
    }
  })

  it('install reports "up to date" on second run', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })
    const result = runCli(['install'], { env })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /already up to date/)
    assert.ok(!result.stdout.includes('Restart Claude Code'),
      'Should not show restart banner when already up to date')
  })

  it('install updates outdated hooks', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })

    // Simulate outdated hooks by changing a matcher
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const ptGroup = settings.hooks.PreToolUse.find(g =>
      JSON.stringify(g).includes('prove_it hook'))
    ptGroup.matcher = 'Edit|Write'
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')

    // Re-install should fix it
    const result = runCli(['install'], { env })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /prove_it installed/)

    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const updatedGroup = updated.hooks.PreToolUse.find(g =>
      JSON.stringify(g).includes('prove_it hook'))
    assert.strictEqual(updatedGroup.matcher, 'Edit|Write|NotebookEdit|Bash')
  })

  it('install detects outdated skill file', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })

    // Tamper with the skill file
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'prove', 'SKILL.md')
    fs.writeFileSync(skillPath, 'outdated content')

    // Re-install should detect it and update
    const result = runCli(['install'], { env })
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /prove_it installed/)

    const content = fs.readFileSync(skillPath, 'utf8')
    assert.ok(content !== 'outdated content', 'Skill should be updated')
  })

  it('uninstall removes hooks and config', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })

    // Verify install worked
    const settingsCheck = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'))
    assert.ok(JSON.stringify(settingsCheck).includes('prove_it hook'))

    runCli(['uninstall'], { env })

    // Hooks should be removed from settings
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const serialized = JSON.stringify(settings)
    assert.ok(!serialized.includes('prove_it hook'),
      'No prove_it hooks should remain in settings.json')

    // Config dir and rules should be removed
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'prove_it')),
      'prove_it config directory should be removed')
    assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'prove_it.md')),
      'prove_it rules file should be removed')
  })

  it('install creates skill file', () => {
    runCli(['install'], { env: { ...process.env, HOME: tmpDir } })

    const skillPath = path.join(tmpDir, '.claude', 'skills', 'prove', 'SKILL.md')
    assert.ok(fs.existsSync(skillPath), 'SKILL.md should exist')

    const content = fs.readFileSync(skillPath, 'utf8')
    assert.match(content, /^---\nname: prove\n/,
      'Should have valid frontmatter with name: prove')
    assert.match(content, /allowed-tools:/,
      'Should have allowed-tools')
    assert.match(content, /disable-model-invocation: true/,
      'Should have disable-model-invocation: true')
  })

  it('install overwrites existing skill file', () => {
    const env = { ...process.env, HOME: tmpDir }
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'prove')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'old content')

    runCli(['install'], { env })

    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
    assert.ok(content !== 'old content', 'Should overwrite old content')
    assert.match(content, /^---\nname: prove\n/,
      'Should have current skill content')
  })

  it('uninstall removes skill directory', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })

    const skillDir = path.join(tmpDir, '.claude', 'skills', 'prove')
    assert.ok(fs.existsSync(skillDir), 'Skill dir should exist after install')

    runCli(['uninstall'], { env })
    assert.ok(!fs.existsSync(skillDir), 'Skill dir should be removed after uninstall')
  })
})

describe('skill source', () => {
  it('has valid frontmatter', () => {
    const skillSource = path.join(__dirname, '..', 'lib', 'skills', 'prove.md')
    const content = fs.readFileSync(skillSource, 'utf8')

    // Single opening --- (not double)
    assert.ok(content.startsWith('---\n'), 'Should start with single ---')
    assert.ok(!content.startsWith('---\n---'), 'Should not have double ---')

    // Extract frontmatter
    const endIdx = content.indexOf('\n---\n', 4)
    assert.ok(endIdx > 0, 'Should have closing ---')
    const frontmatter = content.slice(4, endIdx)

    assert.match(frontmatter, /^name: prove$/m, 'name should be prove')
    assert.match(frontmatter, /disable-model-invocation: true/,
      'Should disable model invocation')
    assert.match(frontmatter, /allowed-tools:/, 'Should have allowed-tools')
    assert.match(frontmatter, /- Bash/, 'Should allow Bash tool')
    assert.match(frontmatter, /argument-hint:/, 'Should have argument-hint')
  })
})
