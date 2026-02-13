const { describe, it } = require('node:test')
const assert = require('node:assert')
const builtins = require('../lib/checks/builtins')

describe('builtins', () => {
  describe('config:lock', () => {
    const configLock = builtins['config:lock']

    it('blocks Edit to prove_it.json', () => {
      const result = configLock({}, {
        toolName: 'Edit',
        toolInput: { file_path: '.claude/prove_it.json', old_string: 'a', new_string: 'b' }
      })
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('Cannot modify'))
    })

    it('blocks Write to prove_it.local.json', () => {
      const result = configLock({}, {
        toolName: 'Write',
        toolInput: { file_path: '/some/path/.claude/prove_it.local.json', content: '{}' }
      })
      assert.strictEqual(result.pass, false)
    })

    it('blocks Bash redirect to prove_it.json', () => {
      const result = configLock({}, {
        toolName: 'Bash',
        toolInput: { command: "echo '{}' > .claude/prove_it.json" }
      })
      assert.strictEqual(result.pass, false)
    })

    it('blocks Bash tee to prove_it config', () => {
      const result = configLock({}, {
        toolName: 'Bash',
        toolInput: { command: 'echo stuff | tee .claude/prove_it.local.json' }
      })
      assert.strictEqual(result.pass, false)
    })

    it('allows Edit to other files', () => {
      const result = configLock({}, {
        toolName: 'Edit',
        toolInput: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows Write to other files', () => {
      const result = configLock({}, {
        toolName: 'Write',
        toolInput: { file_path: 'src/app.js', content: 'code' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows Bash without redirect', () => {
      const result = configLock({}, {
        toolName: 'Bash',
        toolInput: { command: 'git status' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows non-gated tools', () => {
      const result = configLock({}, {
        toolName: 'Read',
        toolInput: { file_path: '.claude/prove_it.json' }
      })
      assert.strictEqual(result.pass, true)
    })
  })

  describe('BUILTIN_PROMPTS', () => {
    const { BUILTIN_PROMPTS } = builtins

    it('has review:commit_quality prompt', () => {
      assert.strictEqual(typeof BUILTIN_PROMPTS['review:commit_quality'], 'string')
      assert.ok(BUILTIN_PROMPTS['review:commit_quality'].length > 0)
      assert.ok(BUILTIN_PROMPTS['review:commit_quality'].includes('{{staged_diff}}'),
        'commit_quality prompt should contain {{staged_diff}}')
      assert.ok(BUILTIN_PROMPTS['review:commit_quality'].includes('{{recent_commits}}'),
        'commit_quality prompt should contain {{recent_commits}}')
      assert.ok(BUILTIN_PROMPTS['review:commit_quality'].includes('{{git_status}}'),
        'commit_quality prompt should contain {{git_status}}')
    })

    it('has review:test_coverage prompt', () => {
      assert.strictEqual(typeof BUILTIN_PROMPTS['review:test_coverage'], 'string')
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].length > 0)
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].includes('{{recently_edited_files}}'),
        'test_coverage prompt should contain {{recently_edited_files}}')
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].includes('{{#session_diff}}'),
        'test_coverage prompt should contain {{#session_diff}} conditional block')
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].includes('{{recent_commits}}'),
        'test_coverage prompt should contain {{recent_commits}}')
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].includes('{{git_status}}'),
        'test_coverage prompt should contain {{git_status}}')
    })
  })

  describe('exports all expected builtins', () => {
    const expectedFunctions = [
      'config:lock'
    ]

    for (const name of expectedFunctions) {
      it(`exports ${name} as function`, () => {
        assert.strictEqual(typeof builtins[name], 'function', `Missing builtin: ${name}`)
      })
    }

    it('does not export review builtins as functions', () => {
      assert.notStrictEqual(typeof builtins['review:commit_quality'], 'function')
      assert.notStrictEqual(typeof builtins['review:test_coverage'], 'function')
    })

    it('exports BUILTIN_PROMPTS object', () => {
      assert.strictEqual(typeof builtins.BUILTIN_PROMPTS, 'object')
      assert.ok(builtins.BUILTIN_PROMPTS !== null)
    })
  })
})
