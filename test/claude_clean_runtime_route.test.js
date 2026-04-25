const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { invokeHook, isolatedEnv, initGitRepo } = require('./integration/hook-harness')
const { PROFILE_VERSION } = require('../lib/redesign/config')

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

describe('Claude clean-runtime hook route', () => {
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

  it('falls back to the legacy dispatcher when no strict project config exists', () => {
    const repo = tmpRepo()
    writeLegacyDenyConfig(repo)

    const result = invokeClaudePreTool(repo, { file_path: 'src/app.js', content: 'x' })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /legacy-deny failed/)
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /legacy runtime executed/)
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
