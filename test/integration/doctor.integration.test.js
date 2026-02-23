const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const CLI_PATH = path.join(__dirname, '..', '..', 'cli.js')

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
  const proveItDir = path.join(claudeDir, 'prove_it')
  fs.mkdirSync(proveItDir, { recursive: true })
  fs.writeFileSync(
    path.join(proveItDir, 'config.json'),
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
      matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*|EnterPlanMode|ExitPlanMode',
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

  it('header and diagnose alias', () => {
    writeSettings(tmpHome, correctSettings())

    // doctor command prints header
    const doctorResult = run()
    assert.match(doctorResult.stdout, /^prove_it doctor\n/)

    // diagnose alias also prints the same header
    const diagnoseResult = spawnSync('node', [CLI_PATH, 'diagnose'], {
      encoding: 'utf8',
      cwd: tmpRepo,
      env: { ...process.env, HOME: tmpHome }
    })
    assert.match(diagnoseResult.stdout, /^prove_it doctor\n/)
  })

  it('dispatcher validation', () => {
    // All 3 dispatchers correctly installed -> [x]
    writeSettings(tmpHome, correctSettings())
    let result = run()
    assert.match(result.stdout, /\[x\] SessionStart dispatcher \(matcher: startup\|resume\|clear\|compact\)/)
    assert.match(result.stdout, /\[x\] PreToolUse dispatcher \(matcher: Write\|Edit\|MultiEdit\|NotebookEdit\|Bash\|mcp__\.\*\|EnterPlanMode\|ExitPlanMode\)/)
    assert.match(result.stdout, /\[x\] Stop dispatcher/)

    // Missing dispatchers -> [ ]
    writeSettings(tmpHome, makeSettings({
      SessionStart: [{
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
      }]
    }))
    result = run()
    assert.match(result.stdout, /\[x\] SessionStart dispatcher/)
    assert.match(result.stdout, /\[ \] PreToolUse dispatcher/)
    assert.match(result.stdout, /\[ \] Stop dispatcher/)
    assert.match(result.stdout, /PreToolUse dispatcher not registered/)
    assert.match(result.stdout, /Stop dispatcher not registered/)

    // Wrong command -> [!]
    writeSettings(tmpHome, makeSettings({
      SessionStart: [{
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
      }],
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
        hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
      }],
      Stop: [{
        hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
      }]
    }))
    result = run()
    assert.match(result.stdout, /\[!\] PreToolUse dispatcher/)
    assert.match(result.stdout, /command is "prove_it hook claude:Stop", expected "prove_it hook claude:PreToolUse"/)

    // Non-prove_it command -> [ ]
    writeSettings(tmpHome, makeSettings({
      SessionStart: [{
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
      }],
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
        hooks: [{ type: 'command', command: 'some_other_tool' }]
      }],
      Stop: [{
        hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
      }]
    }))
    result = run()
    assert.match(result.stdout, /\[ \] PreToolUse dispatcher/)
    assert.match(result.stdout, /PreToolUse dispatcher not registered/)
  })

  it('matcher validation', () => {
    // Wrong matcher for SessionStart -> [!]
    writeSettings(tmpHome, makeSettings({
      SessionStart: [{
        matcher: 'startup',
        hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
      }],
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
        hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }]
      }],
      Stop: [{
        hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
      }]
    }))
    let result = run()
    assert.match(result.stdout, /\[!\] SessionStart dispatcher/)
    assert.match(result.stdout, /matcher is "startup", expected "startup\|resume\|clear\|compact"/)

    // Unexpected matcher for Stop -> [!]
    writeSettings(tmpHome, makeSettings({
      SessionStart: [{
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
      }],
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
        hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }]
      }],
      Stop: [{
        matcher: 'unexpected',
        hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
      }]
    }))
    result = run()
    assert.match(result.stdout, /\[!\] Stop dispatcher/)
    assert.match(result.stdout, /has unexpected matcher "unexpected"/)

    // Missing settings.json entirely
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true })
    result = run()
    assert.match(result.stdout, /settings\.json missing or has no hooks/)
    assert.match(result.stdout, /prove_it install/)
  })

  it('team config git tracking', () => {
    writeSettings(tmpHome, correctSettings())

    // Config committed to git -> tracked
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['**/*.js'],
      hooks: []
    })
    spawnSync('git', ['add', '.claude/prove_it/config.json'], { cwd: tmpRepo, stdio: 'ignore' })
    spawnSync('git', ['commit', '-m', 'add config'], { cwd: tmpRepo, stdio: 'ignore' })

    let result = run()
    assert.match(result.stdout, /\[x\] Team config exists/)
    assert.match(result.stdout, /Tracked by git/)

    // Remove from git tracking (new repo, config not committed)
    fs.rmSync(tmpRepo, { recursive: true, force: true })
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_doctor_repo_'))
    initGitRepo(tmpRepo)
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['**/*.js'],
      hooks: []
    })

    result = run()
    assert.match(result.stdout, /\[x\] Team config exists/)
    assert.match(result.stdout, /Not tracked by git/)
    assert.match(result.stdout, /not committed to git/)
  })

  it('sources placeholder check', () => {
    writeSettings(tmpHome, correctSettings())

    // Placeholder glob found -> needs customizing
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['**/*.*', 'replace/these/with/globs/of/your/source/and/test/files.*'],
      hooks: []
    })

    let result = run()
    assert.match(result.stdout, /\[ \] Sources need customizing \(placeholder glob found\)/)
    assert.match(result.stdout, /Replace placeholder globs/)

    // Customized sources -> OK
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['src/**/*.js', 'test/**/*.js'],
      hooks: []
    })

    result = run()
    assert.match(result.stdout, /\[x\] Sources configured/)
  })

  it('git hook shim states', () => {
    writeSettings(tmpHome, correctSettings())
    const hooksDir = path.join(tmpRepo, '.git', 'hooks')
    fs.mkdirSync(hooksDir, { recursive: true })

    // Installed shim -> [x]
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['**/*.js'],
      hooks: [
        { type: 'git', event: 'pre-commit', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
      ]
    })
    fs.writeFileSync(
      path.join(hooksDir, 'pre-commit'),
      '#!/usr/bin/env bash\nprove_it hook git:pre-commit\n'
    )

    let result = run()
    assert.match(result.stdout, /\[x\] Git hook shim installed: \.git\/hooks\/pre-commit/)

    // Missing shim -> [ ]
    fs.rmSync(path.join(hooksDir, 'pre-commit'), { force: true })

    result = run()
    assert.match(result.stdout, /\[ \] Git hook shim missing: \.git\/hooks\/pre-commit/)
    assert.match(result.stdout, /Git hook shim missing for pre-commit/)

    // Hook exists but has no prove_it shim -> [ ]
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['**/*.js'],
      hooks: [
        { type: 'git', event: 'pre-push', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
      ]
    })
    fs.writeFileSync(
      path.join(hooksDir, 'pre-push'),
      '#!/usr/bin/env bash\nnpm test\n'
    )

    result = run()
    assert.match(result.stdout, /\[ \] Git hook exists but missing prove_it shim: \.git\/hooks\/pre-push/)

    // Multiple hook types: pre-commit installed, pre-push missing
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['**/*.js'],
      hooks: [
        { type: 'git', event: 'pre-commit', tasks: [{ name: 'lint', type: 'script', command: './lint' }] },
        { type: 'git', event: 'pre-push', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
      ]
    })
    fs.rmSync(path.join(hooksDir, 'pre-push'), { force: true })
    fs.writeFileSync(
      path.join(hooksDir, 'pre-commit'),
      '#!/usr/bin/env bash\nprove_it hook git:pre-commit\n'
    )

    result = run()
    assert.match(result.stdout, /\[x\] Git hook shim installed: \.git\/hooks\/pre-commit/)
    assert.match(result.stdout, /\[ \] Git hook shim missing: \.git\/hooks\/pre-push/)
  })

  it('git hook shim edge cases', () => {
    writeSettings(tmpHome, correctSettings())
    const hooksDir = path.join(tmpRepo, '.git', 'hooks')
    fs.mkdirSync(hooksDir, { recursive: true })

    // Shim after exec -> [!] unreachable
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['**/*.js'],
      hooks: [
        { type: 'git', event: 'pre-commit', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
      ]
    })
    fs.writeFileSync(
      path.join(hooksDir, 'pre-commit'),
      '#!/usr/bin/env bash\nexec other-tool hook pre-commit "$@"\n\n# --- prove_it ---\nprove_it hook git:pre-commit\n# --- prove_it ---\n'
    )

    let result = run()
    assert.match(result.stdout, /\[!\] Git hook shim unreachable/)
    assert.match(result.stdout, /has 'exec' before prove_it section/)
    assert.match(result.stdout, /run 'prove_it init' to fix/)

    // No git hooks in config -> skips git hook checks entirely
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['**/*.js'],
      hooks: [
        { type: 'claude', event: 'Stop', tasks: [{ name: 'tests', type: 'script', command: './test' }] }
      ]
    })

    result = run()
    assert.ok(!result.stdout.includes('Git hook shim'))
  })

  it('config validation warnings', () => {
    writeSettings(tmpHome, correctSettings())
    // matcher on a Stop event triggers a warning
    writeTeamConfig(tmpRepo, {
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

  it('summary', () => {
    // All checks passed
    writeSettings(tmpHome, correctSettings())
    writeTeamConfig(tmpRepo, {
      enabled: true,
      sources: ['src/**/*.js'],
      hooks: []
    })
    spawnSync('git', ['add', '.claude/prove_it/config.json'], { cwd: tmpRepo, stdio: 'ignore' })
    spawnSync('git', ['commit', '-m', 'add config'], { cwd: tmpRepo, stdio: 'ignore' })
    fs.mkdirSync(path.join(tmpRepo, 'script'), { recursive: true })
    fs.writeFileSync(path.join(tmpRepo, 'script', 'test'), '#!/bin/bash\nexit 0\n')
    const proveItGitignore = path.join(tmpRepo, '.claude', 'prove_it', '.gitignore')
    fs.mkdirSync(path.dirname(proveItGitignore), { recursive: true })
    fs.writeFileSync(proveItGitignore, 'sessions/\nconfig.local.json\n')
    for (const name of ['prove', 'prove-coverage', 'prove-shipworthy']) {
      const skillDir = path.join(tmpHome, '.claude', 'skills', name)
      fs.mkdirSync(skillDir, { recursive: true })
      fs.copyFileSync(
        path.join(__dirname, '..', '..', 'lib', 'skills', `${name}.md`),
        path.join(skillDir, 'SKILL.md')
      )
    }

    let result = run()
    assert.match(result.stdout, /All checks passed/)

    // Issues found (reset to bare state)
    fs.rmSync(tmpRepo, { recursive: true, force: true })
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_doctor_repo_'))
    initGitRepo(tmpRepo)
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true })

    result = run()
    assert.match(result.stdout, /Issues found:/)
  })
})
