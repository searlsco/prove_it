const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { freshRepo } = require('../helpers')
const { configHash } = require('../../lib/config')
const {
  isScriptTestStub,
  initProject,
  overwriteTeamConfig,
  installGitHookShim,
  removeGitHookShim,
  isProveItShim,
  hasProveItSection,
  isDefaultRuleFile,
  PROVE_IT_SHIM_MARKER
} = require('../../lib/init')

describe('init integration', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = freshRepo()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('isScriptTestStub', () => {
    it('returns true for stub script', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\necho "No tests configured. Edit script/test to run your test suite."\nexit 1\n')
      assert.ok(isScriptTestStub(scriptPath))
    })

    it('returns false for customized script', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nnpm test\n')
      assert.ok(!isScriptTestStub(scriptPath))
    })

    it('returns false for customized script that kept prove_it comment header', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\n# prove_it: full test suite\nset -e\nnpm test\n')
      assert.ok(!isScriptTestStub(scriptPath))
    })

    it('returns false for nonexistent file', () => {
      assert.ok(!isScriptTestStub(path.join(tmpDir, 'nonexistent')))
    })
  })

  describe('isDefaultRuleFile', () => {
    it('returns true for default rule file', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      const rulePath = path.join(tmpDir, '.claude', 'rules', 'testing.md')
      assert.ok(isDefaultRuleFile(rulePath))
    })

    it('returns false for customized rule file', () => {
      const ruleDir = path.join(tmpDir, '.claude', 'rules')
      fs.mkdirSync(ruleDir, { recursive: true })
      fs.writeFileSync(path.join(ruleDir, 'testing.md'), '# Custom rules\n')
      assert.ok(!isDefaultRuleFile(path.join(ruleDir, 'testing.md')))
    })

    it('returns false for nonexistent file', () => {
      assert.ok(!isDefaultRuleFile(path.join(tmpDir, 'nonexistent')))
    })
  })

  describe('installGitHookShim', () => {
    it('creates shim when no hook exists', () => {
      const result = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(result.installed)
      assert.ok(!result.existed)
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      assert.ok(fs.existsSync(hookPath))
      const content = fs.readFileSync(hookPath, 'utf8')
      assert.ok(content.includes('prove_it hook git:pre-commit'))
      // Should be executable
      const stat = fs.statSync(hookPath)
      assert.ok(stat.mode & fs.constants.S_IXUSR)
    })

    it('merges with existing hook when autoMerge is true', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')
      fs.chmodSync(hookPath, 0o755)

      const result = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(result.existed)
      assert.ok(result.merged)
      const content = fs.readFileSync(hookPath, 'utf8')
      assert.ok(content.includes('run-lint'))
      assert.ok(content.includes('prove_it hook git:pre-commit'))
      assert.ok(content.includes(PROVE_IT_SHIM_MARKER))
    })

    it('skips existing hook when autoMerge is false', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')

      const result = installGitHookShim(tmpDir, 'pre-commit', false)
      assert.ok(result.existed)
      assert.ok(result.skipped)
      const content = fs.readFileSync(hookPath, 'utf8')
      assert.ok(!content.includes('prove_it'))
    })

    it('does not double-install if already a shim', () => {
      installGitHookShim(tmpDir, 'pre-commit', true)
      const result = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(result.existed)
      assert.ok(!result.installed)
      assert.ok(!result.merged)
    })

    it('inserts before exec when autoMerge is true', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nexec other-tool hook pre-commit "$@"\n')
      fs.chmodSync(hookPath, 0o755)

      const result = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(result.existed)
      assert.ok(result.merged)
      const content = fs.readFileSync(hookPath, 'utf8')
      const proveItPos = content.indexOf(PROVE_IT_SHIM_MARKER)
      const execPos = content.indexOf('exec other-tool hook')
      assert.ok(proveItPos < execPos,
        `prove_it section (pos ${proveItPos}) should be before exec (pos ${execPos})`)
      assert.ok(content.includes('prove_it hook git:pre-commit'))
      assert.ok(content.includes('exec other-tool hook'))
    })

    it('repositions existing section from after exec to before exec', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      // Simulate a stale merge: prove_it section AFTER exec
      const staleContent = [
        '#!/usr/bin/env bash',
        'exec other-tool hook pre-commit "$@"',
        '',
        PROVE_IT_SHIM_MARKER,
        'prove_it hook git:pre-commit',
        PROVE_IT_SHIM_MARKER,
        ''
      ].join('\n')
      fs.writeFileSync(hookPath, staleContent)
      fs.chmodSync(hookPath, 0o755)

      const result = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(result.existed)
      assert.ok(result.repositioned)
      const content = fs.readFileSync(hookPath, 'utf8')
      const proveItPos = content.indexOf(PROVE_IT_SHIM_MARKER)
      const execPos = content.indexOf('exec other-tool hook')
      assert.ok(proveItPos < execPos,
        `prove_it section (pos ${proveItPos}) should be before exec (pos ${execPos})`)
    })

    it('appends normally when no exec present', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')
      fs.chmodSync(hookPath, 0o755)

      const result = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(result.merged)
      const content = fs.readFileSync(hookPath, 'utf8')
      // prove_it section should be at the end, after run-lint
      const lintPos = content.indexOf('run-lint')
      const proveItPos = content.indexOf(PROVE_IT_SHIM_MARKER)
      assert.ok(proveItPos > lintPos,
        'prove_it section should be appended after existing content')
    })
  })

  describe('removeGitHookShim', () => {
    it('removes shim file entirely', () => {
      installGitHookShim(tmpDir, 'pre-commit', true)
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      assert.ok(fs.existsSync(hookPath))

      const removed = removeGitHookShim(tmpDir, 'pre-commit')
      assert.ok(removed)
      assert.ok(!fs.existsSync(hookPath))
    })

    it('removes merged section but keeps original content', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')
      fs.chmodSync(hookPath, 0o755)

      installGitHookShim(tmpDir, 'pre-commit', true)
      const removed = removeGitHookShim(tmpDir, 'pre-commit')
      assert.ok(removed)
      assert.ok(fs.existsSync(hookPath))
      const content = fs.readFileSync(hookPath, 'utf8')
      assert.ok(content.includes('run-lint'))
      assert.ok(!content.includes('prove_it'))
      assert.ok(!content.includes(PROVE_IT_SHIM_MARKER))
    })

    it('returns false when no hook exists', () => {
      const removed = removeGitHookShim(tmpDir, 'pre-commit')
      assert.ok(!removed)
    })

    it('returns false for non-prove_it hook', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nrun-lint\n')

      const removed = removeGitHookShim(tmpDir, 'pre-commit')
      assert.ok(!removed)
    })
  })

  describe('isProveItShim / hasProveItSection', () => {
    it('isProveItShim detects shim files', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nprove_it hook git:pre-commit\n')
      assert.ok(isProveItShim(hookPath))
    })

    it('isProveItShim returns false for non-shim', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nnpm test\n')
      assert.ok(!isProveItShim(hookPath))
    })

    it('hasProveItSection detects merged section', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      fs.writeFileSync(hookPath,
        `#!/usr/bin/env bash\nrun-lint\n\n${PROVE_IT_SHIM_MARKER}\nprove_it hook git:pre-commit\n${PROVE_IT_SHIM_MARKER}\n`)
      assert.ok(hasProveItSection(hookPath))
    })
  })

  describe('initProject', () => {
    it('creates team config, local config, script/test, and script/test_fast', () => {
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.teamConfig.created)
      assert.ok(results.localConfig.created)
      assert.ok(results.scriptTest.created)
      assert.ok(results.scriptTestFast.created)
      assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json')))
      assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it', 'config.local.json')))
      assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test')))
      assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test_fast')))
    })

    it('newly created config includes initSeed', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), 'utf8'))
      assert.ok(cfg.initSeed, 'should have initSeed')
      assert.strictEqual(cfg.initSeed.length, 12)
      assert.strictEqual(cfg.initSeed, configHash(cfg))
    })

    it('config written to disk passes validation', () => {
      const { validateConfig } = require('../../lib/validate')
      initProject(tmpDir, { gitHooks: true, defaultChecks: true })
      const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), 'utf8'))
      const { errors } = validateConfig(cfg)
      assert.deepStrictEqual(errors, [], `Config on disk should be valid, got errors: ${errors.join('; ')}`)
    })

    it('does not overwrite existing team config', () => {
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, '{"custom": true}')

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.teamConfig.existed)
      assert.ok(!results.teamConfig.created)
      assert.ok(results.teamConfig.edited)

      const content = fs.readFileSync(cfgPath, 'utf8')
      assert.strictEqual(content, '{"custom": true}')
    })

    it('creates executable script/test stub', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const stat = fs.statSync(path.join(tmpDir, 'script', 'test'))
      assert.ok(stat.mode & fs.constants.S_IXUSR, 'script/test should be executable')
    })

    it('marks stub as needing customization', () => {
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.scriptTest.isStub)
    })

    it('reports existing customized script', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nnpm test\n')
      fs.chmodSync(scriptPath, 0o755)

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.scriptTest.existed)
      assert.ok(!results.scriptTest.isStub)
    })

    it('creates executable script/test_fast stub', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const stat = fs.statSync(path.join(tmpDir, 'script', 'test_fast'))
      assert.ok(stat.mode & fs.constants.S_IXUSR, 'script/test_fast should be executable')
    })

    it('isScriptTestStub returns true for test_fast stub content', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(isScriptTestStub(path.join(tmpDir, 'script', 'test_fast')))
    })

    it('preserves existing customized script/test_fast', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test_fast')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nnpm run test:unit\n')
      fs.chmodSync(scriptPath, 0o755)

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.scriptTestFast.existed)
      assert.ok(!results.scriptTestFast.isStub)

      const content = fs.readFileSync(scriptPath, 'utf8')
      assert.ok(content.includes('npm run test:unit'), 'custom content should be preserved')
    })

    it('creates .claude/rules/testing.md when defaultChecks is true', () => {
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(results.ruleFile.created)
      assert.ok(!results.ruleFile.existed)
      const rulePath = path.join(tmpDir, '.claude', 'rules', 'testing.md')
      assert.ok(fs.existsSync(rulePath))
      const content = fs.readFileSync(rulePath, 'utf8')
      assert.ok(content.includes('Testing Rules'))
      assert.ok(content.includes('TODO'))
    })

    it('does not create rule file when defaultChecks is false', () => {
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(!results.ruleFile.created)
      assert.ok(!results.ruleFile.existed)
      const rulePath = path.join(tmpDir, '.claude', 'rules', 'testing.md')
      assert.ok(!fs.existsSync(rulePath))
    })

    it('preserves existing rule file', () => {
      const ruleDir = path.join(tmpDir, '.claude', 'rules')
      fs.mkdirSync(ruleDir, { recursive: true })
      fs.writeFileSync(path.join(ruleDir, 'testing.md'), 'Custom rules\n')

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(!results.ruleFile.created)
      assert.ok(results.ruleFile.existed)
      const content = fs.readFileSync(path.join(ruleDir, 'testing.md'), 'utf8')
      assert.strictEqual(content, 'Custom rules\n')
    })

    it('installs git hook shims when gitHooks is true', () => {
      const results = initProject(tmpDir, { gitHooks: true, defaultChecks: false })
      assert.ok(results.gitHookFiles.preCommit.installed)
      assert.ok(results.gitHookFiles.prePush.installed)
      assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit')))
      assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-push')))
    })

    it('does not install git hook shims when gitHooks is false', () => {
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.deepStrictEqual(results.gitHookFiles, {})
    })

    it('sets upToDate when config matches current defaults', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.teamConfig.existed)
      assert.ok(results.teamConfig.upToDate)
      assert.ok(!results.teamConfig.upgraded)
      assert.ok(!results.teamConfig.edited)
    })

    it('sets upgraded when config is unedited but outdated', () => {
      // Init with one set of flags
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      // Re-init with different flags — simulates a new version's defaults
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      assert.ok(results.teamConfig.existed)
      assert.ok(results.teamConfig.upgraded)
      assert.ok(!results.teamConfig.upToDate)
      assert.ok(!results.teamConfig.edited)
    })

    it('auto-upgraded config updates initSeed', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      initProject(tmpDir, { gitHooks: false, defaultChecks: true })
      const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), 'utf8'))
      assert.ok(cfg.initSeed)
      assert.strictEqual(cfg.initSeed, configHash(cfg))
    })

    it('sets edited when config was modified by user', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      // Simulate user editing the config
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      cfg.sources = ['src/**/*.js']
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.teamConfig.existed)
      assert.ok(results.teamConfig.edited)
      assert.ok(!results.teamConfig.upgraded)
      assert.ok(!results.teamConfig.upToDate)
    })

    it('sets edited for legacy configs with no initSeed', () => {
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, JSON.stringify({ hooks: [] }, null, 2) + '\n')

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.teamConfig.existed)
      assert.ok(results.teamConfig.edited)
    })

    it('treats corrupted JSON config as edited and preserves it', () => {
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, '{"truncated":')

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.teamConfig.existed)
      assert.ok(results.teamConfig.edited)
      // File should be untouched
      assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), '{"truncated":')
    })

    it('creates .claude/prove_it/.gitignore ignoring sessions/ and config.local.json', () => {
      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.proveItGitignore.created)
      const gitignorePath = path.join(tmpDir, '.claude', 'prove_it', '.gitignore')
      assert.ok(fs.existsSync(gitignorePath))
      const content = fs.readFileSync(gitignorePath, 'utf8')
      assert.ok(content.includes('sessions/'),
        `Should ignore sessions/, got: ${content}`)
      assert.ok(content.includes('config.local.json'),
        `Should ignore config.local.json, got: ${content}`)
    })

    it('does not overwrite existing .claude/prove_it/.gitignore but appends config.local.json', () => {
      const gitignoreDir = path.join(tmpDir, '.claude', 'prove_it')
      fs.mkdirSync(gitignoreDir, { recursive: true })
      fs.writeFileSync(path.join(gitignoreDir, '.gitignore'), 'custom-stuff/\n')

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(!results.proveItGitignore.created)
      const content = fs.readFileSync(path.join(gitignoreDir, '.gitignore'), 'utf8')
      assert.ok(content.includes('custom-stuff/'),
        'Should preserve existing content')
      assert.ok(content.includes('config.local.json'),
        'Should append config.local.json')
    })

    it('does not duplicate config.local.json in existing .gitignore', () => {
      const gitignoreDir = path.join(tmpDir, '.claude', 'prove_it')
      fs.mkdirSync(gitignoreDir, { recursive: true })
      fs.writeFileSync(path.join(gitignoreDir, '.gitignore'), 'sessions/\nconfig.local.json\n')

      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      const content = fs.readFileSync(path.join(gitignoreDir, '.gitignore'), 'utf8')
      assert.strictEqual(content, 'sessions/\nconfig.local.json\n',
        'Should not duplicate config.local.json')
    })
  })

  describe('overwriteTeamConfig', () => {
    it('writes fresh config with initSeed', () => {
      initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      // Simulate user edit
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.json')
      fs.writeFileSync(cfgPath, JSON.stringify({ custom: true }, null, 2) + '\n')

      overwriteTeamConfig(tmpDir, { gitHooks: false, defaultChecks: false })
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      assert.ok(cfg.initSeed)
      assert.ok(cfg.enabled)
      assert.ok(!cfg.custom)
    })

    it('generates matching initSeed', () => {
      overwriteTeamConfig(tmpDir, { gitHooks: false, defaultChecks: false })
      const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'prove_it', 'config.json'), 'utf8'))
      assert.strictEqual(cfg.initSeed, configHash(cfg))
    })
  })
})
