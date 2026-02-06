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
      assert.match(result.stdout, /prove_it.*Verifiability-first/s)
      assert.match(result.stdout, /install/)
      assert.match(result.stdout, /uninstall/)
      assert.match(result.stdout, /init/)
      assert.match(result.stdout, /deinit/)
    })

    it('shows help with help command', () => {
      const result = runCli(['help'])
      assert.match(result.stdout, /prove_it.*Verifiability-first/s)
    })

    it('shows help with --help flag', () => {
      const result = runCli(['--help'])
      assert.match(result.stdout, /prove_it.*Verifiability-first/s)
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

    // Check script/test is executable
    const stat = fs.statSync(path.join(tmpDir, 'script', 'test'))
    assert.ok(stat.mode & fs.constants.S_IXUSR, 'script/test should be executable')
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

  it('deinit removes stub script/test', () => {
    // Init creates stub
    runCli(['init'], { cwd: tmpDir })

    // Deinit should remove it since it's still the stub
    runCli(['deinit'], { cwd: tmpDir })

    assert.ok(!fs.existsSync(path.join(tmpDir, 'script', 'test')))
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

    assert.ok(serialized.includes('prove_it hook stop'),
      'Should have stop hook')
    assert.ok(serialized.includes('prove_it hook done'),
      'Should have done hook')
    assert.ok(serialized.includes('prove_it hook edit'),
      'Should have edit hook')
    assert.ok(serialized.includes('prove_it hook session-start'),
      'Should have session-start hook')
  })

  it('install copies rules file', () => {
    runCli(['install'], { env: { ...process.env, HOME: tmpDir } })

    const rulesPath = path.join(tmpDir, '.claude', 'rules', 'prove_it.md')
    assert.ok(fs.existsSync(rulesPath),
      'prove_it.md rules file should exist')
  })

  it('install creates global config', () => {
    runCli(['install'], { env: { ...process.env, HOME: tmpDir } })

    const configPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
    assert.ok(fs.existsSync(configPath),
      'Global config should exist')

    // Should be valid JSON
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.ok(typeof config === 'object', 'Config should be a valid object')
  })

  it('install is idempotent', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })
    runCli(['install'], { env })

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))

    // Each hook event array should have exactly one prove_it entry
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const proveItGroups = groups.filter((g) =>
        JSON.stringify(g).includes('prove_it hook')
      )
      // Stop has 1, PreToolUse has 2 (done + edit), SessionStart has 1
      // Just verify no duplicates: each unique group appears once
      const serialized = proveItGroups.map((g) => JSON.stringify(g))
      const unique = new Set(serialized)
      assert.strictEqual(serialized.length, unique.size,
        `${event} should have no duplicate prove_it hook groups`)
    }
  })

  it('uninstall removes hooks and config', () => {
    const env = { ...process.env, HOME: tmpDir }
    runCli(['install'], { env })

    // Verify install worked
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json')))

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
