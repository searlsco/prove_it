const { describe, it } = require('node:test')
const assert = require('node:assert')
const { expandTemplate, makeResolvers, KNOWN_VARS, SESSION_VARS, getUnknownVars, getSessionVars } = require('../lib/template')

describe('template', () => {
  describe('expandTemplate', () => {
    ;[
      ['null', null],
      ['undefined', undefined]
    ].forEach(([label, input]) => {
      it(`returns empty string for ${label}`, () => {
        assert.strictEqual(expandTemplate(input, {}), '')
      })
    })

    it('returns template unchanged when no variables', () => {
      assert.strictEqual(expandTemplate('hello world', {}), 'hello world')
    })

    it('expands known variables', () => {
      const context = { projectDir: '/foo/bar', rootDir: '/foo', toolInput: null, sessionId: null }
      const result = expandTemplate('dir: {{project_dir}}', context)
      assert.strictEqual(result, 'dir: /foo/bar')
    })

    it('leaves unknown variables as-is', () => {
      const result = expandTemplate('{{unknown_var}}', {})
      assert.strictEqual(result, '{{unknown_var}}')
    })

    it('expands multiple variables', () => {
      const context = { projectDir: '/proj', rootDir: '/root', sessionId: 'sess-1', toolInput: null }
      const result = expandTemplate('{{project_dir}} {{session_id}}', context)
      assert.strictEqual(result, '/proj sess-1')
    })

    it('expands tool_command from toolInput', () => {
      const context = { toolInput: { command: 'git commit -m "hi"' }, rootDir: '.', projectDir: '.', sessionId: null }
      const result = expandTemplate('cmd: {{tool_command}}', context)
      assert.strictEqual(result, 'cmd: git commit -m "hi"')
    })

    it('expands file_path from toolInput', () => {
      const context = { toolInput: { file_path: 'src/app.js' }, rootDir: '.', projectDir: '.', sessionId: null }
      const result = expandTemplate('path: {{file_path}}', context)
      assert.strictEqual(result, 'path: src/app.js')
    })

    it('expands test_output from context', () => {
      const context = { testOutput: 'PASS: all good', rootDir: '.', projectDir: '.', sessionId: null, toolInput: null }
      const result = expandTemplate('output: {{test_output}}', context)
      assert.strictEqual(result, 'output: PASS: all good')
    })
  })

  describe('conditional blocks', () => {
    it('includes block content when variable is non-empty', () => {
      const context = { projectDir: '/proj', rootDir: '/root', sessionId: 'sess-1', toolInput: null }
      const result = expandTemplate('before\n{{#session_id}}has session: {{session_id}}{{/session_id}}\nafter', context)
      assert.ok(result.includes('has session: sess-1'), `Expected block content, got: ${result}`)
      assert.ok(result.includes('before'))
      assert.ok(result.includes('after'))
    })

    it('strips block when variable is empty', () => {
      const context = { projectDir: '/proj', rootDir: '/root', sessionId: null, toolInput: null }
      const result = expandTemplate('before\n{{#session_id}}has session: {{session_id}}{{/session_id}}\nafter', context)
      assert.ok(!result.includes('has session'), `Expected block stripped, got: ${result}`)
      assert.ok(result.includes('before'))
      assert.ok(result.includes('after'))
    })

    it('expands inner variables inside block', () => {
      const context = { projectDir: '/proj', rootDir: '/root', sessionId: 'sess-1', toolInput: null }
      const result = expandTemplate('{{#project_dir}}dir={{project_dir}} id={{session_id}}{{/project_dir}}', context)
      assert.strictEqual(result, 'dir=/proj id=sess-1')
    })

    it('strips block for unknown variable', () => {
      const context = { projectDir: '/proj', rootDir: '/root', sessionId: null, toolInput: null }
      const result = expandTemplate('a{{#bogus_var}}content{{/bogus_var}}b', context)
      assert.strictEqual(result, 'ab')
    })

    it('handles block alongside regular variables', () => {
      const context = { projectDir: '/proj', rootDir: '/root', sessionId: null, toolInput: null }
      const result = expandTemplate('dir={{project_dir}}\n{{#session_id}}session={{session_id}}{{/session_id}}\ndone', context)
      assert.ok(result.includes('dir=/proj'), `Expected project_dir expanded, got: ${result}`)
      assert.ok(!result.includes('session='), `Expected session block stripped, got: ${result}`)
      assert.ok(result.includes('done'))
    })
  })

  describe('KNOWN_VARS', () => {
    it('has all 16 expected keys', () => {
      const expected = [
        'staged_diff', 'staged_files', 'working_diff', 'changed_files',
        'session_diff', 'test_output', 'tool_command', 'file_path',
        'project_dir', 'root_dir', 'session_id', 'git_head',
        'git_status', 'recent_commits', 'recently_edited_files', 'sources'
      ]
      assert.deepStrictEqual(KNOWN_VARS, expected)
    })

    it('matches the keys returned by makeResolvers', () => {
      const context = { rootDir: '.', projectDir: '.', sessionId: null, toolInput: null }
      const resolvers = makeResolvers(context)
      const resolverKeys = Object.keys(resolvers).sort()
      const knownSorted = [...KNOWN_VARS].sort()
      assert.deepStrictEqual(resolverKeys, knownSorted)
    })
  })

  describe('SESSION_VARS', () => {
    it('contains session_diff and session_id', () => {
      assert.deepStrictEqual(SESSION_VARS, ['session_diff', 'session_id'])
    })

    it('is a subset of KNOWN_VARS', () => {
      for (const v of SESSION_VARS) {
        assert.ok(KNOWN_VARS.includes(v), `${v} should be in KNOWN_VARS`)
      }
    })
  })

  describe('getSessionVars', () => {
    it('returns session vars used in template', () => {
      assert.deepStrictEqual(getSessionVars('Review {{session_diff}}'), ['session_diff'])
    })

    it('returns both session vars when both used', () => {
      assert.deepStrictEqual(getSessionVars('{{session_id}} {{session_diff}}'), ['session_id', 'session_diff'])
    })

    it('returns empty array when no session vars', () => {
      assert.deepStrictEqual(getSessionVars('{{staged_diff}} {{project_dir}}'), [])
    })

    it('returns empty array for null template', () => {
      assert.deepStrictEqual(getSessionVars(null), [])
    })

    it('deduplicates', () => {
      assert.deepStrictEqual(getSessionVars('{{session_diff}} {{session_diff}}'), ['session_diff'])
    })

    it('finds session vars in conditional block tags', () => {
      assert.deepStrictEqual(getSessionVars('{{#session_diff}}content{{/session_diff}}'), ['session_diff'])
    })
  })

  describe('getUnknownVars', () => {
    it('returns unknown variable names', () => {
      assert.deepStrictEqual(getUnknownVars('{{bogus}} and {{fake}}'), ['bogus', 'fake'])
    })

    it('returns empty array for known variables', () => {
      assert.deepStrictEqual(getUnknownVars('{{staged_diff}} {{project_dir}}'), [])
    })

    it('deduplicates repeated unknowns', () => {
      assert.deepStrictEqual(getUnknownVars('{{bogus}} {{bogus}}'), ['bogus'])
    })

    ;[
      ['null', null],
      ['empty string', '']
    ].forEach(([label, input]) => {
      it(`returns empty array for ${label}`, () => {
        assert.deepStrictEqual(getUnknownVars(input), [])
      })
    })

    it('handles mix of known and unknown', () => {
      assert.deepStrictEqual(getUnknownVars('{{staged_diff}} {{typo}}'), ['typo'])
    })

    it('finds unknown vars in conditional block tags', () => {
      assert.deepStrictEqual(getUnknownVars('{{#bogus}}content{{/bogus}}'), ['bogus'])
    })

    it('does not flag known vars in conditional block tags', () => {
      assert.deepStrictEqual(getUnknownVars('{{#session_diff}}content{{/session_diff}}'), [])
    })
  })

  describe('makeResolvers', () => {
    it('returns resolver functions for all expected keys', () => {
      const context = { rootDir: '.', projectDir: '.', sessionId: null, toolInput: null }
      const resolvers = makeResolvers(context)
      const expectedKeys = [
        'staged_diff', 'staged_files', 'working_diff', 'changed_files',
        'session_diff', 'test_output', 'tool_command', 'file_path',
        'project_dir', 'root_dir', 'session_id', 'git_head',
        'git_status', 'recent_commits', 'recently_edited_files', 'sources'
      ]
      for (const key of expectedKeys) {
        assert.strictEqual(typeof resolvers[key], 'function', `Missing resolver: ${key}`)
      }
    })

    it('caches resolved values (lazy evaluation)', () => {
      const context = { rootDir: '.', projectDir: '/proj', sessionId: 'test', toolInput: null }
      const resolvers = makeResolvers(context)
      const first = resolvers.project_dir()
      const second = resolvers.project_dir()
      assert.strictEqual(first, second)
      assert.strictEqual(first, '/proj')
    })
  })
})
