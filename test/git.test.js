const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { gitDiffFiles } = require('../lib/git')

describe('gitDiffFiles', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_gdf_'))
    spawnSync('git', ['init'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'original a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'original b\n')
    fs.writeFileSync(path.join(tmpDir, 'c.js'), 'original c\n')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns diff scoped to specified files only', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'changed a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'changed b\n')

    // Only ask for a.js — should not include b.js changes
    const diff = gitDiffFiles(tmpDir, head, ['a.js'])
    assert.ok(diff.includes('changed a'), 'Should include a.js changes')
    assert.ok(!diff.includes('changed b'), 'Should NOT include b.js changes')
  })

  it('returns empty string when no changes in specified files', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'changed b\n')

    // Only ask for a.js — which hasn't changed
    const diff = gitDiffFiles(tmpDir, head, ['a.js'])
    assert.strictEqual(diff, '')
  })

  it('returns empty string when baseHead is null', () => {
    const diff = gitDiffFiles(tmpDir, null, ['a.js'])
    assert.strictEqual(diff, '')
  })

  it('returns empty string when files array is empty', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'changed\n')
    const diff = gitDiffFiles(tmpDir, head, [])
    assert.strictEqual(diff, '')
  })

  it('returns empty string when files is null', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    const diff = gitDiffFiles(tmpDir, head, null)
    assert.strictEqual(diff, '')
  })

  it('includes multiple specified files', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'changed a\n')
    fs.writeFileSync(path.join(tmpDir, 'c.js'), 'changed c\n')

    const diff = gitDiffFiles(tmpDir, head, ['a.js', 'c.js'])
    assert.ok(diff.includes('changed a'), 'Should include a.js changes')
    assert.ok(diff.includes('changed c'), 'Should include c.js changes')
  })
})
