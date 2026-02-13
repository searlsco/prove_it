const { describe, it } = require('node:test')
const assert = require('node:assert')
const { validateConfig, formatErrors, CURRENT_VERSION } = require('../lib/validate')

describe('validateConfig', () => {
  function validConfig (overrides = {}) {
    return {
      configVersion: 3,
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

  describe('version checks', () => {
    it('passes with current version', () => {
      const { errors } = validateConfig(validConfig())
      assert.strictEqual(errors.length, 0)
    })

    it('errors on missing configVersion', () => {
      const cfg = validConfig()
      delete cfg.configVersion
      const { errors } = validateConfig(cfg)
      assert.strictEqual(errors.length, 1)
      assert.ok(errors[0].includes('Missing "configVersion"'))
    })

    it('errors on v2 with coaching message', () => {
      const { errors } = validateConfig(validConfig({ configVersion: 2 }))
      assert.strictEqual(errors.length, 1)
      assert.ok(errors[0].includes('version 3 is now required'))
      assert.ok(errors[0].includes('"checks" was renamed to "tasks"'))
      assert.ok(errors[0].includes('"mode" was removed'))
    })

    it('errors on unknown version', () => {
      const { errors } = validateConfig(validConfig({ configVersion: 99 }))
      assert.strictEqual(errors.length, 1)
      assert.ok(errors[0].includes('99'))
      assert.ok(errors[0].includes(`${CURRENT_VERSION}`))
    })

    it('short-circuits on wrong version (no structural errors)', () => {
      const { errors } = validateConfig({ configVersion: 2, hooks: 'not-an-array' })
      assert.strictEqual(errors.length, 1)
      assert.ok(errors[0].includes('version 3'))
    })
  })

  describe('top-level validation', () => {
    it('errors when enabled is not boolean', () => {
      const { errors } = validateConfig(validConfig({ enabled: 'yes' }))
      assert.ok(errors.some(e => e.includes('"enabled" must be a boolean')))
    })

    it('errors when sources is not array', () => {
      const { errors } = validateConfig(validConfig({ sources: 'not-array' }))
      assert.ok(errors.some(e => e.includes('"sources" must be an array')))
    })

    it('errors when sources contains non-string', () => {
      const { errors } = validateConfig(validConfig({ sources: ['ok', 42] }))
      assert.ok(errors.some(e => e.includes('sources[1] must be a string')))
    })

    it('allows sources to be null', () => {
      const { errors } = validateConfig(validConfig({ sources: null }))
      assert.strictEqual(errors.length, 0)
    })

    it('errors when format is not object', () => {
      const { errors } = validateConfig(validConfig({ format: 'bad' }))
      assert.ok(errors.some(e => e.includes('"format" must be an object')))
    })

    it('errors when maxOutputChars is not positive number', () => {
      const { errors } = validateConfig(validConfig({ format: { maxOutputChars: -1 } }))
      assert.ok(errors.some(e => e.includes('maxOutputChars must be a positive number')))
    })

    it('errors on legacy mode key', () => {
      const cfg = validConfig()
      cfg.mode = 'strict'
      const { errors } = validateConfig(cfg)
      assert.ok(errors.some(e => e.includes('"mode" was removed')))
    })

    it('errors on legacy checks key at top level', () => {
      const cfg = validConfig()
      cfg.checks = []
      const { errors } = validateConfig(cfg)
      assert.ok(errors.some(e => e.includes('Top-level "checks" is not valid')))
    })

    it('errors on unknown top-level keys', () => {
      const cfg = validConfig()
      cfg.customThing = true
      const { errors } = validateConfig(cfg)
      assert.ok(errors.some(e => e.includes('Unknown key "customThing"')))
    })

    it('errors when hooks is missing', () => {
      const cfg = validConfig()
      delete cfg.hooks
      const { errors } = validateConfig(cfg)
      assert.ok(errors.some(e => e.includes('"hooks" is required')))
    })

    it('errors when hooks is not array', () => {
      const { errors } = validateConfig(validConfig({ hooks: {} }))
      assert.ok(errors.some(e => e.includes('"hooks" must be an array')))
    })
  })

  describe('hook entry validation', () => {
    function cfgWith (hookEntry) {
      return validConfig({ hooks: [hookEntry] })
    }

    it('errors on missing type', () => {
      const { errors } = validateConfig(cfgWith({ event: 'Stop', tasks: [] }))
      assert.ok(errors.some(e => e.includes('missing "type"')))
    })

    it('errors on invalid type', () => {
      const { errors } = validateConfig(cfgWith({ type: 'webhook', event: 'Stop', tasks: [] }))
      assert.ok(errors.some(e => e.includes('invalid type "webhook"')))
    })

    it('errors on missing event', () => {
      const { errors } = validateConfig(cfgWith({ type: 'claude', tasks: [] }))
      assert.ok(errors.some(e => e.includes('missing "event"')))
    })

    it('errors on invalid claude event', () => {
      const { errors } = validateConfig(cfgWith({ type: 'claude', event: 'OnSave', tasks: [] }))
      assert.ok(errors.some(e => e.includes('invalid claude event "OnSave"')))
    })

    it('errors on invalid git event', () => {
      const { errors } = validateConfig(cfgWith({ type: 'git', event: 'post-merge', tasks: [] }))
      assert.ok(errors.some(e => e.includes('invalid git event "post-merge"')))
    })

    it('errors on legacy checks key', () => {
      const { errors } = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', checks: [{ name: 'a', type: 'script', command: 'x' }]
      }))
      assert.ok(errors.some(e => e.includes('"checks" instead of "tasks"')))
    })

    it('errors on missing tasks', () => {
      const { errors } = validateConfig(cfgWith({ type: 'claude', event: 'Stop' }))
      assert.ok(errors.some(e => e.includes('missing "tasks"')))
    })

    it('warns on matcher with non-PreToolUse event', () => {
      const { warnings } = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', matcher: 'Edit', tasks: []
      }))
      assert.ok(warnings.some(w => w.includes('matcher only applies to PreToolUse')))
    })

    it('warns on triggers with non-PreToolUse event', () => {
      const { warnings } = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', triggers: ['npm'], tasks: []
      }))
      assert.ok(warnings.some(w => w.includes('triggers only applies to PreToolUse')))
    })

    it('warns on source with non-SessionStart event', () => {
      const { warnings } = validateConfig(cfgWith({
        type: 'claude', event: 'Stop', source: 'startup', tasks: []
      }))
      assert.ok(warnings.some(w => w.includes('source only applies to SessionStart')))
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

    it('errors on missing name', () => {
      const { errors } = validateConfig(cfgWithTask({ type: 'script', command: 'x' }))
      assert.ok(errors.some(e => e.includes('missing "name"')))
    })

    it('errors on missing type', () => {
      const { errors } = validateConfig(cfgWithTask({ name: 'a' }))
      assert.ok(errors.some(e => e.includes('missing "type"')))
    })

    it('errors on invalid type', () => {
      const { errors } = validateConfig(cfgWithTask({ name: 'a', type: 'webhook' }))
      assert.ok(errors.some(e => e.includes('invalid type "webhook"')))
    })

    it('errors on script without command', () => {
      const { errors } = validateConfig(cfgWithTask({ name: 'a', type: 'script' }))
      assert.ok(errors.some(e => e.includes('type "script" but has no "command"')))
    })

    it('errors on agent without prompt', () => {
      const { errors } = validateConfig(cfgWithTask({ name: 'a', type: 'agent' }))
      assert.ok(errors.some(e => e.includes('type "agent" but has no "prompt"')))
    })

    it('passes agent with prompt and optional command', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', command: 'codex exec -'
      }))
      assert.strictEqual(errors.length, 0)
    })

    it('errors on invalid when keys', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { badKey: 'val' }
      }))
      assert.ok(errors.some(e => e.includes('when has unknown key "badKey"')))
    })

    it('errors on non-string when values', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { fileExists: 42 }
      }))
      assert.ok(errors.some(e => e.includes('when.fileExists must be a string')))
    })

    it('errors on non-positive timeout', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', timeout: 0
      }))
      assert.ok(errors.some(e => e.includes('timeout must be a positive number')))
    })

    it('errors on non-boolean mtime', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', mtime: 'yes'
      }))
      assert.ok(errors.some(e => e.includes('mtime must be a boolean')))
    })

    it('errors on unknown task keys', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', extraKey: true
      }))
      assert.ok(errors.some(e => e.includes('unknown key "extraKey"')))
    })

    it('passes valid when conditions', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { fileExists: '.config', envSet: 'CI', envNotSet: 'SKIP' }
      }))
      assert.strictEqual(errors.length, 0)
    })

    it('passes linesWrittenSinceLastRun as valid when key', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'agent',
        prompt: 'review this',
        command: 'prove_it run_builtin review:test_investment',
        when: { linesWrittenSinceLastRun: 500 }
      }))
      assert.strictEqual(errors.length, 0)
    })

    it('errors when linesWrittenSinceLastRun is not a number', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { linesWrittenSinceLastRun: '500' }
      }))
      assert.ok(errors.some(e => e.includes('linesWrittenSinceLastRun must be a positive number')))
    })

    it('errors when linesWrittenSinceLastRun is zero', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { linesWrittenSinceLastRun: 0 }
      }))
      assert.ok(errors.some(e => e.includes('linesWrittenSinceLastRun must be a positive number')))
    })

    it('errors when linesWrittenSinceLastRun is negative', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { linesWrittenSinceLastRun: -10 }
      }))
      assert.ok(errors.some(e => e.includes('linesWrittenSinceLastRun must be a positive number')))
    })

    it('warns when linesWrittenSinceLastRun is used on a git hook', () => {
      const { errors, warnings } = validateConfig(validConfig({
        hooks: [{
          type: 'git',
          event: 'pre-commit',
          tasks: [{
            name: 'a',
            type: 'script',
            command: 'x',
            when: { linesWrittenSinceLastRun: 500 }
          }]
        }]
      }))
      assert.strictEqual(errors.length, 0)
      assert.ok(warnings.some(w => w.includes('linesWrittenSinceLastRun') && w.includes('git')))
    })

    it('passes agent with promptType reference and valid reference', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'review:commit_quality', promptType: 'reference'
      }))
      assert.strictEqual(errors.length, 0)
    })

    it('errors on invalid promptType value', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'review this', promptType: 'builtin'
      }))
      assert.ok(errors.some(e => e.includes('promptType must be "string" or "reference"')))
    })

    it('errors on promptType reference with unknown prompt reference', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'nonexistent:builtin', promptType: 'reference'
      }))
      assert.ok(errors.some(e => e.includes('references unknown builtin "nonexistent:builtin"')))
    })

    it('passes promptType string with any prompt value', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this code', promptType: 'string'
      }))
      assert.strictEqual(errors.length, 0)
    })

    it('passes agent with model field', () => {
      const { errors, warnings } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', model: 'haiku'
      }))
      assert.strictEqual(errors.length, 0)
      assert.strictEqual(warnings.length, 0)
    })

    it('errors when model is empty string', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', model: ''
      }))
      assert.ok(errors.some(e => e.includes('model must be a non-empty string')))
    })

    it('errors when model is not a string', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', model: 42
      }))
      assert.ok(errors.some(e => e.includes('model must be a non-empty string')))
    })

    it('warns when model is used on non-agent task', () => {
      const { errors, warnings } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', model: 'haiku'
      }))
      assert.strictEqual(errors.length, 0)
      assert.ok(warnings.some(w => w.includes('model only applies to agent tasks')))
    })

    it('passes agent with ruleFile field', () => {
      const { errors, warnings } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', ruleFile: '.claude/rules/testing.md'
      }))
      assert.strictEqual(errors.length, 0)
      assert.strictEqual(warnings.length, 0)
    })

    it('errors when ruleFile is empty string', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', ruleFile: ''
      }))
      assert.ok(errors.some(e => e.includes('ruleFile must be a non-empty string')))
    })

    it('errors when ruleFile is not a string', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a', type: 'agent', prompt: 'Review this', ruleFile: 42
      }))
      assert.ok(errors.some(e => e.includes('ruleFile must be a non-empty string')))
    })

    it('warns when ruleFile is used on non-agent task', () => {
      const { errors, warnings } = validateConfig(cfgWithTask({
        name: 'a', type: 'script', command: 'x', ruleFile: '.claude/rules/testing.md'
      }))
      assert.strictEqual(errors.length, 0)
      assert.ok(warnings.some(w => w.includes('ruleFile only applies to agent tasks')))
    })

    it('passes variablesPresent as valid array', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { variablesPresent: ['staged_diff', 'session_diff'] }
      }))
      assert.strictEqual(errors.length, 0)
    })

    it('errors when variablesPresent is not array', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { variablesPresent: 'staged_diff' }
      }))
      assert.ok(errors.some(e => e.includes('variablesPresent must be an array')))
    })

    it('errors when variablesPresent contains unknown var name', () => {
      const { errors } = validateConfig(cfgWithTask({
        name: 'a',
        type: 'script',
        command: 'x',
        when: { variablesPresent: ['bogus_var'] }
      }))
      assert.ok(errors.some(e => e.includes('unknown variable "bogus_var"')))
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

    it('passes env task with command in SessionStart', () => {
      const { errors } = validateConfig(cfgWithEnvTask({
        name: 'setup-env', type: 'env', command: './script/env.sh'
      }))
      assert.strictEqual(errors.length, 0)
    })

    it('errors on env task without command', () => {
      const { errors } = validateConfig(cfgWithEnvTask({
        name: 'setup-env', type: 'env'
      }))
      assert.ok(errors.some(e => e.includes('type "env" but has no "command"')))
    })

    it('errors on env task in Stop hook', () => {
      const { errors } = validateConfig(cfgWithEnvTask({
        name: 'setup-env', type: 'env', command: './script/env.sh'
      }, 'Stop'))
      assert.ok(errors.some(e => e.includes('env tasks are only valid in SessionStart')))
    })

    it('errors on env task in PreToolUse hook', () => {
      const { errors } = validateConfig(cfgWithEnvTask({
        name: 'setup-env', type: 'env', command: './script/env.sh'
      }, 'PreToolUse'))
      assert.ok(errors.some(e => e.includes('env tasks are only valid in SessionStart')))
    })
  })

  describe('edge cases', () => {
    it('errors on null config', () => {
      const { errors } = validateConfig(null)
      assert.ok(errors.some(e => e.includes('Config must be a JSON object')))
    })

    it('errors on non-object config', () => {
      const { errors } = validateConfig('string')
      assert.ok(errors.some(e => e.includes('Config must be a JSON object')))
    })

    it('errors on non-object hook entry', () => {
      const { errors } = validateConfig({
        configVersion: 3, hooks: ['not-an-object']
      })
      assert.ok(errors.some(e => e.includes('hooks[0] must be an object')))
    })

    it('errors on non-object task', () => {
      const { errors } = validateConfig({
        configVersion: 3,
        hooks: [{ type: 'claude', event: 'Stop', tasks: ['not-an-object'] }]
      })
      assert.ok(errors.some(e => e.includes('tasks[0] must be an object')))
    })
  })
})

describe('formatErrors', () => {
  it('formats errors with coaching message', () => {
    const result = {
      errors: ['hooks[0] has "checks" instead of "tasks"'],
      warnings: []
    }
    const output = formatErrors(result)
    assert.ok(output.includes('prove_it: invalid config'))
    assert.ok(output.includes('hooks[0] has "checks"'))
    assert.ok(output.includes('Fix these errors'))
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

describe('CURRENT_VERSION', () => {
  it('is 3', () => {
    assert.strictEqual(CURRENT_VERSION, 3)
  })
})
