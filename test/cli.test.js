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

    // Check config is v2 format
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.json'), 'utf8'))
    assert.strictEqual(cfg.configVersion, 2)
    assert.ok(Array.isArray(cfg.hooks), 'hooks should be an array')
  })

  it('init is non-destructive', () => {
    // Create a custom prove_it.json first
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'prove_it.json'), '{"custom": true}')

    runCli(['init'], { cwd: tmpDir })

    // Custom content should be preserved
    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it.json'), 'utf8')
    assert.strictEqual(content, '{"custom": true}')
  })

  it('init TODO nudges to add prove_it record when script lacks it', () => {
    // Create customized scripts without prove_it record
    fs.mkdirSync(path.join(tmpDir, 'script'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'), '#!/bin/bash\nnpm test\n')
    fs.writeFileSync(path.join(tmpDir, 'script', 'test_fast'), '#!/bin/bash\nnpm run test:unit\n')

    const result = runCli(['init'], { cwd: tmpDir })
    assert.match(result.stdout, /Add `prove_it record` to script\/test/)
    assert.match(result.stdout, /Add `prove_it record` to script\/test_fast/)
  })

  it('init TODO shows done when script has prove_it record', () => {
    fs.mkdirSync(path.join(tmpDir, 'script'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'),
      "#!/bin/bash\ntrap 'prove_it record --name full-tests --result $?' EXIT\nnpm test\n")
    fs.writeFileSync(path.join(tmpDir, 'script', 'test_fast'),
      "#!/bin/bash\ntrap 'prove_it record --name fast-tests --result $?' EXIT\nnpm run test:unit\n")

    const result = runCli(['init'], { cwd: tmpDir })
    assert.match(result.stdout, /\[x\] script\/test records results/)
    assert.match(result.stdout, /\[x\] script\/test_fast records results/)
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
    fs.writeFileSync(path.join(tmpDir, 'script', 'test'), '#!/bin/bash\nnpm test\n')

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
})
