const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const {
  isScriptTestStub,
  buildConfig,
  addToGitignore,
  initProject,
  installGitHookShim,
  removeGitHookShim,
  isProveItShim,
  hasProveItSection,
  hasExecLine,
  isProveItAfterExec,
  PROVE_IT_SHIM_MARKER
} = require('../lib/init')

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
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\n# prove_it: Replace this\nexit 1\n')
      assert.ok(isScriptTestStub(scriptPath))
    })

    it('returns false for customized script', () => {
      const scriptPath = path.join(tmpDir, 'script', 'test')
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nnpm test\n')
      assert.ok(!isScriptTestStub(scriptPath))
    })

    it('returns false for nonexistent file', () => {
      assert.ok(!isScriptTestStub(path.join(tmpDir, 'nonexistent')))
    })
  })

  describe('buildConfig', () => {
    it('returns full config with defaults (all features)', () => {
      const cfg = buildConfig()
      assert.strictEqual(cfg.configVersion, 3)
      assert.ok(Array.isArray(cfg.hooks))
      // Should have git hooks
      assert.ok(cfg.hooks.some(h => h.type === 'git' && h.event === 'pre-commit'))
      assert.ok(!cfg.hooks.some(h => h.type === 'git' && h.event === 'pre-push'))
      // Should have default checks
      const allChecks = cfg.hooks.flatMap(h => h.tasks || [])
      assert.ok(allChecks.some(c => c.name === 'require-wip'))
      assert.ok(allChecks.some(c => c.name === 'commit-review'))
      assert.ok(allChecks.some(c => c.name === 'coverage-review'))
    })

    it('omits git hooks when gitHooks is false', () => {
      const cfg = buildConfig({ gitHooks: false })
      assert.strictEqual(cfg.configVersion, 3)
      assert.ok(!cfg.hooks.some(h => h.type === 'git'))
    })

    it('omits default checks when defaultChecks is false', () => {
      const cfg = buildConfig({ defaultChecks: false })
      assert.strictEqual(cfg.configVersion, 3)
      const allChecks = cfg.hooks.flatMap(h => h.tasks || [])
      assert.ok(!allChecks.some(c => c.name === 'require-wip'))
      assert.ok(!allChecks.some(c => c.name === 'commit-review'))
      assert.ok(!allChecks.some(c => c.name === 'coverage-review'))
    })

    it('returns base-only config with both features off', () => {
      const cfg = buildConfig({ gitHooks: false, defaultChecks: false })
      assert.strictEqual(cfg.configVersion, 3)
      assert.ok(!cfg.hooks.some(h => h.type === 'git'))
      const allChecks = cfg.hooks.flatMap(h => h.tasks || [])
      assert.ok(!allChecks.some(c => c.name === 'require-wip'))
      assert.ok(!allChecks.some(c => c.name === 'commit-review'))
      // Should still have base checks
      assert.ok(allChecks.some(c => c.name === 'lock-config'))
      assert.ok(allChecks.some(c => c.name === 'fast-tests'))
    })

    it('full config has at least as many hooks as base-only', () => {
      const full = buildConfig()
      const base = buildConfig({ gitHooks: false, defaultChecks: false })
      assert.ok(full.hooks.length >= base.hooks.length,
        'Full config should have at least as many hooks as base')
    })

    it('commit-review uses type agent with promptType reference', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      const commitReview = allTasks.find(t => t.name === 'commit-review')
      assert.ok(commitReview, 'Should have commit-review task')
      assert.strictEqual(commitReview.type, 'agent')
      assert.strictEqual(commitReview.promptType, 'reference')
      assert.strictEqual(commitReview.prompt, 'review:commit_quality')
      assert.deepStrictEqual(commitReview.when.variablesPresent, ['staged_diff'])
    })

    it('coverage-review uses type agent with promptType reference', () => {
      const cfg = buildConfig()
      const allTasks = cfg.hooks.flatMap(h => h.tasks || [])
      const coverageReview = allTasks.find(t => t.name === 'coverage-review')
      assert.ok(coverageReview, 'Should have coverage-review task')
      assert.strictEqual(coverageReview.type, 'agent')
      assert.strictEqual(coverageReview.promptType, 'reference')
      assert.strictEqual(coverageReview.prompt, 'review:test_coverage')
      assert.deepStrictEqual(coverageReview.when.variablesPresent, ['session_diff'])
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
      fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nexec bd hook pre-commit "$@"\n')
      fs.chmodSync(hookPath, 0o755)

      const result = installGitHookShim(tmpDir, 'pre-commit', true)
      assert.ok(result.existed)
      assert.ok(result.merged)
      const content = fs.readFileSync(hookPath, 'utf8')
      const proveItPos = content.indexOf(PROVE_IT_SHIM_MARKER)
      const execPos = content.indexOf('exec bd hook')
      assert.ok(proveItPos < execPos,
        `prove_it section (pos ${proveItPos}) should be before exec (pos ${execPos})`)
      assert.ok(content.includes('prove_it hook git:pre-commit'))
      assert.ok(content.includes('exec bd hook'))
    })

    it('repositions existing section from after exec to before exec', () => {
      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
      fs.mkdirSync(path.dirname(hookPath), { recursive: true })
      // Simulate a stale merge: prove_it section AFTER exec
      const staleContent = [
        '#!/usr/bin/env bash',
        'exec bd hook pre-commit "$@"',
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
      const execPos = content.indexOf('exec bd hook')
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

  describe('hasExecLine', () => {
    it('returns true for line starting with exec', () => {
      assert.ok(hasExecLine('#!/usr/bin/env bash\nexec bd hook pre-commit "$@"\n'))
    })

    it('returns false for exec in a comment', () => {
      assert.ok(!hasExecLine('#!/usr/bin/env bash\n# exec bd hook pre-commit\nrun-lint\n'))
    })

    it('returns false when no exec present', () => {
      assert.ok(!hasExecLine('#!/usr/bin/env bash\nrun-lint\nnpm test\n'))
    })

    it('returns true for indented exec', () => {
      assert.ok(hasExecLine('#!/usr/bin/env bash\n  exec bd hook pre-commit "$@"\n'))
    })
  })

  describe('isProveItAfterExec', () => {
    it('returns true when prove_it section is after exec', () => {
      const content = [
        '#!/usr/bin/env bash',
        'exec bd hook pre-commit "$@"',
        '',
        PROVE_IT_SHIM_MARKER,
        'prove_it hook git:pre-commit',
        PROVE_IT_SHIM_MARKER
      ].join('\n')
      assert.ok(isProveItAfterExec(content))
    })

    it('returns false when prove_it section is before exec', () => {
      const content = [
        '#!/usr/bin/env bash',
        PROVE_IT_SHIM_MARKER,
        'prove_it hook git:pre-commit',
        PROVE_IT_SHIM_MARKER,
        '',
        'exec bd hook pre-commit "$@"'
      ].join('\n')
      assert.ok(!isProveItAfterExec(content))
    })

    it('returns false when no exec present', () => {
      const content = [
        '#!/usr/bin/env bash',
        'run-lint',
        PROVE_IT_SHIM_MARKER,
        'prove_it hook git:pre-commit',
        PROVE_IT_SHIM_MARKER
      ].join('\n')
      assert.ok(!isProveItAfterExec(content))
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
      assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.json')))
      assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'prove_it.local.json')))
      assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test')))
      assert.ok(fs.existsSync(path.join(tmpDir, 'script', 'test_fast')))
    })

    it('does not overwrite existing team config', () => {
      const cfgPath = path.join(tmpDir, '.claude', 'prove_it.json')
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, '{"custom": true}')

      const results = initProject(tmpDir, { gitHooks: false, defaultChecks: false })
      assert.ok(results.teamConfig.existed)
      assert.ok(!results.teamConfig.created)

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
  })
})
