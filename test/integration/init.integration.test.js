const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { freshRepo } = require('../helpers')
const { configHash } = require('../../lib/config')
const {
  isScriptTestStub, initProject, overwriteTeamConfig,
  installGitHookShim, removeGitHookShim,
  isProveItShim, hasProveItSection, isDefaultRuleFile,
  PROVE_IT_SHIM_MARKER
} = require('../../lib/init')

describe('init integration', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  // ---------- Predicates (parameterized) ----------
  describe('isScriptTestStub', () => {
    const cases = [
      ['stub script', '#!/usr/bin/env bash\necho "No tests configured. Edit script/test to run your test suite."\nexit 1\n', true],
      ['customized script', '#!/usr/bin/env bash\nnpm test\n', false],
      ['customized with prove_it header', '#!/usr/bin/env bash\n# prove_it: full test suite\nset -e\nnpm test\n', false]
    ]
    cases.forEach(([label, content, expected]) => {
      it(`${label} → ${expected}`, () => {
        const p = path.join(tmpDir, 'script', 'test')
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, content)
        assert.strictEqual(isScriptTestStub(p), expected)
      })
    })

    it('returns false for nonexistent file', () => {
      assert.ok(!isScriptTestStub(path.join(tmpDir, 'nonexistent')))
    })
  })

  describe('isDefaultRuleFile', () => {
    it('default → true, customized → false, nonexistent → false', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(isDefaultRuleFile(path.join(tmpDir, '.claude', 'rules', 'testing.md')))

      fs.writeFileSync(path.join(tmpDir, '.claude', 'rules', 'testing.md'), '# Custom\n')
      assert.ok(!isDefaultRuleFile(path.join(tmpDir, '.claude', 'rules', 'testing.md')))

      assert.ok(!isDefaultRuleFile(path.join(tmpDir, 'nonexistent')))
    })
  })

  describe('isProveItShim / hasProveItSection', () => {
    it('detects shim files and merged sections', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })

      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nprove_it hook git:pre-commit\n')
      assert.ok(isProveItShim(hookPath))

      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nnpm test\n')
      assert.ok(!isProveItShim(hookPath))

      fs.writeFileSync(hookPath,
        `#!/usr/bin/env bash\nrun-lint\n\n${PROVE_IT_SHIM_MARKER}\nprove_it hook git:pre-commit\n${PROVE_IT_SHIM_MARKER}\n`)
      assert.ok(hasProveItSection(hookPath))
    })
  })

  // ---------- Story: installGitHookShim ----------
  describe('installGitHookShim', () => {
    it('creates fresh, merges with existing, skips when autoMerge false, avoids double-install', () => {
      // Fresh install
      const r1 = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(r1.installed && !r1.existed)
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      assert.ok(fs.readFileSync(hookPath, 'utf8').includes('prove_it hook git:pre-commit'))
      assert.ok(fs.statSync(hookPath).mode & fs.constants.S_IXUSR)

      // No double-install
      const r2 = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(r2.existed && !r2.installed && !r2.merged)

      // Remove for next tests
      fs.unlinkSync(hookPath)

      // Merge with existing
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')
      fs.chmodSync(hookPath, 0o755)
      const r3 = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(r3.existed && r3.merged)
      const merged = fs.readFileSync(hookPath, 'utf8')
      assert.ok(merged.includes('run-lint') && merged.includes('prove_it hook'))

      // Clean up
      fs.unlinkSync(hookPath)

      // Skip when autoMerge false
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')
      const r4 = installGitHookShim(tmpDir, 'pre-commit', false)
      assert.ok(r4.existed && r4.skipped)
      assert.ok(!fs.readFileSync(hookPath, 'utf8').includes('prove_it'))
    })

    it('inserts before exec and repositions stale sections', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })

      // Insert before exec
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nexec other-tool hook pre-commit "$@"\n')
      fs.chmodSync(hookPath, 0o755)
      installGitHookShim(tmpDir, 'pre-commit', true)
      let content = fs.readFileSync(hookPath, 'utf8')
      assert.ok(content.indexOf(PROVE_IT_SHIM_MARKER) < content.indexOf('exec other-tool'))

      // Reposition stale (prove_it after exec)
      fs.writeFileSync(hookPath, [
        '#!/usr/bin/env bash',
        'exec other-tool hook pre-commit "$@"',
        '', PROVE_IT_SHIM_MARKER,
        'prove_it hook git:pre-commit',
        PROVE_IT_SHIM_MARKER, ''
      ].join('\n'))
      fs.chmodSync(hookPath, 0o755)
      const r = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(r.repositioned)
      content = fs.readFileSync(hookPath, 'utf8')
      assert.ok(content.indexOf(PROVE_IT_SHIM_MARKER) < content.indexOf('exec other-tool'))
    })
  })

  // ---------- Story: removeGitHookShim ----------
  describe('removeGitHookShim', () => {
    it('removes shim, keeps merged content, returns false when missing/non-shim', () => {
      // Remove full shim
      installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(removeGitHookShim(tmpDir, 'pre-commit'))
      assert.ok(!fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit')))

      // Remove merged section, keep original
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')
      fs.chmodSync(hookPath, 0o755)
      installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(removeGitHookShim(tmpDir, 'pre-commit'))
      const content = fs.readFileSync(hookPath, 'utf8')
      assert.ok(content.includes('run-lint') && !content.includes('prove_it'))

      // Missing → false
      fs.unlinkSync(hookPath)
      assert.ok(!removeGitHookShim(tmpDir, 'pre-commit'))

      // Non-shim → false
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')
      assert.ok(!removeGitHookShim(tmpDir, 'pre-commit'))
    })
  })

  // ---------- Story: initProject fresh ----------
  describe('initProject fresh', () => {
    it('creates all files, has initSeed, passes validation, scripts executable, stubs marked', () => {
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(results.teamConfig.created)
      assert.ok(results.localConfig.created)
      assert.ok(results.scriptTest.created && results.scriptTest.isStub)
      assert.ok(results.scriptTestFast.created)
      assert.ok(results.ruleFile.created)
      assert.ok(results.proveItGitignore.created)

      // Files exist
      assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json')))
      assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test')))

      // initSeed
      const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), 'utf8'))
      assert.ok(cfg.initSeed && cfg.initSeed.length === 12)
      assert.strictEqual(cfg.initSeed, configHash(cfg))

      // Passes validation
      const { validateConfig } = require('../../lib/validate')
      assert.deepStrictEqual(validateConfig(cfg).errors, [])

      // Executable
      assert.ok(fs.statSync(path.join(tmpDir, 'script', 'test')).mode & fs.constants.S_IXUSR)
      assert.ok(fs.statSync(path.join(tmpDir, 'script', 'test_fast')).mode & fs.constants.S_IXUSR)

      // isScriptTestStub for test_fast
      assert.ok(isScriptTestStub(path.join(tmpDir, 'script', 'test_fast')))

      // Rule file content
      const ruleContent = fs.readFileSync(path.join(tmpDir, '.claude', 'rules', 'testing.md'), 'utf8')
      assert.ok(ruleContent.includes('Testing Rules'))

      // No rule file when defaultChecks false
      const tmpDir2 = freshRepo()
      initProject(tmpDir2, { gitHooks: false, defaultChecks: false })
      assert.ok(!fs.existsSync(path.join(tmpDir2, '.claude', 'rules', 'testing.md')))
      fs.rmSync(tmpDir2, { recursive: true, force: true })

      // .gitignore content
      const gi = fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it', '.gitignore'), 'utf8')
      assert.ok(gi.includes('sessions/') && gi.includes('config.local.json'))

      // Git hooks
      const tmpDir3 = freshRepo()
      const hookResults = initProject(tmpDir3, { gitHooks: true, defaultChecks: false })
      assert.ok(hookResults.gitHookFiles.preCommit.installed)
      assert.ok(hookResults.gitHookFiles.prePush.installed)
      fs.rmSync(tmpDir3, { recursive: true, force: true })
    })
  })

  // ---------- Story: initProject existing ----------
  describe('initProject existing', () => {
    it('preserves edited config, detects upToDate/upgraded/edited, handles legacy', () => {
      // Does not overwrite existing config
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, '{"custom": true}')
      let r = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(r.teamConfig.existed && r.teamConfig.edited && !r.teamConfig.created)
      assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), '{"custom": true}')

      // Preserves existing customized script
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nnpm test\n')
      fs.chmodSync(scriptPath, 0o755)
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(r.scriptTest.existed && !r.scriptTest.isStub)

      // Preserves existing script/test_fast
      const fastPath = path.join(tmpDir, 'script', 'test_fast')
      fs.writeFileSync(fastPath, '#!/usr/bin/env bash\nnpm run test:unit\n')
      fs.chmodSync(fastPath, 0o755)
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(r.scriptTestFast.existed && fs.readFileSync(fastPath, 'utf8').includes('npm run test:unit'))

      // Preserves existing rule file
      const ruleDir = path.join(tmpDir, '.claude', 'rules')
      fs.mkdirSync(ruleDir, { recursive: true })
      fs.writeFileSync(path.join(ruleDir, 'testing.md'), 'Custom rules\n')
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(r.ruleFile.existed && !r.ruleFile.created)
      assert.strictEqual(fs.readFileSync(path.join(ruleDir, 'testing.md'), 'utf8'), 'Custom rules\n')

      // upToDate
      fs.unlinkSync(cfgPath)
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(r.teamConfig.upToDate && !r.teamConfig.upgraded && !r.teamConfig.edited)

      // upgraded (different flags)
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(r.teamConfig.upgraded && !r.teamConfig.upToDate && !r.teamConfig.edited)
      const upgCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.strictEqual(upgCfg.initSeed, configHash(upgCfg))

      // sources-only change → auto-upgraded with sources preserved
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      cfg.sources = ['src/**/*.js']
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(r.teamConfig.upgraded && !r.teamConfig.edited)
      assert.ok(r.teamConfig.sourcesPreserved)
      const srcCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.deepStrictEqual(srcCfg.sources, ['src/**/*.js'])
      assert.strictEqual(srcCfg.initSeed, configHash(srcCfg))

      // edited (non-sources modification)
      const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      cfg2.hooks = []
      fs.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2) + '\n')
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(r.teamConfig.edited)

      // Legacy (no initSeed) → edited
      fs.writeFileSync(cfgPath, JSON.stringify({ hooks: [] }, null, 2) + '\n')
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(r.teamConfig.edited)

      // Corrupted JSON → edited, preserved
      fs.writeFileSync(cfgPath, '{"truncated":')
      r = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(r.teamConfig.edited)
      assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), '{"truncated":')

      // .gitignore: does not overwrite, appends config.local.json, no duplicate
      const giPath = path.join(tmpDir, '.claude', 'prove_it', '.gitignore')
      fs.writeFileSync(giPath, 'custom-stuff/\n')
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      let giContent = fs.readFileSync(giPath, 'utf8')
      assert.ok(giContent.includes('custom-stuff/') && giContent.includes('config.local.json'))
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      giContent = fs.readFileSync(giPath, 'utf8')
      assert.strictEqual((giContent.match(/config\.local\.json/g) || []).length, 1)
    })
  })

  // ---------- Story: overwriteTeamConfig ----------
  describe('overwriteTeamConfig', () => {
    it('writes fresh config with matching initSeed', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      fs.writeFileSync(cfgPath, JSON.stringify({ custom: true }, null, 2) + '\n')

      overwriteTeamConfig(tmpDir, { gitHooks: false, defaultChecks: false })
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.ok(cfg.initSeed && cfg.enabled && !cfg.custom)
      assert.strictEqual(cfg.initSeed, configHash(cfg))
    })

    it('preserves custom sources from existing config', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      cfg.sources = ['src/**/*.js', 'test/**/*.js']
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

      const result = overwriteTeamConfig(tmpDir, { gitHooks: false, defaultChecks: false })
      const updated = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.deepStrictEqual(updated.sources, ['src/**/*.js', 'test/**/*.js'])
      assert.strictEqual(updated.initSeed, configHash(updated))
      assert.strictEqual(result.sourcesPreserved, true)
    })

    it('does not preserve placeholder sources', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')

      const result = overwriteTeamConfig(tmpDir, { gitHooks: false, defaultChecks: false })
      const updated = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.ok(updated.sources.some(s => s.includes('replace/these/with/globs')))
      assert.strictEqual(result.sourcesPreserved, false)
    })

    it('uses explicitly passed preservedSources over auto-detected', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      cfg.sources = ['src/**/*.js']
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

      overwriteTeamConfig(tmpDir, {
        gitHooks: false,
        defaultChecks: false,
        preservedSources: ['lib/**/*.ts']
      })
      const updated = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.deepStrictEqual(updated.sources, ['lib/**/*.ts'])
    })
  })

  // ---------- Story: initProject with preservedSources ----------
  describe('initProject preservedSources', () => {
    it('injects preservedSources into fresh config with correct initSeed', () => {
      const results = initProject(tmpDir, {
        gitHooks: false,
        defaultChecks: false,
        preservedSources: ['app/**/*.rb', 'spec/**/*.rb']
      })
      assert.ok(results.teamConfig.created)
      assert.strictEqual(results.teamConfig.sourcesPreserved, true)

      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.deepStrictEqual(cfg.sources, ['app/**/*.rb', 'spec/**/*.rb'])
      assert.strictEqual(cfg.initSeed, configHash(cfg))
    })

    it('does not set sourcesPreserved when no preservedSources given', () => {
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.teamConfig.created)
      assert.strictEqual(results.teamConfig.sourcesPreserved, undefined)
    })

    it('auto-upgrade preserves sources set via preservedSources', () => {
      // Init with preservedSources (simulates deinit → init round-trip)
      const r1 = initProject(tmpDir, {
        gitHooks: false,
        defaultChecks: false,
        preservedSources: ['cli.js', 'lib/**/*.js', 'test/**/*.js']
      })
      assert.ok(r1.teamConfig.created)
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')

      // Re-init with different flags → auto-upgrade should preserve sources
      const r2 = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(r2.teamConfig.upgraded)
      assert.ok(r2.teamConfig.sourcesPreserved)
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.deepStrictEqual(cfg.sources, ['cli.js', 'lib/**/*.js', 'test/**/*.js'])
      assert.strictEqual(cfg.initSeed, configHash(cfg))
    })
  })
})
