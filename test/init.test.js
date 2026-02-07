const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { isScriptTestStub, getTierConfig, addToGitignore, initProject } = require('../lib/init')

describe('init', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_init_test_'))
    spawnSync('git', ['init'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('isScriptTestStub', () => {
    it('returns true for stub script', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/bin/bash\n# prove_it: Replace this\nexit 1\n')
      assert.ok(isScriptTestStub(scriptPath))
    })

    it('returns false for customized script', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/bin/bash\nnpm test\n')
      assert.ok(!isScriptTestStub(scriptPath))
    })

    it('returns false for nonexistent file', () => {
      assert.ok(!isScriptTestStub(path.join(tmpDir, 'nonexistent')))
    })
  })

  describe('getTierConfig', () => {
    it('returns v2 config for tier 1', () => {
      const cfg = getTierConfig(1)
      assert.strictEqual(cfg.configVersion, 2)
      assert.ok(Array.isArray(cfg.hooks))
    })

    it('returns v2 config for tier 2', () => {
      const cfg = getTierConfig(2)
      assert.strictEqual(cfg.configVersion, 2)
      assert.ok(Array.isArray(cfg.hooks))
    })

    it('returns v2 config for tier 3', () => {
      const cfg = getTierConfig(3)
      assert.strictEqual(cfg.configVersion, 2)
      assert.ok(Array.isArray(cfg.hooks))
      // Tier 3 should have more hooks than tier 1
      const tier1 = getTierConfig(1)
      assert.ok(cfg.hooks.length >= tier1.hooks.length,
        'Tier 3 should have at least as many hooks as tier 1')
    })

    it('defaults to tier 3 for invalid tier', () => {
      const cfg = getTierConfig(99)
      const tier3 = getTierConfig(3)
      assert.deepStrictEqual(cfg, tier3)
    })
  })

  describe('addToGitignore', () => {
    it('creates .gitignore if missing', () => {
      const result = addToGitignore(tmpDir, '.claude/prove_it.local.json')
      assert.ok(result)
      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')
      assert.ok(content.includes('.claude/prove_it.local.json'))
    })

    it('appends to existing .gitignore', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n')
      const result = addToGitignore(tmpDir, '.claude/prove_it.local.json')
      assert.ok(result)
      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')
      assert.ok(content.includes('node_modules'))
      assert.ok(content.includes('.claude/prove_it.local.json'))
    })

    it('does not duplicate existing entry', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.claude/prove_it.local.json\n')
      const result = addToGitignore(tmpDir, '.claude/prove_it.local.json')
      assert.ok(!result)
    })
  })

  describe('initProject', () => {
    it('creates team config, local config, and script/test', () => {
      const results = initProject(tmpDir, { tier: 1 })
      assert.ok(results.teamConfig.created)
      assert.ok(results.localConfig.created)
      assert.ok(results.scriptTest.created)
      assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.json')))
      assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.local.json')))
      assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test')))
    })

    it('does not overwrite existing team config', () => {
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it.json')
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, '{"custom": true}')

      const results = initProject(tmpDir, { tier: 1 })
      assert.ok(results.teamConfig.existed)
      assert.ok(!results.teamConfig.created)

      const content = fs.readFileSync(cfgPath, 'utf8')
      assert.strictEqual(content, '{"custom": true}')
    })

    it('creates executable script/test stub', () => {
      initProject(tmpDir, { tier: 1 })
      const stat = fs.statSync(path.join(tmpDir, 'script', 'test'))
      assert.ok(stat.mode & fs.constants.S_IXUSR, 'script/test should be executable')
    })

    it('marks stub as needing customization', () => {
      const results = initProject(tmpDir, { tier: 1 })
      assert.ok(results.scriptTest.isStub)
    })

    it('reports existing customized script', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/bin/bash\nnpm test\n')
      fs.chmodSync(scriptPath, 0o755)

      const results = initProject(tmpDir, { tier: 1 })
      assert.ok(results.scriptTest.existed)
      assert.ok(!results.scriptTest.isStub)
    })
  })
})
