const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { invokeHook, isolatedEnv, initGitRepo } = require('./integration/hook-harness')
const { PROFILE_VERSION } = require('../lib/redesign/config')
const { disableSessionControl, enableSessionControl, getSignal, setSignal } = require('../lib/session')

function tmpRepo () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_claude_clean_route_'))
}

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function writeStrictConfig (repo, adapterEnabled = true, overrides = {}) {
  writeJson(path.join(repo, '.prove_it', 'config.json'), {
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    adapters: { claude: { enabled: adapterEnabled } },
    ...overrides
  })
}

function writeLegacyDenyConfig (repo) {
  writeJson(path.join(repo, '.claude', 'prove_it', 'config.json'), {
    enabled: true,
    hooks: {
      claude: {
        PreToolUse: [{
          name: 'legacy-deny',
          type: 'script',
          matcher: 'Write',
          command: 'echo legacy runtime executed && exit 1'
        }]
      }
    }
  })
}

function invokeClaudePreTool (repo, toolInput, extraEnv = {}, toolName = 'Write') {
  return invokeHook('claude:PreToolUse', {
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    tool_name: toolName,
    tool_input: toolInput,
    cwd: repo
  }, {
    cwd: repo,
    projectDir: repo,
    env: { ...isolatedEnv(path.join(repo, '.home')), ...extraEnv }
  })
}

function invokeClaudeSessionStart (repo, input = {}, extraEnv = {}) {
  return invokeHook('claude:SessionStart', {
    hook_event_name: 'SessionStart',
    session_id: input.session_id || 'session-1',
    source: input.source || 'startup',
    cwd: repo,
    ...input
  }, {
    cwd: repo,
    projectDir: repo,
    env: { ...isolatedEnv(path.join(repo, '.home')), ...extraEnv }
  })
}

function invokeClaudeStop (repo, input = {}, extraEnv = {}) {
  return invokeHook('claude:Stop', {
    hook_event_name: 'Stop',
    session_id: input.session_id || 'session-1',
    cwd: repo,
    ...input
  }, {
    cwd: repo,
    projectDir: repo,
    env: { ...isolatedEnv(path.join(repo, '.home')), ...extraEnv }
  })
}

function invokeClaudePostTool (repo, input = {}, extraEnv = {}) {
  return invokeHook('claude:PostToolUse', {
    hook_event_name: 'PostToolUse',
    session_id: input.session_id || 'session-1',
    cwd: repo,
    ...input
  }, {
    cwd: repo,
    projectDir: repo,
    env: { ...isolatedEnv(path.join(repo, '.home')), ...extraEnv }
  })
}

function runCancelCommand (sessionId, env) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'cancel'], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PROVE_IT_SESSION_ID: sessionId },
    timeout: 5000
  })
}

