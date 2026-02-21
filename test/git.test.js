const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  sanitizeRefName, computeWriteLines, gitDiffFiles,
  readRef, updateRef
} = require('../lib/git')
const { freshRepo } = require('./helpers')

// ---------- pure functions (no git needed) ----------

describe('sanitizeRefName', () => {
  const cases = [
    ['my-task', 'my-task', 'safe name'],
    ['task_1.0', 'task_1.0', 'safe name with dot'],
    ['my task', 'my_task', 'spaces'],
    ['foo/bar:baz', 'foo_bar_baz', 'slashes and colons'],
    ['', '', 'empty string'],
    [null, '', 'null']
  ]
  cases.forEach(([input, expected, label]) => {
    it(`${label}: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(sanitizeRefName(input), expected)
    })
  })
})

describe('computeWriteLines', () => {
  describe('Write tool', () => {
    const cases = [
      [{ content: 'a\nb\nc' }, 3, 'multi-line'],
      [{ content: 'single' }, 1, 'single line'],
      [{}, 0, 'no content'],
      [{ content: 42 }, 0, 'non-string content'],
      [null, 0, 'null input']
    ]
    cases.forEach(([input, expected, label]) => {
      it(`${label} → ${expected}`, () => {
        assert.strictEqual(computeWriteLines('Write', input), expected)
      })
    })
  })

  describe('Edit tool', () => {
    it('counts old + new lines', () => {
      assert.strictEqual(computeWriteLines('Edit', {
        old_string: 'a\nb',
        new_string: 'c\nd\ne'
      }), 5) // 2 old + 3 new
    })

    it('handles only new_string', () => {
      assert.strictEqual(computeWriteLines('Edit', { new_string: 'a\nb' }), 2)
    })
  })

  describe('NotebookEdit tool', () => {
    it('counts lines for insert', () => {
      assert.strictEqual(computeWriteLines('NotebookEdit', {
        edit_mode: 'insert',
        new_source: 'x = 1\ny = 2'
      }), 2)
    })

    it('counts lines for replace (default mode)', () => {
      assert.strictEqual(computeWriteLines('NotebookEdit', {
        new_source: 'a\nb\nc'
      }), 3)
    })

    it('returns 0 for delete', () => {
      assert.strictEqual(computeWriteLines('NotebookEdit', {
        edit_mode: 'delete',
        new_source: 'ignored'
      }), 0)
    })
  })

  describe('unknown/MCP tools (longest-string heuristic)', () => {
    const cases = [
      [
        'mcp__xcode__edit',
        { file_path: 'src/app.swift', content: 'import UIKit\nclass App {}\n' },
        3, 'picks content field'
      ],
      [
        'mcp__custom__write',
        { path: '/short', sourceText: 'line1\nline2\nline3\nline4\n', encoding: 'utf8' },
        5, 'picks longest string across fields'
      ],
      ['mcp__tool', { count: 42, flag: true }, 0, 'no string values'],
      ['mcp__tool', { file_path: 'x' }, 1, 'short path-like string']
    ]
    cases.forEach(([tool, input, expected, label]) => {
      it(`${label} → ${expected}`, () => {
        assert.strictEqual(computeWriteLines(tool, input), expected)
      })
    })
  })
})

// ---------- thin git wrappers (need repo but test single functions) ----------

function setupFileJs (dir) {
  fs.writeFileSync(path.join(dir, 'file.js'), 'initial\n')
}

function setupDiffFiles (dir) {
  fs.writeFileSync(path.join(dir, 'a.js'), 'original a\n')
  fs.writeFileSync(path.join(dir, 'b.js'), 'original b\n')
  fs.writeFileSync(path.join(dir, 'c.js'), 'original c\n')
}

function getHead (dir) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}

function commit (dir, msg) {
  spawnSync('git', ['add', '.'], { cwd: dir })
  spawnSync('git', ['commit', '-m', msg], { cwd: dir })
}

describe('gitDiffFiles', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupDiffFiles) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('scopes diff to specified files only', () => {
    const head = getHead(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'changed a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'changed b\n')

    const diff = gitDiffFiles(tmpDir, head, ['a.js'])
    assert.ok(diff.includes('changed a'), 'Should include a.js changes')
    assert.ok(!diff.includes('changed b'), 'Should NOT include b.js changes')
  })

  it('includes multiple specified files', () => {
    const head = getHead(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'changed a\n')
    fs.writeFileSync(path.join(tmpDir, 'c.js'), 'changed c\n')

    const diff = gitDiffFiles(tmpDir, head, ['a.js', 'c.js'])
    assert.ok(diff.includes('changed a'))
    assert.ok(diff.includes('changed c'))
  })

  it('returns empty string for no-op inputs', () => {
    const head = getHead(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'changed b\n')

    // No changes in a.js
    assert.strictEqual(gitDiffFiles(tmpDir, head, ['a.js']), '')
    // Null baseHead
    assert.strictEqual(gitDiffFiles(tmpDir, null, ['a.js']), '')
    // Empty files array
    assert.strictEqual(gitDiffFiles(tmpDir, head, []), '')
    // Null files
    assert.strictEqual(gitDiffFiles(tmpDir, head, null), '')
  })
})

describe('readRef / updateRef', () => {
  let tmpDir

  beforeEach(() => { tmpDir = freshRepo(setupFileJs) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('round-trips through create and advance', () => {
    // Non-existent ref → null
    assert.strictEqual(readRef(tmpDir, 'nonexistent'), null)

    // Create ref
    const head1 = getHead(tmpDir)
    updateRef(tmpDir, 'my-task', head1)
    assert.strictEqual(readRef(tmpDir, 'my-task'), head1)

    // Advance ref
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'changed\n')
    commit(tmpDir, 'change')
    const head2 = getHead(tmpDir)
    updateRef(tmpDir, 'my-task', head2)
    assert.strictEqual(readRef(tmpDir, 'my-task'), head2)
    assert.notStrictEqual(head1, head2)
  })
})
