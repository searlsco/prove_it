const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

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
