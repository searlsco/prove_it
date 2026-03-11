const assert = require('assert')
const { describe, it } = require('node:test')

const { CONFIG_DEFAULTS, DEFAULT_MODELS, DEFAULT_ALLOWED_TOOLS, configDefaults } = require('../lib/defaults')

describe('CONFIG_DEFAULTS', () => {
  it('has expected shape and values', () => {
    assert.strictEqual(CONFIG_DEFAULTS.enabled, false)
    assert.strictEqual(CONFIG_DEFAULTS.sources, null)
    assert.deepStrictEqual(CONFIG_DEFAULTS.hooks, [])
    assert.strictEqual(CONFIG_DEFAULTS.maxAgentTurns, 10)
    assert.deepStrictEqual(CONFIG_DEFAULTS.format, { maxOutputChars: 12000 })
    assert.deepStrictEqual(CONFIG_DEFAULTS.taskEnv, { TURBOCOMMIT_DISABLED: '1' })
    assert.strictEqual(CONFIG_DEFAULTS.taskAllowedTools, null)
    assert.strictEqual(CONFIG_DEFAULTS.taskBypassPermissions, null)
    assert.strictEqual(CONFIG_DEFAULTS.model, null)
    assert.deepStrictEqual(CONFIG_DEFAULTS.fileEditingTools, [])
  })
})

describe('DEFAULT_MODELS', () => {
  it('maps hook events to model names', () => {
    assert.strictEqual(DEFAULT_MODELS.PreToolUse, 'haiku')
    assert.strictEqual(DEFAULT_MODELS.Stop, 'haiku')
    assert.strictEqual(DEFAULT_MODELS['pre-commit'], 'sonnet')
    assert.strictEqual(DEFAULT_MODELS['pre-push'], 'sonnet')
  })
})

describe('DEFAULT_ALLOWED_TOOLS', () => {
  it('contains expected tool names', () => {
    assert.ok(DEFAULT_ALLOWED_TOOLS.includes('Read'))
    assert.ok(DEFAULT_ALLOWED_TOOLS.includes('Bash'))
    assert.ok(DEFAULT_ALLOWED_TOOLS.includes('WebSearch'))
    assert.strictEqual(DEFAULT_ALLOWED_TOOLS.length, 10)
  })
})

describe('configDefaults', () => {
  it('returns a fresh deep copy each call', () => {
    const a = configDefaults()
    const b = configDefaults()
    assert.deepStrictEqual(a, b)
    assert.notStrictEqual(a, b)
    assert.notStrictEqual(a.format, b.format)
    assert.notStrictEqual(a.taskEnv, b.taskEnv)
    assert.notStrictEqual(a.hooks, b.hooks)
  })

  it('matches CONFIG_DEFAULTS values', () => {
    const d = configDefaults()
    assert.strictEqual(d.enabled, CONFIG_DEFAULTS.enabled)
    assert.strictEqual(d.maxAgentTurns, CONFIG_DEFAULTS.maxAgentTurns)
    assert.deepStrictEqual(d.format, CONFIG_DEFAULTS.format)
  })

  it('mutations do not affect future calls', () => {
    const a = configDefaults()
    a.maxAgentTurns = 99
    a.format.maxOutputChars = 1
    const b = configDefaults()
    assert.strictEqual(b.maxAgentTurns, 10)
    assert.strictEqual(b.format.maxOutputChars, 12000)
  })
})
