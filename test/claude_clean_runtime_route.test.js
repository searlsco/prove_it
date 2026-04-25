const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { invokeHook, isolatedEnv } = require('./integration/hook-harness')
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

function invokeClaudePreTool (repo, toolInput, extraEnv = {}) {
  return invokeHook('claude:PreToolUse', {
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    tool_name: 'Write',
    tool_input: toolInput,
    cwd: repo
  }, {
    cwd: repo,
    projectDir: repo,
    env: { ...isolatedEnv(path.join(repo, '.home')), ...extraEnv }
  })
}

describe('Claude clean-runtime hook route', () => {
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
