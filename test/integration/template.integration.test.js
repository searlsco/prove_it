const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { freshRepo } = require('../helpers')
const { makeResolvers } = require('../../lib/template')
const { recordFileEdit, saveSessionState } = require('../../lib/session')

describe('template integration', () => {
  describe('makeResolvers', () => {
    describe('git resolvers in real repo', () => {
      let tmpDir

      beforeEach(() => {
        tmpDir = freshRepo((dir) => {
          fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n')
        })
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

    describe('session_diff git fallback', () => {
      let tmpDir
      let origProveItDir

      beforeEach(() => {
        tmpDir = freshRepo((dir) => {
          fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
          fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'original\n')
        })
        origProveItDir = process.env.PROVE_IT_DIR
        process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
      })

      afterEach(() => {
        if (origProveItDir === undefined) {
          delete process.env.PROVE_IT_DIR
        } else {
          process.env.PROVE_IT_DIR = origProveItDir
        }
        fs.rmSync(tmpDir, { recursive: true, force: true })
      })

      it('produces git diff when file-history is empty but edits are tracked', () => {
        const sessionId = 'test-sdgf-fallback'
        const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
        // Record session baseline with git head
        saveSessionState(sessionId, 'git', { head })
        // Track a file edit
        recordFileEdit(sessionId, 'Edit', 'src/app.js')
        // Modify the file on disk
        fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'changed content\n')

        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId,
          toolInput: null
        })
        const diff = resolvers.session_diff()
        assert.ok(diff.includes('Session changes (git diff)'), `Should use git fallback, got: ${diff}`)
        assert.ok(diff.includes('changed content'), `Should include the change, got: ${diff}`)
      })

      it('returns empty when no edits tracked', () => {
        const sessionId = 'test-sdgf-no-edits'
        const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
        saveSessionState(sessionId, 'git', { head })

        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId,
          toolInput: null
        })
        assert.strictEqual(resolvers.session_diff(), '')
      })

      it('uses last_stop_head over baseline when available', () => {
        const sessionId = 'test-sdgf-checkpoint'
        const initialHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
        saveSessionState(sessionId, 'git', { head: initialHead })

        // Make a commit to create a new HEAD
        fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'mid-session change\n')
        spawnSync('git', ['add', '.'], { cwd: tmpDir })
        spawnSync('git', ['commit', '-m', 'mid-session'], { cwd: tmpDir })
        const checkpointHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
        saveSessionState(sessionId, 'last_stop_head', checkpointHead)

        // Now make another change
        fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'post-checkpoint change\n')
        recordFileEdit(sessionId, 'Edit', 'src/app.js')

        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId,
          toolInput: null
        })
        const diff = resolvers.session_diff()
        assert.ok(diff.includes('post-checkpoint'), `Should diff from checkpoint, got: ${diff}`)
        assert.ok(!diff.includes('original'), `Should NOT include pre-checkpoint changes, got: ${diff}`)
      })

      it('returns empty when no baseHead available', () => {
        const sessionId = 'test-sdgf-no-base'
        recordFileEdit(sessionId, 'Edit', 'src/app.js')
        fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'changed\n')

        const resolvers = makeResolvers({
          rootDir: tmpDir,
          projectDir: tmpDir,
          sessionId,
          toolInput: null
        })
        assert.strictEqual(resolvers.session_diff(), '')
      })
    })
  })
})
