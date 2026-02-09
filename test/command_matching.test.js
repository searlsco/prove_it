const { describe, it } = require('node:test')
const assert = require('node:assert')
const { matchesHookEntry } = require('../lib/dispatcher/claude')

function makeTriggerEntry (triggers) {
  return {
    type: 'claude',
    event: 'PreToolUse',
    matcher: 'Bash',
    triggers,
    tasks: []
  }
}

function matchesTriggers (command, triggers) {
  return matchesHookEntry(makeTriggerEntry(triggers), 'PreToolUse', {
    tool_name: 'Bash',
    tool_input: { command }
  })
}

describe('commands that require tests', () => {
  const defaultTriggers = [
    '(^|\\s)git\\s+commit\\b'
  ]

  const withPushTriggers = [
    '(^|\\s)git\\s+commit\\b',
    '(^|\\s)git\\s+push\\b'
  ]

  const withBeadsTriggers = [
    '(^|\\s)git\\s+commit\\b',
    '(^|\\s)(beads|bd)\\s+(done|finish|close)\\b'
  ]

  describe('git commit', () => {
    it("requires tests for 'git commit'", () => {
      assert.strictEqual(matchesTriggers('git commit', defaultTriggers), true)
    })

    it("requires tests for 'git commit -m message'", () => {
      assert.strictEqual(matchesTriggers('git commit -m "message"', defaultTriggers), true)
    })

    it("requires tests for 'git commit --amend'", () => {
      assert.strictEqual(matchesTriggers('git commit --amend', defaultTriggers), true)
    })

    it("does not require tests for 'git commits' (different word)", () => {
      assert.strictEqual(matchesTriggers('git commits', defaultTriggers), false)
    })

    it("does not require tests for 'git log --oneline' (different command)", () => {
      assert.strictEqual(matchesTriggers('git log --oneline', defaultTriggers), false)
    })
  })

  describe('git push (not blocked by default)', () => {
    it("does not require tests for 'git push' by default", () => {
      assert.strictEqual(matchesTriggers('git push', defaultTriggers), false)
    })

    it("does not require tests for 'git push origin main' by default", () => {
      assert.strictEqual(matchesTriggers('git push origin main', defaultTriggers), false)
    })

    it("requires tests for 'git push' when added to triggers", () => {
      assert.strictEqual(matchesTriggers('git push', withPushTriggers), true)
    })

    it("requires tests for 'git push --force' when added to triggers", () => {
      assert.strictEqual(matchesTriggers('git push --force', withPushTriggers), true)
    })

    it("does not require tests for 'git pull'", () => {
      assert.strictEqual(matchesTriggers('git pull', defaultTriggers), false)
    })
  })

  describe('beads/bd done/finish/close (not triggered by default)', () => {
    it("does not require tests for 'beads done' by default", () => {
      assert.strictEqual(matchesTriggers('beads done', defaultTriggers), false)
    })

    it("does not require tests for 'bd close' by default", () => {
      assert.strictEqual(matchesTriggers('bd close', defaultTriggers), false)
    })

    it("requires tests for 'bd close' when added to triggers", () => {
      assert.strictEqual(matchesTriggers('bd close', withBeadsTriggers), true)
    })

    it("requires tests for 'beads done 123' when added to triggers", () => {
      assert.strictEqual(matchesTriggers('beads done 123', withBeadsTriggers), true)
    })

    it("does not require tests for 'beads list' even when beads triggers added", () => {
      assert.strictEqual(matchesTriggers('beads list', withBeadsTriggers), false)
    })
  })

  describe('compound commands', () => {
    it("requires tests for 'npm test && git commit -m done'", () => {
      assert.strictEqual(matchesTriggers('npm test && git commit -m "done"', defaultTriggers), true)
    })

    it("requires tests for 'echo foo; git push' when push is enabled", () => {
      assert.strictEqual(matchesTriggers('echo foo; git push', withPushTriggers), true)
    })

    it("does not require tests for 'echo foo; git push' by default", () => {
      assert.strictEqual(matchesTriggers('echo foo; git push', defaultTriggers), false)
    })
  })

  describe("commands that don't require tests", () => {
    it("does not require tests for 'npm test'", () => {
      assert.strictEqual(matchesTriggers('npm test', defaultTriggers), false)
    })

    it("does not require tests for 'ls -la'", () => {
      assert.strictEqual(matchesTriggers('ls -la', defaultTriggers), false)
    })

    it("does not require tests for 'git status'", () => {
      assert.strictEqual(matchesTriggers('git status', defaultTriggers), false)
    })

    it("does not require tests for 'git diff'", () => {
      assert.strictEqual(matchesTriggers('git diff', defaultTriggers), false)
    })

    it("does not require tests for 'git add .'", () => {
      assert.strictEqual(matchesTriggers('git add .', defaultTriggers), false)
    })
  })
})
