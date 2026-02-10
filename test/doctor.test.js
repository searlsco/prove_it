const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const CLI_PATH = path.join(__dirname, '..', 'cli.js')

function runDoctor (options = {}) {
  const result = spawnSync('node', [CLI_PATH, 'doctor'], {
    encoding: 'utf8',
    ...options
  })
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status
  }
}

function makeSettings (hooks) {
  return { hooks }
}

function writeSettings (homeDir, settings) {
  const claudeDir = path.join(homeDir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(settings)
  )
}

function initGitRepo (dir) {
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' })
}

function writeTeamConfig (repoDir, cfg) {
  const claudeDir = path.join(repoDir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(
    path.join(claudeDir, 'prove_it.json'),
    JSON.stringify(cfg)
  )
}

// Standard 3-dispatcher settings matching what `prove_it install` creates
function correctSettings () {
  return makeSettings({
    SessionStart: [{
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
    }],
    PreToolUse: [{
      matcher: 'Edit|Write|NotebookEdit|Bash',
      hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }]
    }],
    Stop: [{
      hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
    }]
  })
}

describe('doctor', () => {
  let tmpHome
  let tmpRepo

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_doctor_home_'))
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_doctor_repo_'))
    initGitRepo(tmpRepo)
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpRepo, { recursive: true, force: true })
  })

  function run (extraEnv = {}) {
    return runDoctor({
      cwd: tmpRepo,
      env: { ...process.env, HOME: tmpHome, ...extraEnv }
    })
  }

  describe('header', () => {
    it('prints "prove_it doctor" header', () => {
      writeSettings(tmpHome, correctSettings())
      const result = run()
      assert.match(result.stdout, /^prove_it doctor\n/)
    })
  })

  describe('diagnose alias', () => {
    it('runs doctor when invoked as diagnose', () => {
      writeSettings(tmpHome, correctSettings())
      const result = spawnSync('node', [CLI_PATH, 'diagnose'], {
        encoding: 'utf8',
        cwd: tmpRepo,
        env: { ...process.env, HOME: tmpHome }
      })
      assert.match(result.stdout, /^prove_it doctor\n/)
    })
  })

  describe('per-dispatcher validation', () => {
    it('shows all 3 dispatchers with [x] when correctly installed', () => {
      writeSettings(tmpHome, correctSettings())
      const result = run()
      assert.match(result.stdout, /\[x\] SessionStart dispatcher \(matcher: startup\|resume\|clear\|compact\)/)
      assert.match(result.stdout, /\[x\] PreToolUse dispatcher \(matcher: Edit\|Write\|NotebookEdit\|Bash\)/)
      assert.match(result.stdout, /\[x\] Stop dispatcher/)
    })

    it('shows [ ] for missing dispatcher', () => {
      const settings = makeSettings({
        SessionStart: [{
          matcher: 'startup|resume|clear|compact',
          hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
        }]
      })
      writeSettings(tmpHome, settings)
      const result = run()
      assert.match(result.stdout, /\[x\] SessionStart dispatcher/)
      assert.match(result.stdout, /\[ \] PreToolUse dispatcher/)
      assert.match(result.stdout, /\[ \] Stop dispatcher/)
      assert.match(result.stdout, /PreToolUse dispatcher not registered/)
      assert.match(result.stdout, /Stop dispatcher not registered/)
    })

    it('shows [!] when command points to wrong event', () => {
      const settings = makeSettings({
        SessionStart: [{
          matcher: 'startup|resume|clear|compact',
          hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
        }],
        PreToolUse: [{
          matcher: 'Edit|Write|NotebookEdit|Bash',
          hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
        }],
        Stop: [{
          hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
        }]
      })
      writeSettings(tmpHome, settings)
      const result = run()
      assert.match(result.stdout, /\[!\] PreToolUse dispatcher/)
      assert.match(result.stdout, /command is "prove_it hook claude:Stop", expected "prove_it hook claude:PreToolUse"/)
    })

    it('shows [ ] when group has non-prove_it command', () => {
      const settings = makeSettings({
        SessionStart: [{
          matcher: 'startup|resume|clear|compact',
          hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
        }],
        PreToolUse: [{
          matcher: 'Edit|Write|NotebookEdit|Bash',
          hooks: [{ type: 'command', command: 'some_other_tool' }]
        }],
        Stop: [{
          hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
        }]
      })
      writeSettings(tmpHome, settings)
      const result = run()
      assert.match(result.stdout, /\[ \] PreToolUse dispatcher/)
      assert.match(result.stdout, /PreToolUse dispatcher not registered/)
    })

    it('shows [!] when matcher is wrong', () => {
      const settings = makeSettings({
        SessionStart: [{
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
        }],
        PreToolUse: [{
          matcher: 'Edit|Write|NotebookEdit|Bash',
          hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }]
        }],
        Stop: [{
          hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
        }]
      })
      writeSettings(tmpHome, settings)
      const result = run()
      assert.match(result.stdout, /\[!\] SessionStart dispatcher/)
      assert.match(result.stdout, /matcher is "startup", expected "startup\|resume\|clear\|compact"/)
    })

    it('shows [!] when Stop has unexpected matcher', () => {
      const settings = makeSettings({
        SessionStart: [{
          matcher: 'startup|resume|clear|compact',
          hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
        }],
        PreToolUse: [{
          matcher: 'Edit|Write|NotebookEdit|Bash',
          hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }]
        }],
        Stop: [{
          matcher: 'unexpected',
          hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
        }]
      })
      writeSettings(tmpHome, settings)
      const result = run()
      assert.match(result.stdout, /\[!\] Stop dispatcher/)
      assert.match(result.stdout, /has unexpected matcher "unexpected"/)
    })

    it('reports missing settings.json', () => {
      // Don't write any settings
      const result = run()
      assert.match(result.stdout, /settings\.json missing or has no hooks/)
      assert.match(result.stdout, /prove_it install/)
    })
  })

  describe('team config git tracking', () => {
    it('shows "Tracked by git" when config is committed', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: []
      })
      spawnSync('git', ['add', '.claude/prove_it.json'], { cwd: tmpRepo, stdio: 'ignore' })
      spawnSync('git', ['commit', '-m', 'add config'], { cwd: tmpRepo, stdio: 'ignore' })

      const result = run()
      assert.match(result.stdout, /\[x\] Team config exists/)
      assert.match(result.stdout, /Tracked by git/)
    })

    it('shows issue when config is not tracked by git', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: []
      })

      const result = run()
      assert.match(result.stdout, /\[x\] Team config exists/)
      assert.match(result.stdout, /Not tracked by git/)
      assert.match(result.stdout, /not committed to git/)
    })
  })

  describe('sources placeholder check', () => {
    it('shows issue when sources contain placeholder glob', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.*', 'replace/these/with/globs/of/your/source/and/test/files.*'],
        hooks: []
      })

      const result = run()
      assert.match(result.stdout, /\[ \] Sources need customizing \(placeholder glob found\)/)
      assert.match(result.stdout, /Replace placeholder globs/)
    })

    it('shows [x] Sources configured when sources are customized', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['src/**/*.js', 'test/**/*.js'],
        hooks: []
      })

      const result = run()
      assert.match(result.stdout, /\[x\] Sources configured/)
    })
  })

  describe('git hook shim validation', () => {
    it('shows [x] when git hook shim is installed for config git hooks', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: [
          { type: 'git', event: 'pre-commit', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
        ]
      })

      // Install the shim
      const hooksDir = path.join(tmpRepo, '.git', 'hooks')
      fs.mkdirSync(hooksDir, { recursive: true })
      fs.writeFileSync(
        path.join(hooksDir, 'pre-commit'),
        '#!/usr/bin/env bash\nprove_it hook git:pre-commit\n'
      )

      const result = run()
      assert.match(result.stdout, /\[x\] Git hook shim installed: \.git\/hooks\/pre-commit/)
    })

    it('shows [ ] when git hook shim is missing', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: [
          { type: 'git', event: 'pre-commit', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
        ]
      })

      const result = run()
      assert.match(result.stdout, /\[ \] Git hook shim missing: \.git\/hooks\/pre-commit/)
      assert.match(result.stdout, /Git hook shim missing for pre-commit/)
    })

    it('shows [ ] when git hook exists but has no prove_it shim', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: [
          { type: 'git', event: 'pre-push', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
        ]
      })

      // Write a git hook WITHOUT prove_it
      const hooksDir = path.join(tmpRepo, '.git', 'hooks')
      fs.mkdirSync(hooksDir, { recursive: true })
      fs.writeFileSync(
        path.join(hooksDir, 'pre-push'),
        '#!/usr/bin/env bash\nnpm test\n'
      )

      const result = run()
      assert.match(result.stdout, /\[ \] Git hook exists but missing prove_it shim: \.git\/hooks\/pre-push/)
    })

    it('checks shims for all git hook types in config', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: [
          { type: 'git', event: 'pre-commit', tasks: [{ name: 'lint', type: 'script', command: './lint' }] },
          { type: 'git', event: 'pre-push', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
        ]
      })

      // Install only pre-commit, not pre-push
      const hooksDir = path.join(tmpRepo, '.git', 'hooks')
      fs.mkdirSync(hooksDir, { recursive: true })
      fs.writeFileSync(
        path.join(hooksDir, 'pre-commit'),
        '#!/usr/bin/env bash\nprove_it hook git:pre-commit\n'
      )

      const result = run()
      assert.match(result.stdout, /\[x\] Git hook shim installed: \.git\/hooks\/pre-commit/)
      assert.match(result.stdout, /\[ \] Git hook shim missing: \.git\/hooks\/pre-push/)
    })

    it('shows [!] when shim is after exec in git hook', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: [
          { type: 'git', event: 'pre-commit', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
        ]
      })

      // Write a hook with exec BEFORE prove_it section (unreachable)
      const hooksDir = path.join(tmpRepo, '.git', 'hooks')
      fs.mkdirSync(hooksDir, { recursive: true })
      fs.writeFileSync(
        path.join(hooksDir, 'pre-commit'),
        '#!/usr/bin/env bash\nexec bd hook pre-commit "$@"\n\n# --- prove_it ---\nprove_it hook git:pre-commit\n# --- prove_it ---\n'
      )

      const result = run()
      assert.match(result.stdout, /\[!\] Git hook shim unreachable/)
      assert.match(result.stdout, /has 'exec' before prove_it section/)
      assert.match(result.stdout, /run 'prove_it init' to fix/)
    })

    it('skips git hook checks when config has no git hooks', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: [
          { type: 'claude', event: 'Stop', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
        ]
      })

      const result = run()
      assert.ok(!result.stdout.includes('Git hook shim'))
    })
  })

  describe('config validation warnings', () => {
    it('surfaces validation warnings in config checks', () => {
      writeSettings(tmpHome, correctSettings())
      // matcher on a Stop event triggers a warning
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['**/*.js'],
        hooks: [
          {
            type: 'claude',
            event: 'Stop',
            matcher: 'Bash',
            tasks: [{ name: 'tests', type: 'script', command: './test' }]
          }
        ]
      })

      const result = run()
      assert.match(result.stdout, /\[!\]/)
      assert.match(result.stdout, /matcher.*only applies to PreToolUse/)
    })
  })

  describe('summary', () => {
    it('reports "All checks passed" when everything is correct', () => {
      writeSettings(tmpHome, correctSettings())
      writeTeamConfig(tmpRepo, {
        configVersion: 3,
        enabled: true,
        sources: ['src/**/*.js'],
        hooks: []
      })
      // Commit config so isTrackedByGit passes
      spawnSync('git', ['add', '.claude/prove_it.json'], { cwd: tmpRepo, stdio: 'ignore' })
      spawnSync('git', ['commit', '-m', 'add config'], { cwd: tmpRepo, stdio: 'ignore' })
      // Create test scripts
      fs.mkdirSync(path.join(tmpRepo, 'script'), { recursive: true })
      fs.writeFileSync(path.join(tmpRepo, 'script', 'test'), '#!/bin/bash\nexit 0\n')
      // Create .gitignore with local config
      fs.writeFileSync(path.join(tmpRepo, '.gitignore'), 'prove_it.local.json\n')
      // Install /prove skill
      const skillDir = path.join(tmpHome, '.claude', 'skills', 'prove')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.copyFileSync(
        path.join(__dirname, '..', 'lib', 'skills', 'prove.md'),
        path.join(skillDir, 'SKILL.md')
      )

      const result = run()
      assert.match(result.stdout, /All checks passed/)
    })

    it('lists issues when problems are found', () => {
      // No settings, no config — should have multiple issues
      const result = run()
      assert.match(result.stdout, /Issues found:/)
    })
  })
})
