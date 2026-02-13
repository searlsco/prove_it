const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { expandTemplate, makeResolvers, KNOWN_VARS, SESSION_VARS, getUnknownVars, getSessionVars } = require('../lib/template')

describe('template', () => {
  describe('expandTemplate', () => {
    it('returns empty string for null template', () => {
      assert.strictEqual(expandTemplate(null, {}), '')
    })

    it('returns empty string for undefined template', () => {
      assert.strictEqual(expandTemplate(undefined, {}), '')
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

    it('returns empty array for null template', () => {
      assert.deepStrictEqual(getUnknownVars(null), [])
    })

    it('returns empty array for empty string', () => {
      assert.deepStrictEqual(getUnknownVars(''), [])
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

    describe('git resolvers in real repo', () => {
      let tmpDir

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_tpl_'))
        spawnSync('git', ['init'], { cwd: tmpDir })
        spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'initial\n')
        spawnSync('git', ['add', '.'], { cwd: tmpDir })
        spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
      })

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      })

      it('resolves git_head to current commit hash', () => {
        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        const head = resolvers.git_head()
        assert.ok(head.length >= 7, `Should be a commit hash, got: ${head}`)
        assert.ok(/^[0-9a-f]+$/.test(head), `Should be hex, got: ${head}`)
      })

      it('resolves staged_diff for staged changes', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'changed\n')
        spawnSync('git', ['add', 'file.txt'], { cwd: tmpDir })

        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        const diff = resolvers.staged_diff()
        assert.ok(diff.includes('changed'), `staged_diff should contain the change, got: ${diff}`)
      })

      it('resolves staged_files for staged changes', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'changed\n')
        spawnSync('git', ['add', 'file.txt'], { cwd: tmpDir })

        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        const files = resolvers.staged_files()
        assert.ok(files.includes('file.txt'), `staged_files should list file.txt, got: ${files}`)
      })

      it('resolves working_diff for unstaged changes', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'unstaged change\n')

        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        const diff = resolvers.working_diff()
        assert.ok(diff.includes('unstaged change'), `working_diff should contain the change, got: ${diff}`)
      })

      it('resolves changed_files for modified files', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified\n')

        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        const files = resolvers.changed_files()
        assert.ok(files.includes('file.txt'), `changed_files should list file.txt, got: ${files}`)
      })

      it('returns empty string for staged_diff with no staged changes', () => {
        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        assert.strictEqual(resolvers.staged_diff(), '')
      })

      it('returns empty string for working_diff with clean tree', () => {
        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        assert.strictEqual(resolvers.working_diff(), '')
      })

      it('resolves git_status for modified files', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified\n')

        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        const status = resolvers.git_status()
        assert.ok(status.includes('file.txt'), `git_status should list file.txt, got: ${status}`)
      })

      it('returns empty string for git_status with clean tree', () => {
        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        assert.strictEqual(resolvers.git_status(), '')
      })

      it('resolves recently_edited_files for modified source files', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified\n')

        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId: null,
          toolInput: null,
          sources: ['**/*.txt']
        })
        const files = resolvers.recently_edited_files()
        assert.ok(files.includes('file.txt'), `should include file.txt, got: ${files}`)
      })

      it('recently_edited_files filters out non-source files', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified\n')
        fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'docs\n')

        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId: null,
          toolInput: null,
          sources: ['**/*.txt']
        })
        const files = resolvers.recently_edited_files()
        assert.ok(files.includes('file.txt'), `should include file.txt, got: ${files}`)
        assert.ok(!files.includes('readme.md'), `should not include readme.md, got: ${files}`)
      })

      it('recently_edited_files includes untracked new files', () => {
        // Create a new file that hasn't been git add'd
        fs.writeFileSync(path.join(tmpDir, 'brand_new.txt'), 'new stuff\n')

        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId: null,
          toolInput: null,
          sources: ['**/*.txt']
        })
        const files = resolvers.recently_edited_files()
        assert.ok(files.includes('brand_new.txt'), `should include untracked brand_new.txt, got: ${files}`)
      })

      it('recently_edited_files returns empty for clean tree', () => {
        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId: null,
          toolInput: null,
          sources: ['**/*.txt']
        })
        assert.strictEqual(resolvers.recently_edited_files(), '')
      })

      it('resolves sources as newline-separated list', () => {
        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId: null,
          toolInput: null,
          sources: ['**/*.js', '**/*.ts']
        })
        assert.strictEqual(resolvers.sources(), '**/*.js\n**/*.ts')
      })

      it('resolves sources as empty string when null', () => {
        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId: null,
          toolInput: null,
          sources: null
        })
        assert.strictEqual(resolvers.sources(), '')
      })

      it('resolves recent_commits with commit history', () => {
        const resolvers = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
        const commits = resolvers.recent_commits()
        assert.ok(commits.includes('init'), `recent_commits should include 'init' commit, got: ${commits}`)
      })
    })
  })
})
