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

  it('mergeDeep does not touch hooks (handled by mergeHooks)', () => {
    // hooks is excluded from mergeDeep in loadEffectiveConfig via mergeLayer,
    // but mergeDeep itself still works generically on objects
    const base = { hooks: { claude: { Stop: [{ name: 'a' }] } } }
    const override = { hooks: { claude: { Stop: [{ name: 'b' }] } } }
    const result = mergeDeep(base, override)
    // mergeDeep treats hooks as nested objects—mergeLayer uses mergeHooks instead
    assert.ok(result.hooks.claude.Stop, 'hooks structure preserved by mergeDeep')
  })
})

describe('loadEffectiveConfig ancestor discovery', () => {
  const { loadEffectiveConfig } = require('../lib/config')
  const defaultTestConfig = () => ({
    enabled: false,
    sources: [],
    hooks: {}
  })

  const tmpBase = path.join(os.tmpdir(), 'prove_it_config_test_' + Date.now())
  let origProveItDir

  function setup () {
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = path.join(tmpBase, '_no_global_config')
    fs.mkdirSync(path.join(tmpBase, '.claude', 'prove_it'), { recursive: true })
    fs.mkdirSync(path.join(tmpBase, 'child', '.claude', 'prove_it'), { recursive: true })
    fs.mkdirSync(path.join(tmpBase, 'child', 'grandchild'), { recursive: true })

    fs.writeFileSync(
      path.join(tmpBase, '.claude', 'prove_it', 'config.json'),
      JSON.stringify({ hooks: {}, sources: ['root/**/*.js'] })
    )
    fs.writeFileSync(
      path.join(tmpBase, 'child', '.claude', 'prove_it', 'config.json'),
      JSON.stringify({ hooks: {}, sources: ['child/**/*.js'] })
    )
  }

  function cleanup () {
    if (origProveItDir !== undefined) process.env.PROVE_IT_DIR = origProveItDir
    else delete process.env.PROVE_IT_DIR
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }

  it('loads config from cwd', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child'), defaultTestConfig)
      assert.deepStrictEqual(cfg.sources, ['child/**/*.js'])
    } finally {
      cleanup()
    }
  })

  it('child config wins over ancestor (last writer wins for arrays)', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child'), defaultTestConfig)
      // Arrays are replaced, not merged—child sources win
      assert.deepStrictEqual(cfg.sources, ['child/**/*.js'])
    } finally {
      cleanup()
    }
  })

  it('grandchild inherits from nearest ancestor', () => {
    setup()
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child', 'grandchild'), defaultTestConfig)
      // grandchild has no config—inherits child's sources
      assert.deepStrictEqual(cfg.sources, ['child/**/*.js'])
    } finally {
      cleanup()
    }
  })

  it('cwd config wins over ancestors', () => {
    setup()
    fs.mkdirSync(path.join(tmpBase, 'child', 'grandchild', '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpBase, 'child', 'grandchild', '.claude', 'prove_it', 'config.json'),
      JSON.stringify({ hooks: {}, sources: ['grandchild/**/*.js'] })
    )
    try {
      const { cfg } = loadEffectiveConfig(path.join(tmpBase, 'child', 'grandchild'), defaultTestConfig)
      assert.deepStrictEqual(cfg.sources, ['grandchild/**/*.js'])
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
      assert.strictEqual(cfg.enabled, false)
      assert.strictEqual(typeof cfg.hooks, 'object', 'hooks should be an object')
      assert.strictEqual(Array.isArray(cfg.hooks), false, 'hooks should not be an array')
      assert.deepStrictEqual(cfg.sources, [])
    } finally {
      if (origDir !== undefined) process.env.PROVE_IT_DIR = origDir
      else delete process.env.PROVE_IT_DIR
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('mergeHooks', () => {
  const { mergeHooks } = require('../lib/config')

  it('returns base when override is empty', () => {
    const base = { claude: { Stop: [{ name: 'a', command: 'echo a' }] } }
    const result = mergeHooks(base, {})
    assert.deepStrictEqual(result, base)
  })

  it('returns override when base is empty', () => {
    const override = { claude: { Stop: [{ name: 'a', command: 'echo a' }] } }
    const result = mergeHooks({}, override)
    assert.deepStrictEqual(result, override)
  })

  it('appends new-name tasks after inherited tasks', () => {
    const base = { claude: { Stop: [{ name: 'a', command: 'echo a' }] } }
    const override = { claude: { Stop: [{ name: 'b', command: 'echo b' }] } }
    const result = mergeHooks(base, override)
    assert.deepStrictEqual(result.claude.Stop, [
      { name: 'a', command: 'echo a' },
      { name: 'b', command: 'echo b' }
    ])
  })

  it('same-name task in descendant fully replaces parent', () => {
    const base = { claude: { Stop: [{ name: 'a', command: 'echo a', timeout: 5000 }] } }
    const override = { claude: { Stop: [{ name: 'a', command: 'echo override' }] } }
    const result = mergeHooks(base, override)
    assert.deepStrictEqual(result.claude.Stop, [
      { name: 'a', command: 'echo override' }
    ])
    assert.strictEqual(result.claude.Stop[0].timeout, undefined, 'parent fields should not be inherited')
  })

  it('preserves ordering: base tasks first, new override tasks appended', () => {
    const base = {
      claude: {
        PreToolUse: [
          { name: 'a', command: 'echo a' },
          { name: 'b', command: 'echo b' }
        ]
      }
    }
    const override = {
      claude: {
        PreToolUse: [
          { name: 'c', command: 'echo c' },
          { name: 'a', command: 'echo a-override' }
        ]
      }
    }
    const result = mergeHooks(base, override)
    assert.deepStrictEqual(result.claude.PreToolUse.map(t => t.name), ['a', 'b', 'c'])
    assert.strictEqual(result.claude.PreToolUse[0].command, 'echo a-override')
  })

  it('merges across hook types independently', () => {
    const base = {
      claude: { Stop: [{ name: 'a', command: 'echo a' }] },
      git: { 'pre-commit': [{ name: 'b', command: 'echo b' }] }
    }
    const override = {
      claude: { Stop: [{ name: 'c', command: 'echo c' }] },
      git: { 'pre-push': [{ name: 'd', command: 'echo d' }] }
    }
    const result = mergeHooks(base, override)
    assert.deepStrictEqual(result.claude.Stop.map(t => t.name), ['a', 'c'])
    assert.deepStrictEqual(result.git['pre-commit'].map(t => t.name), ['b'])
    assert.deepStrictEqual(result.git['pre-push'].map(t => t.name), ['d'])
  })

  it('adds new event keys from override', () => {
    const base = { claude: { Stop: [{ name: 'a', command: 'echo a' }] } }
    const override = { claude: { SessionStart: [{ name: 'b', command: 'echo b' }] } }
    const result = mergeHooks(base, override)
    assert.deepStrictEqual(result.claude.Stop, [{ name: 'a', command: 'echo a' }])
    assert.deepStrictEqual(result.claude.SessionStart, [{ name: 'b', command: 'echo b' }])
  })

  it('adds new hook type from override', () => {
    const base = { claude: { Stop: [{ name: 'a', command: 'echo a' }] } }
    const override = { git: { 'pre-commit': [{ name: 'b', command: 'echo b' }] } }
    const result = mergeHooks(base, override)
    assert.ok(result.claude, 'base type preserved')
    assert.ok(result.git, 'override type added')
  })

  it('handles undefined/null base and override gracefully', () => {
    const hooks = { claude: { Stop: [{ name: 'a', command: 'echo a' }] } }
    assert.deepStrictEqual(mergeHooks(undefined, hooks), hooks)
    assert.deepStrictEqual(mergeHooks(null, hooks), hooks)
    assert.deepStrictEqual(mergeHooks(hooks, undefined), hooks)
    assert.deepStrictEqual(mergeHooks(hooks, null), hooks)
  })
})

describe('hasCustomSources', () => {
  const { hasCustomSources } = require('../lib/config')

  it('returns false for null/undefined config', () => {
    assert.strictEqual(hasCustomSources(null), false)
    assert.strictEqual(hasCustomSources(undefined), false)
  })

  it('returns false for empty or missing sources', () => {
    assert.strictEqual(hasCustomSources({}), false)
    assert.strictEqual(hasCustomSources({ sources: [] }), false)
    assert.strictEqual(hasCustomSources({ sources: null }), false)
  })

  it('returns false when sources contain the placeholder glob', () => {
    assert.strictEqual(hasCustomSources({
      sources: ['**/*.*', 'replace/these/with/globs/of/your/source/and/test/files.*']
    }), false)
  })

  it('returns true when sources are customized', () => {
    assert.strictEqual(hasCustomSources({ sources: ['src/**/*.js', 'test/**/*.js'] }), true)
  })

  it('returns false when even one source contains placeholder', () => {
    assert.strictEqual(hasCustomSources({
      sources: ['src/**/*.js', 'replace/these/with/globs/foo.*']
    }), false)
  })
})

describe('hasCustomTests', () => {
  const { hasCustomTests } = require('../lib/config')

  it('returns false for null/undefined config', () => {
    assert.strictEqual(hasCustomTests(null), false)
    assert.strictEqual(hasCustomTests(undefined), false)
  })

  it('returns false for empty or missing tests', () => {
    assert.strictEqual(hasCustomTests({}), false)
    assert.strictEqual(hasCustomTests({ tests: [] }), false)
    assert.strictEqual(hasCustomTests({ tests: null }), false)
  })

  it('returns false for default tests globs', () => {
    const { buildConfig } = require('../lib/config')
    const defaults = buildConfig({ gitHooks: false, defaultChecks: false })
    assert.strictEqual(hasCustomTests({ tests: defaults.tests }), false)
  })

  it('returns true when tests are customized', () => {
    assert.strictEqual(hasCustomTests({ tests: ['**/*.test.js'] }), true)
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

describe('validateLayerTypes', () => {
  const { validateLayerTypes } = require('../lib/config')

  it('accepts valid typed values', () => {
    // Should not throw
    validateLayerTypes({ enabled: true, sources: ['**/*.js'], model: 'haiku' }, 'test.json')
  })

  it('throws on wrong type with file path in message', () => {
    assert.throws(
      () => validateLayerTypes({ model: null }, '~/.claude/prove_it/config.json'),
      (err) => {
        assert.ok(err.message.includes('~/.claude/prove_it/config.json'))
        assert.ok(err.message.includes('"model" must be a string'))
        return true
      }
    )
  })

  it('throws on array where boolean expected', () => {
    assert.throws(
      () => validateLayerTypes({ enabled: [] }, 'config.json'),
      (err) => {
        assert.ok(err.message.includes('"enabled" must be a boolean'))
        return true
      }
    )
  })

  it('throws on null for array fields', () => {
    for (const key of ['sources', 'tests', 'testCommands', 'taskAllowedTools', 'fileEditingTools']) {
      assert.throws(
        () => validateLayerTypes({ [key]: null }, 'config.json'),
        (err) => {
          assert.ok(err.message.includes(`"${key}" must be an array`), `Expected array error for ${key}`)
          return true
        }
      )
    }
  })

  it('ignores unknown keys (validated elsewhere)', () => {
    // Should not throw — unknown keys are caught by validateConfig, not validateLayerTypes
    validateLayerTypes({ unknownKey: 'whatever' }, 'config.json')
  })
})

describe('userKeys tracking in loadEffectiveConfig', () => {
  const { loadEffectiveConfig } = require('../lib/config')
  const tmpBase = path.join(os.tmpdir(), 'prove_it_userkeys_' + Date.now())
  let origProveItDir

  function setup (globalCfg, projectCfg) {
    origProveItDir = process.env.PROVE_IT_DIR
    const globalDir = path.join(tmpBase, 'global')
    process.env.PROVE_IT_DIR = globalDir
    if (globalCfg) {
      fs.mkdirSync(globalDir, { recursive: true })
      fs.writeFileSync(path.join(globalDir, 'config.json'), JSON.stringify(globalCfg))
    }
    const projectDir = path.join(tmpBase, 'project')
    if (projectCfg) {
      fs.mkdirSync(path.join(projectDir, '.claude', 'prove_it'), { recursive: true })
      fs.writeFileSync(
        path.join(projectDir, '.claude', 'prove_it', 'config.json'),
        JSON.stringify(projectCfg)
      )
    } else {
      fs.mkdirSync(projectDir, { recursive: true })
    }
    return projectDir
  }

  function cleanup () {
    if (origProveItDir !== undefined) process.env.PROVE_IT_DIR = origProveItDir
    else delete process.env.PROVE_IT_DIR
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }

  it('tracks keys from user config files but not CONFIG_DEFAULTS', () => {
    const projectDir = setup(
      { enabled: true },
      { hooks: {}, sources: ['src/**/*.js'] }
    )
    try {
      const { userKeys } = loadEffectiveConfig(projectDir, require('../lib/defaults').configDefaults)
      assert.ok(userKeys.has('enabled'), 'enabled should be in userKeys (from global)')
      assert.ok(userKeys.has('sources'), 'sources should be in userKeys (from project)')
      assert.ok(userKeys.has('hooks'), 'hooks should be in userKeys (from project)')
      assert.ok(!userKeys.has('maxAgentTurns'), 'maxAgentTurns should NOT be in userKeys (only in defaults)')
      assert.ok(!userKeys.has('model'), 'model should NOT be in userKeys (only in defaults)')
    } finally {
      cleanup()
    }
  })

  it('returns empty userKeys when no config files exist', () => {
    const projectDir = setup(null, null)
    try {
      const { userKeys } = loadEffectiveConfig(projectDir, require('../lib/defaults').configDefaults)
      assert.strictEqual(userKeys.size, 0)
    } finally {
      cleanup()
    }
  })
})

describe('findProveItProject', () => {
  const { findProveItProject } = require('../lib/config')
  const tmpDir = path.join(os.tmpdir(), 'prove_it_findproject_' + Date.now())

  it('finds project when .claude/prove_it/config.json exists', () => {
    const projectDir = path.join(tmpDir, 'myproject')
    fs.mkdirSync(path.join(projectDir, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.claude', 'prove_it', 'config.json'), '{}')

    assert.strictEqual(findProveItProject(projectDir), projectDir)
  })

  it('finds project in ancestor directory', () => {
    const projectDir = path.join(tmpDir, 'ancestor')
    const subDir = path.join(projectDir, 'src', 'lib')
    fs.mkdirSync(subDir, { recursive: true })
    fs.mkdirSync(path.join(projectDir, '.claude', 'prove_it'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.claude', 'prove_it', 'config.json'), '{}')

    assert.strictEqual(findProveItProject(subDir), projectDir)
  })

  it('returns null when no config exists', () => {
    const noProjectDir = path.join(tmpDir, 'empty')
    fs.mkdirSync(noProjectDir, { recursive: true })

    assert.strictEqual(findProveItProject(noProjectDir), null)
  })
})
