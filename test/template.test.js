const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { expandTemplate, makeResolvers } = require('../lib/template')

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

  describe('makeResolvers', () => {
    it('returns resolver functions for all expected keys', () => {
      const context = { rootDir: '.', projectDir: '.', sessionId: null, toolInput: null }
      const resolvers = makeResolvers(context)
      const expectedKeys = [
        'staged_diff', 'staged_files', 'working_diff', 'changed_files',
        'session_diffs', 'test_output', 'tool_command', 'file_path',
        'project_dir', 'root_dir', 'session_id', 'git_head'
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
    })
  })
})
