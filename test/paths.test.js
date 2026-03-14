const { describe, it } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const {
  sessionsDir,
  sessionDir,
  backchannelDir,
  backchannelReadmePath,
  backchannelPrefix,
  notepadDir,
  notepadFilePath
} = require('../lib/paths')

describe('paths', () => {
  const root = '/project'
  const sid = 'abc-123'

  describe('sessionsDir', () => {
    it('returns .claude/prove_it/sessions under rootDir', () => {
      assert.strictEqual(
        sessionsDir(root),
        path.join(root, '.claude', 'prove_it', 'sessions')
      )
    })
  })

  describe('sessionDir', () => {
    it('returns sessions/<id> under rootDir', () => {
      assert.strictEqual(
        sessionDir(root, sid),
        path.join(root, '.claude', 'prove_it', 'sessions', sid)
      )
    })
  })

  describe('backchannelDir', () => {
    it('returns backchannel/<sanitized-name> under session dir', () => {
      const result = backchannelDir(root, sid, 'my-task')
      assert.ok(result.includes('backchannel'))
      assert.ok(result.includes('my-task'))
      assert.ok(result.startsWith(sessionDir(root, sid)))
    })

    it('sanitizes task names with special characters', () => {
      const result = backchannelDir(root, sid, '../etc')
      assert.ok(!result.includes('/../'))
      assert.ok(result.includes('.._etc'))
    })
  })

  describe('backchannelReadmePath', () => {
    it('returns README.md inside backchannel dir', () => {
      const result = backchannelReadmePath(root, sid, 'my-task')
      assert.ok(result.endsWith('README.md'))
      assert.strictEqual(
        result,
        path.join(backchannelDir(root, sid, 'my-task'), 'README.md')
      )
    })
  })

  describe('backchannelPrefix', () => {
    it('returns backchannel/ under session dir (no task name)', () => {
      const result = backchannelPrefix(root, sid)
      assert.ok(result.endsWith('backchannel'))
      assert.strictEqual(
        result,
        path.join(sessionDir(root, sid), 'backchannel')
      )
    })
  })

  describe('notepadDir', () => {
    it('returns notepad/<sanitized-name> under session dir', () => {
      const result = notepadDir(root, sid, 'review-task')
      assert.ok(result.includes('notepad'))
      assert.ok(result.includes('review-task'))
      assert.ok(result.startsWith(sessionDir(root, sid)))
    })
  })

  describe('notepadFilePath', () => {
    it('returns README.md inside notepad dir', () => {
      const result = notepadFilePath(root, sid, 'review-task')
      assert.ok(result.endsWith('README.md'))
      assert.strictEqual(
        result,
        path.join(notepadDir(root, sid, 'review-task'), 'README.md')
      )
    })
  })
})
