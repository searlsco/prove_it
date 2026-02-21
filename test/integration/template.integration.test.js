const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { freshRepo } = require('../helpers')
const { makeResolvers } = require('../../lib/template')
const { recordFileEdit, saveSessionState } = require('../../lib/session')

describe('template integration', () => {
  // ---------- Story: git resolvers — clean tree ----------
  describe('git resolvers — clean tree', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = freshRepo((dir) => {
        fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n')
      })
    })
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

    it('resolves head, returns empty for staged/working diffs and status', () => {
      const r = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })

      // git_head
      const head = r.git_head()
      assert.ok(head.length >= 7 && /^[0-9a-f]+$/.test(head))

      // Empty on clean tree
      assert.strictEqual(r.staged_diff(), '')
      assert.strictEqual(r.working_diff(), '')
      assert.strictEqual(r.git_status(), '')

      // recent_commits includes init
      assert.ok(r.recent_commits().includes('init'))

      // sources
      const rs = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, sources: ['**/*.js', '**/*.ts'] })
      assert.strictEqual(rs.sources(), '**/*.js\n**/*.ts')
      const rn = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, sources: null })
      assert.strictEqual(rn.sources(), '')

      // recently_edited_files empty on clean tree
      const re = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, sources: ['**/*.txt'] })
      assert.strictEqual(re.recently_edited_files(), '')
    })
  })

  // ---------- Story: git resolvers — dirty tree ----------
  describe('git resolvers — dirty tree', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = freshRepo((dir) => {
        fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n')
      })
    })
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

    it('resolves staged/working diffs, changed_files, status, and recently_edited', () => {
      // Stage a change
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'changed\n')
      spawnSync('git', ['add', 'file.txt'], { cwd: tmpDir })

      const r = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
      assert.ok(r.staged_diff().includes('changed'))
      assert.ok(r.staged_files().includes('file.txt'))

      // Unstaged change
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'unstaged change\n')
      const r2 = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null })
      assert.ok(r2.working_diff().includes('unstaged change'))
      assert.ok(r2.changed_files().includes('file.txt'))
      assert.ok(r2.git_status().includes('file.txt'))

      // recently_edited_files: modified + untracked, filtered by source glob
      fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'docs\n')
      fs.writeFileSync(path.join(tmpDir, 'brand_new.txt'), 'new stuff\n')
      const r3 = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: null, toolInput: null, sources: ['**/*.txt'] })
      const recent = r3.recently_edited_files()
      assert.ok(recent.includes('file.txt'))
      assert.ok(recent.includes('brand_new.txt'))
      assert.ok(!recent.includes('readme.md'))
    })
  })

  // ---------- Story: session_diff fallback ----------
  describe('session_diff fallback', () => {
    let tmpDir, origProveItDir

    beforeEach(() => {
      tmpDir = freshRepo((dir) => {
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'original\n')
      })
      origProveItDir = process.env.PROVE_IT_DIR
      process.env.PROVE_IT_DIR = path.join(tmpDir, 'prove_it_state')
    })

    afterEach(() => {
      if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
      else process.env.PROVE_IT_DIR = origProveItDir
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('git diff fallback, empty when no edits, checkpoint, empty when no base', () => {
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()

      // Edits tracked → git diff
      const sid1 = 'test-sdgf-fallback'
      saveSessionState(sid1, 'git', { head })
      recordFileEdit(sid1, 'Edit', 'src/app.js')
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'changed content\n')
      const d1 = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: sid1, toolInput: null }).session_diff()
      assert.ok(d1.includes('Session changes (git diff)'))
      assert.ok(d1.includes('changed content'))

      // No edits → empty
      const sid2 = 'test-sdgf-no-edits'
      saveSessionState(sid2, 'git', { head })
      assert.strictEqual(makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: sid2, toolInput: null }).session_diff(), '')

      // Checkpoint: uses last_stop_head
      const sid3 = 'test-sdgf-checkpoint'
      saveSessionState(sid3, 'git', { head })
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'mid-session\n')
      spawnSync('git', ['add', '.'], { cwd: tmpDir })
      spawnSync('git', ['commit', '-m', 'mid'], { cwd: tmpDir })
      const cpHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
      saveSessionState(sid3, 'last_stop_head', cpHead)
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'post-checkpoint\n')
      recordFileEdit(sid3, 'Edit', 'src/app.js')
      const d3 = makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: sid3, toolInput: null }).session_diff()
      assert.ok(d3.includes('post-checkpoint'))
      assert.ok(!d3.includes('original'))

      // No base → empty
      const sid4 = 'test-sdgf-no-base'
      recordFileEdit(sid4, 'Edit', 'src/app.js')
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'changed\n')
      assert.strictEqual(makeResolvers({ rootDir: tmpDir, projectDir: tmpDir, sessionId: sid4, toolInput: null }).session_diff(), '')
    })
  })
})
