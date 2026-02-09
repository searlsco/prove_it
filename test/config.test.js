const { describe, it } = require('node:test')
const assert = require('node:assert')
const os = require('os')
const fs = require('fs')
const path = require('path')

describe('config merging', () => {
  const { mergeDeep } = require('../lib/config')

  it('merges nested objects', () => {
    const base = { suiteGate: { command: './scripts/test', require: true } }
    const override = { suiteGate: { command: 'npm test' } }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, {
      suiteGate: { command: 'npm test', require: true }
    })
  })

  it('overrides arrays entirely', () => {
    const base = { triggers: ['a', 'b'] }
    const override = { triggers: ['c'] }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { triggers: ['c'] })
  })

  it('handles null override', () => {
    const base = { foo: 'bar' }
    const result = mergeDeep(base, null)
    assert.deepStrictEqual(result, { foo: 'bar' })
  })

  it('handles undefined override', () => {
    const base = { foo: 'bar' }
    const result = mergeDeep(base, undefined)
    assert.deepStrictEqual(result, { foo: 'bar' })
  })

  it('override scalar values', () => {
    const base = { cacheSeconds: 900 }
    const override = { cacheSeconds: 300 }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { cacheSeconds: 300 })
  })

  it('merges false values correctly', () => {
    const base = { suiteGate: { require: true, command: './script/test' } }
    const override = { suiteGate: { require: false } }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { suiteGate: { require: false, command: './script/test' } })
  })

  it('merges zero values correctly', () => {
    const base = { cacheSeconds: 900 }
    const override = { cacheSeconds: 0 }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { cacheSeconds: 0 })
  })

  it('merges empty string values correctly', () => {
    const base = { name: 'foo' }
    const override = { name: '' }
    const result = mergeDeep(base, override)
    assert.deepStrictEqual(result, { name: '' })
  })

  it('array override replaces object base (v1→v2 hooks migration)', () => {
    const base = { hooks: { done: { enabled: true }, stop: { enabled: true } } }
    const override = { hooks: [{ type: 'claude', event: 'Stop', tasks: [] }] }
    const result = mergeDeep(base, override)

    assert.strictEqual(Array.isArray(result.hooks), true, 'hooks should be an array')
    assert.strictEqual(result.hooks.length, 1)
    assert.strictEqual(result.hooks[0].event, 'Stop')
  })

  it('object override replaces array base', () => {
    const base = { hooks: [{ type: 'claude' }] }
    const override = { hooks: { done: { enabled: true } } }
    const result = mergeDeep(base, override)

    assert.strictEqual(Array.isArray(result.hooks), false, 'hooks should be an object')
    assert.strictEqual(result.hooks.done.enabled, true)
  })
})

describe('loadEffectiveConfig ancestor discovery', () => {
  const { loadEffectiveConfig } = require('../lib/config')
  const defaultTestConfig = () => ({
    enabled: true,
    sources: null,
    format: { maxOutputChars: 12000 },
    hooks: [],
    commands: { test: { full: null, fast: null } }
  })

  const tmpBase = path.join(os.tmpdir(), 'prove_it_config_test_' + Date.now())

  function setup () {
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(tmpBase, 'child', '.claude'), { recursive: true })
    fs.mkdirSync(path.join(tmpBase, 'child', 'grandchild'), { recursive: true })

    fs.writeFileSync(
      path.join(tmpBase, '.claude', 'prove_it.json'),
      JSON.stringify({ commands: { test: { full: './root-test' } } })
    )
    fs.writeFileSync(
      path.join(tmpBase, 'child', '.claude', 'prove_it.json'),
      JSON.stringify({ commands: { test: { fast: './child-fast' } } })
    )
  }

  function cleanup () {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }

  it('loads config from cwd', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child'), defaultTestConfig)
      assert.strictEqual(cfg.commands.test.fast, './child-fast')
    } finally {
      cleanup()
    }
  })

  it('inherits ancestor config (child overrides root)', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child'), defaultTestConfig)
      assert.strictEqual(cfg.commands.test.full, './root-test')
      assert.strictEqual(cfg.commands.test.fast, './child-fast')
    } finally {
      cleanup()
    }
  })

  it('grandchild inherits from ancestors', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child', 'grandchild'), defaultTestConfig)
      assert.strictEqual(cfg.commands.test.full, './root-test')
      assert.strictEqual(cfg.commands.test.fast, './child-fast')
    } finally {
      cleanup()
    }
  })

  it('cwd config wins over ancestors', () => {
    setup()
    fs.mkdirSync(path.join(tmpBase, 'child', 'grandchild', '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpBase, 'child', 'grandchild', '.claude', 'prove_it.json'),
      JSON.stringify({ commands: { test: { full: './grandchild-test' } } })
    )
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child', 'grandchild'), defaultTestConfig)
      assert.strictEqual(cfg.commands.test.full, './grandchild-test')
      assert.strictEqual(cfg.commands.test.fast, './child-fast')
    } finally {
      cleanup()
    }
  })

  it('uses defaults when no config found', () => {
    const emptyDir = path.join(os.tmpdir(), 'prove_it_empty_' + Date.now())
    fs.mkdirSync(emptyDir, { recursive: true })
    const origDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(emptyDir, 'no_global_config')
    try {
      const { cfg } = loadEffectiveConfig(emptyDir, defaultTestConfig)
      assert.strictEqual(cfg.enabled, true)
      assert.strictEqual(Array.isArray(cfg.hooks), true, 'hooks should be an array')
      assert.strictEqual(cfg.commands.test.full, null)
    } finally {
      if (origDir !== undefined) process.env.PROVE_IT_DIR = origDir
      else delete process.env.PROVE_IT_DIR
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('isIgnoredPath', () => {
  const { isIgnoredPath } = require('../lib/config')
  const home = os.homedir()

  it('returns false for empty ignoredPaths', () => {
    assert.strictEqual(isIgnoredPath('/some/path', []), false)
    assert.strictEqual(isIgnoredPath('/some/path', null), false)
    assert.strictEqual(isIgnoredPath('/some/path', undefined), false)
  })

  it('matches absolute paths exactly', () => {
    assert.strictEqual(isIgnoredPath('/Users/test/bin', ['/Users/test/bin']), true)
    assert.strictEqual(isIgnoredPath('/Users/test/bin', ['/Users/other/bin']), false)
  })

  it('matches home-relative paths with ~', () => {
    const binPath = path.join(home, 'bin')
    assert.strictEqual(isIgnoredPath(binPath, ['~/bin']), true)
    assert.strictEqual(isIgnoredPath(binPath, ['~/other']), false)
  })

  it('matches subdirectories of ignored paths', () => {
    const subPath = path.join(home, 'bin', 'scripts')
    assert.strictEqual(isIgnoredPath(subPath, ['~/bin']), true)
  })

  it('does not match partial directory names', () => {
    const binPath = path.join(home, 'binary')
    assert.strictEqual(isIgnoredPath(binPath, ['~/bin']), false)
  })

  it('handles multiple ignored paths', () => {
    const binPath = path.join(home, 'bin')
    const dotfilesPath = path.join(home, 'dotfiles')
    assert.strictEqual(isIgnoredPath(binPath, ['~/dotfiles', '~/bin']), true)
    assert.strictEqual(isIgnoredPath(dotfilesPath, ['~/dotfiles', '~/bin']), true)
    assert.strictEqual(isIgnoredPath(path.join(home, 'code'), ['~/dotfiles', '~/bin']), false)
  })
})
