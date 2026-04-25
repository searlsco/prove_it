const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

function tmpRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_pi_'))
  fs.mkdirSync(path.join(dir, '.prove_it'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.prove_it', 'config.json'), JSON.stringify({
    schema_version: 1,
    profile_version: 'test',
    tasks: {
      protect_prove_it_config: {
        type: 'config_guard',
        protected_paths: ['.prove_it/config.json', '.prove_it/config.local.json']
      }
    },
    agent_workflows: {
      pre_tool: ['protect_prove_it_config']
    }
  }, null, 2))
  return dir
}

function fakePi () {
  const handlers = {}
  return {
    handlers,
    on (eventName, handler) {
      handlers[eventName] = handler
    }
  }
}

describe('pi adapter pre-tool config guard', () => {
  it('loads a fake Pi extension and blocks edits to .prove_it/config.json', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const repo = tmpRepo()
    const pi = fakePi()
    registerPiExtension(pi)

    const result = await pi.handlers.tool_call({
      toolName: 'edit',
      input: { path: '.prove_it/config.json' }
    }, { cwd: repo })

    assert.deepStrictEqual(result, {
      block: true,
      reason: 'prove_it: Cannot modify protected prove_it config path .prove_it/config.json'
    })
  })

  it('blocks edits to .prove_it/config.local.json from Pi input.path payloads', async () => {
    const { handleToolCall } = require('../lib/adapters/pi/bridge')
    const repo = tmpRepo()

    const result = await handleToolCall({
      toolName: 'write',
      input: { path: path.join(repo, '.prove_it', 'config.local.json') }
    }, { cwd: repo })

    assert.strictEqual(result.block, true)
    assert.match(result.reason, /\.prove_it\/config\.local\.json/)
  })

  it('recognizes Pi-style top-level path payloads', async () => {
    const { handleToolCall } = require('../lib/adapters/pi/bridge')
    const repo = tmpRepo()

    const result = await handleToolCall({
      toolName: 'edit',
      path: '.prove_it/config.json',
      input: {}
    }, { cwd: repo })

    assert.strictEqual(result.block, true)
  })

  it('emits an allow effect for unrelated Pi tool calls', () => {
    const { loadProjectConfig } = require('../lib/redesign/config')
    const { normalizePiToolCall } = require('../lib/redesign/events')
    const { runPreToolWorkflow } = require('../lib/redesign/engine')
    const repo = tmpRepo()

    const config = loadProjectConfig(repo)
    const event = normalizePiToolCall({
      toolName: 'edit',
      input: { path: 'src/app.js' }
    }, { cwd: repo })

    assert.deepStrictEqual(runPreToolWorkflow(config, event), {
      effect: 'allow'
    })
  })

  it('does not read legacy .claude/prove_it config for Pi tool calls', async () => {
    const { handleToolCall } = require('../lib/adapters/pi/bridge')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_pi_legacy_'))
    fs.mkdirSync(path.join(repo, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.claude', 'prove_it', 'config.json'), JSON.stringify({
      hooks: {
        pi: {
          tool_call: [{ name: 'legacy-guard', type: 'config_guard' }]
        }
      }
    }))

    const result = await handleToolCall({
      toolName: 'edit',
      input: { path: '.prove_it/config.json' }
    }, { cwd: repo })

    assert.strictEqual(result, undefined)
  })

  it('rejects hook-shaped legacy keys in the strict .prove_it config', () => {
    const { loadProjectConfig } = require('../lib/redesign/config')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_pi_strict_'))
    fs.mkdirSync(path.join(repo, '.prove_it'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.prove_it', 'config.json'), JSON.stringify({
      schema_version: 1,
      hooks: { pi: { tool_call: [] } },
      tasks: {},
      agent_workflows: { pre_tool: [] }
    }))

    assert.throws(
      () => loadProjectConfig(repo),
      /unknown top-level key "hooks"/
    )
  })

  it('injects minimal prove_it methodology guidance before the agent starts', async () => {
    const registerPiExtension = require('../lib/adapters/pi/extension')
    const pi = fakePi()
    registerPiExtension(pi)

    const result = await pi.handlers.before_agent_start({
      systemPrompt: 'Base system prompt'
    }, { cwd: process.cwd() })

    assert.match(result.systemPrompt, /Base system prompt/)
    const { renderMethodologySummary } = require('../lib/methodology')
    assert.match(result.systemPrompt, /prove_it methodology/)
    assert.match(result.systemPrompt, /verify claims with evidence/)
    assert.ok(result.systemPrompt.includes(renderMethodologySummary()), 'Pi guidance should render from shared methodology')
  })
})
