const { describe, it } = require('node:test')
const assert = require('node:assert')
const { validateConfig, formatErrors } = require('../lib/validate')

describe('validateConfig', () => {
  function validConfig (overrides = {}) {
    return {
      enabled: true,
      sources: ['**/*.js'],
      format: { maxOutputChars: 12000 },
      hooks: [
        {
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          tasks: [
            { name: 'lint', type: 'script', command: './script/lint' }
          ]
        }
      ],
      ...overrides
    }
  }

  describe('top-level validation', () => {
    it('passes valid config', () => {
      const { errors } = validateConfig(validConfig())
      assert.strictEqual(errors.length, 0)
    })

    it('errors when enabled is not boolean', () => {
      const { errors } = validateConfig(validConfig({ enabled: 'yes' }))
      assert.ok(errors.some(e => e.includes('"enabled" must be a boolean')))
    })

    it('validates sources field', () => {
      // not array
      const notArray = validateConfig(validConfig({ sources: 'not-array' }))
      assert.ok(notArray.errors.some(e => e.includes('"sources" must be an array')))

      // contains non-string
      const nonString = validateConfig(validConfig({ sources: ['ok', 42] }))
      assert.ok(nonString.errors.some(e => e.includes('sources[1] must be a string')))

      // allows null
      const nullSources = validateConfig(validConfig({ sources: null }))
      assert.strictEqual(nullSources.errors.length, 0)
    })

    it('validates format field', () => {
      // not an object
      const notObj = validateConfig(validConfig({ format: 'bad' }))
      assert.ok(notObj.errors.some(e => e.includes('"format" must be an object')))

      // maxOutputChars not positive
      const neg = validateConfig(validConfig({ format: { maxOutputChars: -1 } }))
      assert.ok(neg.errors.some(e => e.includes('maxOutputChars must be a positive number')))
    })

    it('errors on legacy keys (mode, checks)', () => {
      const withMode = validConfig()
      withMode.mode = 'strict'
      assert.ok(validateConfig(withMode).errors.some(e => e.includes('"mode" is not supported')))

      const withChecks = validConfig()
      withChecks.checks = []
      assert.ok(validateConfig(withChecks).errors.some(e => e.includes('Top-level "checks" is not valid')))
    })

    it('validates fileEditingTools field', () => {
      // valid array passes
      const valid = validateConfig(validConfig({ fileEditingTools: ['XcodeEdit', 'CustomMCPWrite'] }))
      assert.strictEqual(valid.errors.length, 0)

      // not array errors
      const notArray = validateConfig(validConfig({ fileEditingTools: 'XcodeEdit' }))
      assert.ok(notArray.errors.some(e => e.includes('"fileEditingTools" must be an array')))

      // non-string element errors
      const nonString = validateConfig(validConfig({ fileEditingTools: ['XcodeEdit', 42] }))
      assert.ok(nonString.errors.some(e => e.includes('fileEditingTools[1] must be a string')))
    })

    it('validates top-level model field', () => {
      // valid string with agent tasks passes
      const valid = validateConfig(validConfig({
        model: 'gpt-4.1',
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{ name: 'a', type: 'agent', prompt: 'Review this' }]
        }]
      }))
      assert.strictEqual(valid.errors.length, 0)

      // invalid values: not a string, empty string
      for (const [label, value] of [['number', 42], ['empty string', '']]) {
        const { errors } = validateConfig(validConfig({ model: value }))
        assert.ok(errors.some(e => e.includes('"model" must be a non-empty string')),
          `Expected error for model: ${label}`)
      }

      // warns when no agent tasks exist
      const { warnings } = validateConfig(validConfig({ model: 'gpt-4.1' }))
      assert.ok(warnings.some(w => w.includes('model') && w.includes('no agent tasks')))
    })

    it('errors on unknown top-level keys', () => {
      const cfg = validConfig()
      cfg.customThing = true
      const { errors } = validateConfig(cfg)
      assert.ok(errors.some(e => e.includes('Unknown key "customThing"')))
    })

    it('accepts ignoredPaths without error', () => {
      const { errors } = validateConfig(validConfig({ ignoredPaths: ['~/tmp'] }))
      assert.strictEqual(errors.length, 0)
    })

    it('validates taskAllowedTools field', () => {
      // valid array passes
      const valid = validateConfig(validConfig({ taskAllowedTools: ['Read', 'Write', 'Bash'] }))
      assert.strictEqual(valid.errors.length, 0)

      // not array errors
      const notArray = validateConfig(validConfig({ taskAllowedTools: 'Read' }))
      assert.ok(notArray.errors.some(e => e.includes('"taskAllowedTools" must be an array')))

      // non-string element errors
      const nonString = validateConfig(validConfig({ taskAllowedTools: ['Read', 42] }))
      assert.ok(nonString.errors.some(e => e.includes('taskAllowedTools[1] must be a string')))
    })

    it('validates taskBypassPermissions field', () => {
      // boolean true passes
      const t = validateConfig(validConfig({ taskBypassPermissions: true }))
      assert.strictEqual(t.errors.length, 0)

      // boolean false passes
      const f = validateConfig(validConfig({ taskBypassPermissions: false }))
      assert.strictEqual(f.errors.length, 0)

      // non-boolean errors
      const bad = validateConfig(validConfig({ taskBypassPermissions: 'yes' }))
      assert.ok(bad.errors.some(e => e.includes('"taskBypassPermissions" must be a boolean')))
    })

    it('validates hooks is required and must be array', () => {
      const missing = validConfig()
      delete missing.hooks
      assert.ok(validateConfig(missing).errors.some(e => e.includes('"hooks" is required')))

      const notArray = validateConfig(validConfig({ hooks: {} }))
      assert.ok(notArray.errors.some(e => e.includes('"hooks" must be an array')))
    })
  })

  describe('hook entry validation', () => {
    function cfgWith (hookEntry) {
      return validConfig({ hooks: [hookEntry] })
    }

    it('errors on missing or invalid type', () => {
      const missing = validateConfig(cfgWith({ event: 'Stop', tasks: [] }))
      assert.ok(missing.errors.some(e => e.includes('missing "type"')))

      const invalid = validateConfig(cfgWith({ type: 'webhook', event: 'Stop', tasks: [] }))
      assert.ok(invalid.errors.some(e => e.includes('invalid type "webhook"')))
    })

    it('errors on missing or invalid event', () => {
      const missing = validateConfig(cfgWith({ type: 'claude', tasks: [] }))
      assert.ok(missing.errors.some(e => e.includes('missing "event"')))

      const invalidClaude = validateConfig(cfgWith({ type: 'claude', event: 'OnSave', tasks: [] }))
      assert.ok(invalidClaude.errors.some(e => e.includes('invalid claude event "OnSave"')))

      const invalidGit = validateConfig(cfgWith({ type: 'git', event: 'post-merge', tasks: [] }))
      assert.ok(invalidGit.errors.some(e => e.includes('invalid git event "post-merge"')))
    })

    it('errors on legacy checks key and missing tasks', () => {
      const legacy = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', checks: [{ name: 'a', type: 'script', command: 'x' }]
      }))
      assert.ok(legacy.errors.some(e => e.includes('Rename "checks" to "tasks"')))

      const missing = validateConfig(cfgWith({ type: 'claude', event: 'Stop' }))
      assert.ok(missing.errors.some(e => e.includes('missing "tasks"')))
    })

    it('warns when event-specific keys are used on wrong events', () => {
      const matcher = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', matcher: 'Edit', tasks: []
      }))
      assert.ok(matcher.warnings.some(w => w.includes('matcher only applies to PreToolUse')))

      const triggers = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', triggers: ['npm'], tasks: []
      }))
      assert.ok(triggers.warnings.some(w => w.includes('triggers only applies to PreToolUse')))

      const source = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', source: 'startup', tasks: []
      }))
      assert.ok(source.warnings.some(w => w.includes('source only applies to SessionStart')))
    })

    it('errors on unknown hook keys', () => {
      const { errors } = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', tasks: [], extraKey: true
      }))
      assert.ok(errors.some(e => e.includes('unknown key "extraKey"')))
    })
  })

  describe('task validation', () => {
    function cfgWithTask (task) {
      return validConfig({
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [task]
        }]
      })
    }

    it('errors on missing or invalid name/type', () => {
      const noName = validateConfig(cfgWithTask({ type: 'script', command: 'x' }))
      assert.ok(noName.errors.some(e => e.includes('missing "name"')))

      const noType = validateConfig(cfgWithTask({ name: 'a' }))
      assert.ok(noType.errors.some(e => e.includes('missing "type"')))

      const badType = validateConfig(cfgWithTask({ name: 'a', type: 'webhook' }))
      assert.ok(badType.errors.some(e => e.includes('invalid type "webhook"')))
    })

    it('errors when required fields are missing for task type', () => {
      // script without command
      const noCmd = validateConfig(cfgWithTask({ name: 'a', type: 'script' }))
      assert.ok(noCmd.errors.some(e => e.includes('type "script" but has no "command"')))

      // agent without prompt
      const noPrompt = validateConfig(cfgWithTask({ name: 'a', type: 'agent' }))
      assert.ok(noPrompt.errors.some(e => e.includes('type "agent" but has no "prompt"')))

      // agent with prompt and optional command passes
      const valid = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', command: 'codex exec -'
      }))
      assert.strictEqual(valid.errors.length, 0)
    })

    it('validates when conditions', () => {
      // valid conditions pass
      const valid = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { fileExists: '.config', envSet: 'CI', envNotSet: 'SKIP' }
      }))
      assert.strictEqual(valid.errors.length, 0)

      // unknown key errors
      const badKey = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { badKey: 'val' }
      }))
      assert.ok(badKey.errors.some(e => e.includes('when has unknown key "badKey"')))

      // non-string value errors
      const nonString = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { fileExists: 42 }
      }))
      assert.ok(nonString.errors.some(e => e.includes('when.fileExists must be a string')))
    })

    it('accepts when as array of objects', () => {
      const valid = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: [{ envSet: 'CI' }, { fileExists: '.config' }]
      }))
      assert.strictEqual(valid.errors.length, 0)
    })

    it('rejects empty when array', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: []
      }))
      assert.ok(errors.some(e => e.includes('when array must not be empty')))
    })

    it('validates each element in when array', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: [{ envSet: 'CI' }, { badKey: 'val' }]
      }))
      assert.ok(errors.some(e => e.includes('when[1] has unknown key "badKey"')))
    })

    it('rejects non-object elements in when array', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: [{ envSet: 'CI' }, 'not-an-object']
      }))
      assert.ok(errors.some(e => e.includes('when[1] must be an object')))
    })

    it('rejects when as non-object non-array', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: 'string-value'
      }))
      assert.ok(errors.some(e => e.includes('when must be an object or array of objects')))
    })

    it('errors on non-positive timeout', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', timeout: 0
      }))
      assert.ok(errors.some(e => e.includes('timeout must be a positive number')))
    })

    it('errors when mtime (removed key) is present in config', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', mtime: true
      }))
      assert.ok(errors.some(e => e.includes('unknown key "mtime"')))
    })

    it('validates boolean task fields (enabled, resetOnFail, quiet, async, parallel)', () => {
      for (const field of ['enabled', 'resetOnFail', 'quiet', 'async', 'parallel']) {
        // accepts true and false
        for (const val of [true, false]) {
          const { errors } = validateConfig(cfgWithTask({
            name: 'a', type: 'script', command: 'x', [field]: val
          }))
          assert.strictEqual(errors.length, 0,
            `Expected no errors for ${field}: ${val}`)
        }
        // rejects non-boolean
        const { errors } = validateConfig(cfgWithTask({
          name: 'a', type: 'script', command: 'x', [field]: 'yes'
        }))
        assert.ok(errors.some(e => e.includes(`${field} must be a boolean`)),
          `Expected boolean error for ${field}`)
      }
    })

    it('warns when async: true is used on SessionStart', () => {
      const { warnings } = validateConfig(validConfig({
        hooks: [{
          type: 'claude',
          event: 'SessionStart',
          tasks: [{ name: 'a', type: 'script', command: 'x', async: true }]
        }]
      }))
      assert.ok(warnings.some(w => w.includes('async') && w.includes('SessionStart')))

      // No warning on Stop
      const stopResult = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', async: true
      }))
      assert.ok(!stopResult.warnings.some(w => w.includes('async')))
    })

    it('warns when parallel: true is used on SessionStart', () => {
      const { warnings } = validateConfig(validConfig({
        hooks: [{
          type: 'claude',
          event: 'SessionStart',
          tasks: [{ name: 'a', type: 'script', command: 'x', parallel: true }]
        }]
      }))
      assert.ok(warnings.some(w => w.includes('parallel') && w.includes('SessionStart')))
    })

    it('warns when parallel: true is used on PreToolUse', () => {
      const { warnings } = validateConfig(validConfig({
        hooks: [{
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          tasks: [{ name: 'a', type: 'script', command: 'x', parallel: true }]
        }]
      }))
      assert.ok(warnings.some(w => w.includes('parallel') && w.includes('PreToolUse')))
    })

    it('errors when both async and parallel are true', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', async: true, parallel: true
      }))
      assert.ok(errors.some(e => e.includes('async') && e.includes('parallel') && e.includes('mutually exclusive')))
    })

    it('accepts parallel: true on Stop without warnings', () => {
      const result = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', parallel: true
      }))
      assert.strictEqual(result.errors.length, 0)
      assert.ok(!result.warnings.some(w => w.includes('parallel')))
    })

    it('errors on unknown task keys', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', extraKey: true
      }))
      assert.ok(errors.some(e => e.includes('unknown key "extraKey"')))
    })

    it('validates linesChanged and linesWritten when keys', () => {
      // valid values pass
      for (const [field, extra] of [
        ['linesChanged', {}],
        ['linesWritten', {}]
      ]) {
        const { errors } = validateConfig(cfgWithTask({
          name: 'a',
          type: 'agent',
          prompt: 'review this',
          ...extra,
          when: { [field]: 500 }
        }))
        assert.strictEqual(errors.length, 0, `Expected no errors for ${field}`)
      }

      // invalid values error
      for (const field of ['linesChanged', 'linesWritten']) {
        for (const [label, value] of [['string', '500'], ['zero', 0], ['negative', -10]]) {
          const { errors } = validateConfig(cfgWithTask({
            name: 'a',
            type: 'script',
            command: 'x',
            when: { [field]: value }
          }))
          assert.ok(errors.some(e => e.includes(`${field} must be a positive number`)),
            `Expected error for ${field}: ${label} (${value})`)
        }
      }
    })

    it('warns when linesWritten is used on a git hook but not linesChanged', () => {
      // linesWritten warns on git hooks
      const written = validateConfig(validConfig({
        hooks: [{
          type: 'git',
          event: 'pre-commit',
          tasks: [{ name: 'a', type: 'script', command: 'x', when: { linesWritten: 500 } }]
        }]
      }))
      assert.strictEqual(written.errors.length, 0)
      assert.ok(written.warnings.some(w => w.includes('linesWritten') && w.includes('git')),
        'Should warn about linesWritten on git hooks')

      // linesChanged does NOT warn on git hooks (git-based now)
      const changed = validateConfig(validConfig({
        hooks: [{
          type: 'git',
          event: 'pre-commit',
          tasks: [{ name: 'a', type: 'script', command: 'x', when: { linesChanged: 500 } }]
        }]
      }))
      assert.strictEqual(changed.errors.length, 0)
      assert.ok(!changed.warnings.some(w => w.includes('linesChanged')),
        'Should NOT warn about linesChanged on git hooks anymore')
    })

    it('validates boolean when-conditions (sourcesModifiedSinceLastRun, sourceFilesEditedThisTurn)', () => {
      // valid booleans pass
      for (const [field, taskBase] of [
        ['sourcesModifiedSinceLastRun', { type: 'agent', prompt: 'review this' }],
        ['sourceFilesEditedThisTurn', { type: 'script', command: 'x' }]
      ]) {
        const { errors } = validateConfig(cfgWithTask({
          name: 'a', ...taskBase, when: { [field]: true }
        }))
        assert.strictEqual(errors.length, 0, `Expected no errors for ${field}: true`)
      }

      // non-booleans error
      for (const field of ['sourcesModifiedSinceLastRun', 'sourceFilesEditedThisTurn']) {
        const { errors } = validateConfig(cfgWithTask({
          name: 'a',
          type: 'script',
          command: 'x',
          when: { [field]: 'yes' }
        }))
        assert.ok(errors.some(e => e.includes(`${field} must be a boolean`)),
          `Expected boolean error for ${field}`)
      }
    })

    it('warns when sourceFilesEditedThisTurn is used on a git hook', () => {
      const { errors, warnings } = validateConfig(validConfig({
        hooks: [{
          type: 'git',
          event: 'pre-commit',
          tasks: [{ name: 'a', type: 'script', command: 'x', when: { sourceFilesEditedThisTurn: true } }]
        }]
      }))
      assert.strictEqual(errors.length, 0)
      assert.ok(warnings.some(w => w.includes('sourceFilesEditedThisTurn') && w.includes('git')))
    })

    it('validates promptType field', () => {
      // skill with any prompt passes
      const validSkill = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'prove-coverage', promptType: 'skill'
      }))
      assert.strictEqual(validSkill.errors.length, 0)

      // string promptType with any prompt passes
      const validStr = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this code', promptType: 'string'
      }))
      assert.strictEqual(validStr.errors.length, 0)

      // invalid promptType value errors
      const badType = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'review this', promptType: 'builtin'
      }))
      assert.ok(badType.errors.some(e => e.includes('promptType must be "string" or "skill"')))

      // skill promptType accepts any string prompt (can't validate file existence at config time)
      const anySkill = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'my-custom-skill', promptType: 'skill'
      }))
      assert.strictEqual(anySkill.errors.length, 0)
    })

    it('validates task-level model field', () => {
      // valid model on agent passes with no warnings
      const valid = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', model: 'haiku'
      }))
      assert.strictEqual(valid.errors.length, 0)
      assert.strictEqual(valid.warnings.length, 0)

      // invalid values: empty string, non-string
      for (const [label, value] of [['empty string', ''], ['number', 42]]) {
        const { errors } = validateConfig(cfgWithTask({
          name: 'a', type: 'agent', prompt: 'Review this', model: value
        }))
        assert.ok(errors.some(e => e.includes('model must be a non-empty string')),
          `Expected error for model: ${label}`)
      }

      // warns on non-agent task
      const { warnings } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', model: 'haiku'
      }))
      assert.ok(warnings.some(w => w.includes('model only applies to agent tasks')))
    })

    it('validates params field', () => {
      // valid object on script task passes
      const valid = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', params: { paths: ['.env'] }
      }))
      assert.strictEqual(valid.errors.length, 0)
      assert.strictEqual(valid.warnings.length, 0)

      // empty object passes
      const empty = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', params: {}
      }))
      assert.strictEqual(empty.errors.length, 0)

      // non-object values error
      for (const [label, value] of [['string', 'bad'], ['array', ['bad']], ['null', null], ['number', 42]]) {
        const { errors } = validateConfig(cfgWithTask({
          name: 'a', type: 'script', command: 'x', params: value
        }))
        assert.ok(errors.some(e => e.includes('params must be a plain object')),
          `Expected plain object error for params: ${label}`)
      }

      // warns on agent task
      const agentWarn = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', params: { foo: 'bar' }
      }))
      assert.ok(agentWarn.warnings.some(w => w.includes('params') && w.includes('script tasks')))

      // warns on env task
      const envWarn = validateConfig(validConfig({
        hooks: [{
          type: 'claude',
          event: 'SessionStart',
          tasks: [{ name: 'a', type: 'env', command: './script/env.sh', params: { foo: 'bar' } }]
        }]
      }))
      assert.ok(envWarn.warnings.some(w => w.includes('params') && w.includes('script tasks')))
    })

    it('validates task-level ruleFile field', () => {
      // valid ruleFile on agent passes with no warnings
      const valid = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', ruleFile: '.claude/rules/testing.md'
      }))
      assert.strictEqual(valid.errors.length, 0)
      assert.strictEqual(valid.warnings.length, 0)

      // invalid values: empty string, non-string
      for (const [label, value] of [['empty string', ''], ['number', 42]]) {
        const { errors } = validateConfig(cfgWithTask({
          name: 'a', type: 'agent', prompt: 'Review this', ruleFile: value
        }))
        assert.ok(errors.some(e => e.includes('ruleFile must be a non-empty string')),
          `Expected error for ruleFile: ${label}`)
      }

      // warns on non-agent task
      const { warnings } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', ruleFile: '.claude/rules/testing.md'
      }))
      assert.ok(warnings.some(w => w.includes('ruleFile only applies to agent tasks')))
    })

    it('validates toolsUsed when key', () => {
      // valid array passes
      const valid = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { toolsUsed: ['XcodeEdit', 'Edit'] }
      }))
      assert.strictEqual(valid.errors.length, 0)

      // not an array errors
      const notArray = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { toolsUsed: 'Edit' }
      }))
      assert.ok(notArray.errors.some(e => e.includes('toolsUsed must be an array')))

      // non-string element errors
      const nonString = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { toolsUsed: ['Edit', 42] }
      }))
      assert.ok(nonString.errors.some(e => e.includes('toolsUsed[1] must be a string')))

      // warns on git hook
      const { warnings } = validateConfig(validConfig({
        hooks: [{
          type: 'git',
          event: 'pre-commit',
          tasks: [{ name: 'a', type: 'script', command: 'x', when: { toolsUsed: ['Edit'] } }]
        }]
      }))
      assert.ok(warnings.some(w => w.includes('toolsUsed') && w.includes('git')))
    })

    it('validates signal when key', () => {
      // valid signal passes
      const valid = validateConfig(cfgWithTask({
        name: 'a',
        type: 'agent',
        prompt: 'Review this',
        when: { signal: 'done' }
      }))
      assert.strictEqual(valid.errors.length, 0)

      // invalid signal value errors
      const bad = validateConfig(cfgWithTask({
        name: 'a',
        type: 'agent',
        prompt: 'Review this',
        when: { signal: 'bogus' }
      }))
      assert.ok(bad.errors.some(e => e.includes('when.signal must be one of')))

      // non-string errors
      const nonString = validateConfig(cfgWithTask({
        name: 'a',
        type: 'agent',
        prompt: 'Review this',
        when: { signal: true }
      }))
      assert.ok(nonString.errors.some(e => e.includes('when.signal must be one of')))
    })

    it('warns when signal is used on wrong event types', () => {
      // git hook
      const { warnings: gitWarnings } = validateConfig(validConfig({
        hooks: [{
          type: 'git',
          event: 'pre-commit',
          tasks: [{ name: 'a', type: 'script', command: 'x', when: { signal: 'done' } }]
        }]
      }))
      assert.ok(gitWarnings.some(w => w.includes('signal') && w.includes('git')))

      // SessionStart
      const { warnings: ssWarnings } = validateConfig(validConfig({
        hooks: [{
          type: 'claude',
          event: 'SessionStart',
          tasks: [{ name: 'a', type: 'script', command: 'x', when: { signal: 'done' } }]
        }]
      }))
      assert.ok(ssWarnings.some(w => w.includes('signal') && w.includes('SessionStart')))

      // PreToolUse
      const { warnings: ptuWarnings } = validateConfig(validConfig({
        hooks: [{
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Bash',
          tasks: [{ name: 'a', type: 'script', command: 'x', when: { signal: 'done' } }]
        }]
      }))
      assert.ok(ptuWarnings.some(w => w.includes('signal') && w.includes('PreToolUse')))
    })

    it('validates variablesPresent when key', () => {
      // valid array passes
      const valid = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { variablesPresent: ['staged_diff', 'session_diff'] }
      }))
      assert.strictEqual(valid.errors.length, 0)

      // not an array errors
      const notArray = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { variablesPresent: 'staged_diff' }
      }))
      assert.ok(notArray.errors.some(e => e.includes('variablesPresent must be an array')))

      // unknown var name errors
      const unknown = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { variablesPresent: ['bogus_var'] }
      }))
      assert.ok(unknown.errors.some(e => e.includes('unknown variable "bogus_var"')))
    })
  })

  describe('top-level taskEnv validation', () => {
    it('passes valid taskEnv configurations', () => {
      // object with string values
      const withValues = validateConfig(validConfig({ taskEnv: { TURBOCOMMIT_DISABLED: '1', MY_VAR: 'hello' } }))
      assert.strictEqual(withValues.errors.length, 0)

      // empty object
      const empty = validateConfig(validConfig({ taskEnv: {} }))
      assert.strictEqual(empty.errors.length, 0)

      // omitted entirely
      const cfg = validConfig()
      delete cfg.taskEnv
      const omitted = validateConfig(cfg)
      assert.strictEqual(omitted.errors.length, 0)

      // key starting with underscore
      const underscore = validateConfig(validConfig({ taskEnv: { _INTERNAL: 'val' } }))
      assert.strictEqual(underscore.errors.length, 0)
    })

    it('errors when taskEnv is not a plain object', () => {
      for (const [label, value] of [['string', 'FOO=bar'], ['array', ['FOO=bar']], ['null', null]]) {
        const { errors } = validateConfig(validConfig({ taskEnv: value }))
        assert.ok(errors.some(e => e.includes('"taskEnv" must be an object')),
          `Expected object error for taskEnv: ${label}`)
      }
    })

    it('errors when taskEnv values are not strings', () => {
      for (const [key, value] of [['PORT', 3000], ['DEBUG', true], ['NESTED', { a: 1 }]]) {
        const { errors } = validateConfig(validConfig({ taskEnv: { [key]: value } }))
        assert.ok(errors.some(e => e.includes(`taskEnv["${key}"] must be a string`)),
          `Expected string error for taskEnv["${key}"]`)
      }
    })

    it('errors when taskEnv key names are invalid', () => {
      for (const [key, value] of [['3PO', 'droid'], ['MY VAR', 'val']]) {
        const { errors } = validateConfig(validConfig({ taskEnv: { [key]: value } }))
        assert.ok(errors.some(e => e.includes(`taskEnv key "${key}" is not a valid environment variable name`)),
          `Expected invalid name error for taskEnv key "${key}"`)
      }
    })
  })

  describe('env task validation', () => {
    function cfgWithEnvTask (task, event = 'SessionStart') {
      return validConfig({
        hooks: [{
          type: 'claude',
          event,
          tasks: [task]
        }]
      })
    }

    it('validates env tasks require command and SessionStart event', () => {
      // passes with command in SessionStart
      const valid = validateConfig(cfgWithEnvTask({
        name: 'setup-env', type: 'env', command: './script/env.sh'
      }))
      assert.strictEqual(valid.errors.length, 0)

      // errors without command
      const noCmd = validateConfig(cfgWithEnvTask({ name: 'setup-env', type: 'env' }))
      assert.ok(noCmd.errors.some(e => e.includes('type "env" but has no "command"')))

      // errors on non-SessionStart hooks
      for (const event of ['Stop', 'PreToolUse']) {
        const { errors } = validateConfig(cfgWithEnvTask({
          name: 'setup-env', type: 'env', command: './script/env.sh'
        }, event))
        assert.ok(errors.some(e => e.includes('env tasks are only valid in SessionStart')),
          `Expected SessionStart-only error for ${event}`)
      }
    })
  })

  describe('edge cases', () => {
    it('errors on non-object config values', () => {
      const nullCfg = validateConfig(null)
      assert.ok(nullCfg.errors.some(e => e.includes('Config must be a JSON object')))

      const stringCfg = validateConfig('string')
      assert.ok(stringCfg.errors.some(e => e.includes('Config must be a JSON object')))
    })

    it('errors on non-object entries in hooks and tasks arrays', () => {
      const badHook = validateConfig({ hooks: ['not-an-object'] })
      assert.ok(badHook.errors.some(e => e.includes('hooks[0] must be an object')))

      const badTask = validateConfig({
        hooks: [{ type: 'claude', event: 'Stop', tasks: ['not-an-object'] }]
      })
      assert.ok(badTask.errors.some(e => e.includes('tasks[0] must be an object')))
    })
  })
})

describe('formatErrors', () => {
  it('formats errors with reinstall/reinit guidance', () => {
    const result = {
      errors: ['hooks[0] has "checks" instead of "tasks"'],
      warnings: []
    }
    const output = formatErrors(result)
    assert.ok(output.includes('prove_it: invalid config'))
    assert.ok(output.includes('hooks[0] has "checks"'))
    assert.ok(output.includes('prove_it reinstall && prove_it reinit'))
  })

  it('indents multi-line errors', () => {
    const result = {
      errors: ['line one\nline two'],
      warnings: []
    }
    const output = formatErrors(result)
    assert.ok(output.includes('  - line one'))
    assert.ok(output.includes('    line two'))
  })
})