function withProveItDir (proveItDir, fn) {
  const previous = process.env.PROVE_IT_DIR
  process.env.PROVE_IT_DIR = proveItDir
  try { return fn() } finally {
    if (previous === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = previous
  }
}

function markCleanSessionDisabled (sessionId, env) {
  withProveItDir(env.PROVE_IT_DIR, () => disableSessionControl(sessionId))
}

function markCleanSessionEnabled (sessionId, env) {
  withProveItDir(env.PROVE_IT_DIR, () => enableSessionControl(sessionId))
}

describe('Claude clean-runtime hook route', () => {
  it('disabled clean SessionStart emits a re-enable reminder and still exports the session id', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)
    const sessionId = 'clean-disabled-sessionstart'
    const env = isolatedEnv(path.join(repo, '.home'))
    const envFile = path.join(repo, '.claude-env')
    markCleanSessionDisabled(sessionId, env)

    const result = invokeClaudeSessionStart(repo, { session_id: sessionId, source: 'resume' }, {
      ...env,
      CLAUDE_ENV_FILE: envFile
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stderr, '')
    assert.ok(result.output, 'disabled SessionStart should emit Claude JSON')
    assert.match(result.output.systemMessage, /disabled/i)
    assert.match(result.output.systemMessage, /prove_it enable/)
    assert.strictEqual(result.output.hookSpecificOutput, undefined)
    assert.strictEqual(fs.readFileSync(envFile, 'utf8'), `export PROVE_IT_SESSION_ID="${sessionId}"\n`)
    assert.doesNotMatch(result.stdout, /prove_it methodology:/)
  })

  it('disabled clean PreToolUse silently no-ops without running clean workflows', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)
    const env = isolatedEnv(path.join(repo, '.home'))
    markCleanSessionDisabled('session-1', env)

    const result = invokeClaudePreTool(repo, { file_path: '.prove_it/config.json', content: '{}' }, env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output, null)
  })

  it('cancel with no active clean work does not bypass the next PreToolUse enforcement', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)
    const env = isolatedEnv(path.join(repo, '.home'))

    const cancel = runCancelCommand('session-1', env)
    const result = invokeClaudePreTool(repo, { file_path: '.prove_it/config.json', content: '{}' }, env)

    assert.strictEqual(cancel.status, 0, `cancel should be idempotent when no work is active, stderr: ${cancel.stderr}`)
    assert.match(cancel.stderr, /no running dispatcher/)
    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /protected prove_it config path/)
  })

  it('clean hooks resume normal workflow enforcement after enable clears disabled state', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)
    const env = isolatedEnv(path.join(repo, '.home'))
    markCleanSessionDisabled('session-1', env)
    markCleanSessionEnabled('session-1', env)

    const result = invokeClaudePreTool(repo, { file_path: '.prove_it/config.json', content: '{}' }, env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /protected prove_it config path/)
  })

  it('disabled clean Stop silently no-ops without running completion workflows', () => {
    const repo = tmpRepo()
    const marker = path.join(repo, 'completion-ran')
    writeStrictConfig(repo, true, {
      tasks: {
        completion_check: {
          type: 'script',
          command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')" && exit 1`
        }
      },
      agent_workflows: { agent_end: ['completion_check'] }
    })
    const env = isolatedEnv(path.join(repo, '.home'))
    markCleanSessionDisabled('session-1', env)

    const result = invokeClaudeStop(repo, { session_id: 'session-1' }, env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output, null)
    assert.strictEqual(fs.existsSync(marker), false)
  })

  it('renders SessionStart methodology, exports the session id, records a baseline, and skips legacy workflow config', () => {
    const repo = tmpRepo()
    initGitRepo(repo)
    writeStrictConfig(repo, true)
    fs.mkdirSync(path.join(repo, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.claude', 'prove_it', 'config.json'), '{ invalid legacy json')
    const env = isolatedEnv(path.join(repo, '.home'))
    const envFile = path.join(repo, '.claude-env')

    const result = invokeClaudeSessionStart(repo, { session_id: 'session-1', source: 'startup' }, {
      ...env,
      CLAUDE_ENV_FILE: envFile
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(result.output.hookSpecificOutput.additionalContext, /prove_it methodology:/)
    assert.match(result.output.hookSpecificOutput.additionalContext, /prove_it signal done/)
    assert.match(result.output.hookSpecificOutput.additionalContext, /set env vars: PROVE_IT_SESSION_ID/)
    assert.doesNotMatch(result.stdout, /invalid legacy json/)
    assert.strictEqual(fs.readFileSync(envFile, 'utf8'), 'export PROVE_IT_SESSION_ID="session-1"\n')

    const state = JSON.parse(fs.readFileSync(path.join(env.PROVE_IT_DIR, 'sessions', 'session-1.json'), 'utf8'))
    assert.strictEqual(state.session_id, 'session-1')
    assert.strictEqual(state.project_dir, repo)
    assert.strictEqual(state.git.is_repo, true)
    assert.strictEqual(state.git.root, fs.realpathSync(repo))
    assert.ok(state.started_at)
  })

  it('escapes SessionStart env-file values as Claude-owned shell exports', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)
    const envFile = path.join(repo, '.claude-env')
    const sessionId = 'session "quoted" \\ slash $HOME `cmd`\nline'

    const result = invokeClaudeSessionStart(repo, { session_id: sessionId, source: 'resume' }, {
      CLAUDE_ENV_FILE: envFile
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(
      fs.readFileSync(envFile, 'utf8'),
      'export PROVE_IT_SESSION_ID="session \\"quoted\\" \\\\ slash \\$HOME \\`cmd\\`\\nline"\n'
    )
  })

  it('degrades gracefully when SessionStart needs env export but CLAUDE_ENV_FILE is absent', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)

    const result = invokeClaudeSessionStart(repo, { session_id: 'session-1', source: 'startup' })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(result.output.hookSpecificOutput.additionalContext, /prove_it methodology:/)
    assert.match(result.output.hookSpecificOutput.additionalContext, /CLAUDE_ENV_FILE is not set/)
  })

  it('exports PROVE_IT_SESSION_ID only for SessionStart startup and resume sources', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)
    const resumeEnvFile = path.join(repo, '.resume-env')
    const clearEnvFile = path.join(repo, '.clear-env')

    const resume = invokeClaudeSessionStart(repo, { session_id: 'resume-session', source: 'resume' }, {
      CLAUDE_ENV_FILE: resumeEnvFile
    })
    const clear = invokeClaudeSessionStart(repo, { session_id: 'clear-session', source: 'clear' }, {
      CLAUDE_ENV_FILE: clearEnvFile
    })

    assert.strictEqual(resume.exitCode, 0)
    assert.strictEqual(clear.exitCode, 0)
    assert.strictEqual(fs.readFileSync(resumeEnvFile, 'utf8'), 'export PROVE_IT_SESSION_ID="resume-session"\n')
    assert.strictEqual(fs.existsSync(clearEnvFile), false)
    assert.match(clear.output.hookSpecificOutput.additionalContext, /prove_it methodology:/)
    assert.doesNotMatch(clear.output.hookSpecificOutput.additionalContext, /set env vars: PROVE_IT_SESSION_ID/)
  })

  it('reports invalid strict .prove_it config through Claude-safe SessionStart diagnostics without running legacy', () => {
    const repo = tmpRepo()
    fs.mkdirSync(path.join(repo, '.prove_it'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.prove_it', 'config.json'), JSON.stringify({
      schema_version: 1,
      profile_version: PROFILE_VERSION,
      hooks: { claude: { SessionStart: [] } },
      adapters: { claude: { enabled: true } }
    }))
    writeLegacyDenyConfig(repo)

    const result = invokeClaudeSessionStart(repo)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(result.output.hookSpecificOutput.additionalContext, /invalid strict \.prove_it\/config\.json/i)
    assert.match(result.output.systemMessage, /unknown top-level key "hooks"/)
    assert.doesNotMatch(result.stdout, /legacy-deny/)
  })

  it('activates for strict .prove_it projects with the Claude adapter enabled and skips legacy workflow config', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)
    fs.mkdirSync(path.join(repo, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.claude', 'prove_it', 'config.json'), '{ invalid legacy json')
    fs.writeFileSync(path.join(repo, '.claude', 'prove_it', 'config.local.json'), '{ invalid legacy local json')

    const result = invokeClaudePreTool(repo, { file_path: '.prove_it/config.json', content: '{}' })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /protected prove_it config path \.prove_it\/config\.json/)
    assert.doesNotMatch(result.stdout, /invalid legacy json|invalid legacy local json/)
    assert.doesNotMatch(result.stderr, /invalid legacy json|invalid legacy local json/)
  })

  it('hard-blocks strict local config edits from Claude file_path payloads', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)

    const result = invokeClaudePreTool(repo, { file_path: '.prove_it/config.local.json', content: '{}' })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /protected prove_it config path \.prove_it\/config\.local\.json/)
    assert.match(result.output.systemMessage, /protected prove_it config path \.prove_it\/config\.local\.json/)
  })

  it('hard-blocks strict config edits from Claude notebook_path payloads', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)

    const result = invokeClaudePreTool(repo, { notebook_path: '.prove_it/config.json', edits: [] })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /protected prove_it config path \.prove_it\/config\.json/)
  })

  it('hard-blocks Bash redirects to strict prove_it config paths in the clean route', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)

    const result = invokeClaudePreTool(repo, { command: 'mkdir -p .prove_it && echo {} > .prove_it/config.local.json' }, {}, 'Bash')

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /protected prove_it config path \.prove_it\/config\.local\.json/)
  })

  it('does not treat .claude/prove_it config as clean-runtime protected config', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, true)
    writeLegacyDenyConfig(repo)

    const result = invokeClaudePreTool(repo, { file_path: '.claude/prove_it/config.json', content: '{}' })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output, null)
  })

  it('does not fall back to legacy workflow config when no strict project config exists', () => {
    const repo = tmpRepo()
    writeLegacyDenyConfig(repo)
    writeJson(path.join(repo, '.claude', 'prove_it', 'config.local.json'), {
      enabled: true,
      hooks: {
        claude: {
          PreToolUse: [{ name: 'legacy-local-deny', type: 'script', matcher: 'Write', command: 'echo legacy local executed && exit 1' }]
        }
      }
    })

    const result = invokeClaudePreTool(repo, { file_path: 'src/app.js', content: 'x' }, { PROVE_IT_LEGACY_CLAUDE_ORACLE: '1' })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output, null)
  })

  it('does not fall back to the legacy dispatcher when strict config disables the Claude adapter', () => {
    const repo = tmpRepo()
    writeStrictConfig(repo, false)
    writeLegacyDenyConfig(repo)

    const result = invokeClaudePreTool(repo, { file_path: 'src/app.js', content: 'x' })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output, null)
  })

  it('uses strict clean globs when stale legacy config tries to alter source matching', () => {
    const repo = tmpRepo()
    const env = isolatedEnv(path.join(repo, '.home'))
    const marker = path.join(repo, 'legacy-globs-ran')
    writeStrictConfig(repo, true, {
      globs: { source: ['lib/**/*.js'], test: [] },
      tasks: {
        source_check: {
          type: 'script',
          command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
          when: { signal: 'done', sourceFilesEdited: true }
        }
      },
      agent_workflows: { agent_end: ['source_check'] }
    })
    writeJson(path.join(repo, '.claude', 'prove_it', 'config.json'), {
      enabled: true,
      sources: ['src/**/*.js'],
      hooks: {
        claude: {
          Stop: [{ name: 'legacy-source-check', type: 'script', command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'legacy')"`, when: { signal: 'done' } }]
        }
      }
    })

    const postTool = invokeClaudePostTool(repo, {
      session_id: 'strict-globs-session',
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js', content: 'module.exports = {}\n' },
      tool_response: { success: true }
    }, env)
    withProveItDir(env.PROVE_IT_DIR, () => setSignal('strict-globs-session', 'done', null))
    const stop = invokeClaudeStop(repo, { session_id: 'strict-globs-session' }, env)

    assert.strictEqual(postTool.exitCode, 0)
    assert.strictEqual(stop.exitCode, 0)
    assert.strictEqual(stop.output.decision, 'approve')
    assert.strictEqual(fs.existsSync(marker), false)
    assert.strictEqual(withProveItDir(env.PROVE_IT_DIR, () => getSignal('strict-globs-session')), null)
  })

  it('does not let stale legacy config suppress or alter strict reviewer tasks', () => {
    const repo = tmpRepo()
    const env = isolatedEnv(path.join(repo, '.home'))
    writeStrictConfig(repo, true, {
      tasks: {
        strict_review: {
          type: 'reviewer',
          intent: 'This strict reviewer intentionally requests another harness.',
          provider: 'codex',
          when: { signal: 'done' }
        }
      },
      agent_workflows: { agent_end: ['strict_review'] }
    })
    writeJson(path.join(repo, '.claude', 'prove_it', 'config.json'), {
      enabled: false,
      hooks: {
        claude: {
          Stop: [{ name: 'strict_review', enabled: false, type: 'script', command: 'echo legacy suppressed reviewer' }]
        }
      }
    })

    withProveItDir(env.PROVE_IT_DIR, () => setSignal('strict-review-session', 'done', null))
    const result = invokeClaudeStop(repo, { session_id: 'strict-review-session' }, env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.decision, 'block')
    assert.match(result.output.reason, /reviewer task "strict_review" requested reviewer provider "codex"/)
    assert.doesNotMatch(result.stdout + result.stderr, /legacy suppressed reviewer/)
  })

  it('reports invalid strict .prove_it config through Claude-safe PreToolUse context without running legacy', () => {
    const repo = tmpRepo()
    fs.mkdirSync(path.join(repo, '.prove_it'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.prove_it', 'config.json'), JSON.stringify({
      schema_version: 1,
      profile_version: PROFILE_VERSION,
      hooks: { claude: { PreToolUse: [] } },
      adapters: { claude: { enabled: true } }
    }))
    writeLegacyDenyConfig(repo)

    const result = invokeClaudePreTool(repo, { file_path: 'src/app.js', content: 'x' })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, undefined)
    assert.match(result.output.hookSpecificOutput.additionalContext, /invalid strict \.prove_it\/config\.json/i)
    assert.match(result.output.systemMessage, /unknown top-level key "hooks"/)
    assert.doesNotMatch(result.stdout, /legacy-deny/)
  })
})
