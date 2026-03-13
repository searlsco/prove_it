const { describe, it } = require('node:test')
const assert = require('node:assert')
const { tddTransition, refactorTransition } = require('../libexec/test-first')

describe('TDD state machine transitions', () => {
  const LIMIT = 3

  function idle () { return { step: 'idle', editCount: 0, mode: 'tdd' } }
  function needsTest (editCount = 1) { return { step: 'needs-test', editCount, mode: 'tdd' } }
  function needsRed () { return { step: 'needs-red', editCount: 0, mode: 'tdd' } }
  function needsGreen () { return { step: 'needs-green', editCount: 0, mode: 'tdd' } }

  describe('from idle', () => {
    it('source-edit → needs-test with editCount=1', () => {
      const { state, message } = tddTransition(idle(), 'source-edit', LIMIT)
      assert.strictEqual(state.step, 'needs-test')
      assert.strictEqual(state.editCount, 1)
      assert.strictEqual(message, null)
    })

    it('test-edit → needs-red', () => {
      const { state, message } = tddTransition(idle(), 'test-edit', LIMIT)
      assert.strictEqual(state.step, 'needs-red')
      assert.strictEqual(state.editCount, 0)
      assert.strictEqual(message, null)
    })

    it('test-pass → stays idle', () => {
      const { state, message } = tddTransition(idle(), 'test-pass', LIMIT)
      assert.strictEqual(state.step, 'idle')
      assert.strictEqual(message, null)
    })
  })

  describe('from needs-test', () => {
    it('source-edit increments editCount', () => {
      const { state, message } = tddTransition(needsTest(1), 'source-edit', LIMIT)
      assert.strictEqual(state.step, 'needs-test')
      assert.strictEqual(state.editCount, 2)
      assert.strictEqual(message, null)
    })

    it('source-edit emits nudge when editCount reaches limit', () => {
      const { state, message } = tddTransition(needsTest(2), 'source-edit', LIMIT)
      assert.strictEqual(state.step, 'needs-test')
      assert.strictEqual(state.editCount, 3)
      assert.ok(message)
      assert.ok(message.includes('3 source file edits'))
      assert.ok(message.includes('prove_it phase refactor'))
    })

    it('test-edit → needs-red, resets editCount', () => {
      const { state, message } = tddTransition(needsTest(5), 'test-edit', LIMIT)
      assert.strictEqual(state.step, 'needs-red')
      assert.strictEqual(state.editCount, 0)
      assert.strictEqual(message, null)
    })

    it('test-command → stays needs-test (no transition until post)', () => {
      const { state, message } = tddTransition(needsTest(2), 'test-command', LIMIT)
      assert.strictEqual(state.step, 'needs-test')
      assert.strictEqual(state.editCount, 2)
      assert.strictEqual(message, null)
    })

    it('test-pass resets editCount (ran existing suite)', () => {
      const { state, message } = tddTransition(needsTest(5), 'test-pass', LIMIT)
      assert.strictEqual(state.step, 'needs-test')
      assert.strictEqual(state.editCount, 0)
      assert.strictEqual(message, null)
    })
  })

  describe('from needs-red', () => {
    it('source-edit warns about skipped red step', () => {
      const { state, message } = tddTransition(needsRed(), 'source-edit', LIMIT)
      assert.strictEqual(state.step, 'needs-test')
      assert.strictEqual(state.editCount, 1)
      assert.ok(message)
      assert.ok(message.includes('without running the new test'))
    })

    it('test-pass warns about vacuous test', () => {
      const { state, message } = tddTransition(needsRed(), 'test-pass', LIMIT)
      assert.strictEqual(state.step, 'idle')
      assert.ok(message)
      assert.ok(message.includes('vacuous'))
    })

    it('test-fail confirms red → needs-green', () => {
      const { state, message } = tddTransition(needsRed(), 'test-fail', LIMIT)
      assert.strictEqual(state.step, 'needs-green')
      assert.strictEqual(message, null)
    })

    it('test-command → stays needs-red (awaiting result)', () => {
      const { state } = tddTransition(needsRed(), 'test-command', LIMIT)
      assert.strictEqual(state.step, 'needs-red')
    })
  })

  describe('from needs-green', () => {
    it('source-edit → needs-test with editCount=1', () => {
      const { state } = tddTransition(needsGreen(), 'source-edit', LIMIT)
      assert.strictEqual(state.step, 'needs-test')
      assert.strictEqual(state.editCount, 1)
    })

    it('test-pass confirms green → idle', () => {
      const { state, message } = tddTransition(needsGreen(), 'test-pass', LIMIT)
      assert.strictEqual(state.step, 'idle')
      assert.strictEqual(state.editCount, 0)
      assert.strictEqual(message, null)
    })

    it('test-fail → stays needs-green', () => {
      const { state, message } = tddTransition(needsGreen(), 'test-fail', LIMIT)
      assert.strictEqual(state.step, 'needs-green')
      assert.strictEqual(message, null)
    })
  })

  describe('full red-green cycle', () => {
    it('test-edit → test-fail → source-edit → test-pass → idle (no warnings)', () => {
      const s = idle()
      let r

      // Write test
      r = tddTransition(s, 'test-edit', LIMIT)
      assert.strictEqual(r.state.step, 'needs-red')
      assert.strictEqual(r.message, null)

      // Run test — fails (red confirmed)
      r = tddTransition(r.state, 'test-fail', LIMIT)
      assert.strictEqual(r.state.step, 'needs-green')
      assert.strictEqual(r.message, null)

      // Write source code
      r = tddTransition(r.state, 'source-edit', LIMIT)
      assert.strictEqual(r.state.step, 'needs-test')
      assert.strictEqual(r.state.editCount, 1)

      // Run test — passes (green confirmed)
      r = tddTransition(r.state, 'test-pass', LIMIT)
      assert.strictEqual(r.state.step, 'needs-test')
      assert.strictEqual(r.state.editCount, 0)
      assert.strictEqual(r.message, null)
    })
  })
})

describe('Refactor state machine transitions', () => {
  const LIMIT = 3

  function refactorState (editCount = 0) {
    return { step: 'idle', editCount, mode: 'refactor' }
  }

  it('source-edit increments editCount', () => {
    const { state, message } = refactorTransition(refactorState(0), 'source-edit', LIMIT)
    assert.strictEqual(state.editCount, 1)
    assert.strictEqual(message, null)
  })

  it('source-edit emits nudge at limit', () => {
    const { state, message } = refactorTransition(refactorState(2), 'source-edit', LIMIT)
    assert.strictEqual(state.editCount, 3)
    assert.ok(message)
    assert.ok(message.includes('without running your test suite'))
    assert.ok(message.includes('prove_it phase implement'))
  })

  it('test-pass resets editCount', () => {
    const { state, message } = refactorTransition(refactorState(5), 'test-pass', LIMIT)
    assert.strictEqual(state.editCount, 0)
    assert.strictEqual(message, null)
  })

  it('test-edit warns about mode mismatch', () => {
    const { message } = refactorTransition(refactorState(0), 'test-edit', LIMIT)
    assert.ok(message)
    assert.ok(message.includes('editing test files during a refactor'))
    assert.ok(message.includes('prove_it phase implement'))
  })

  it('test-fail warns about behavior change', () => {
    const { message } = refactorTransition(refactorState(0), 'test-fail', LIMIT)
    assert.ok(message)
    assert.ok(message.includes('Test failure during refactor'))
    assert.ok(message.includes('prove_it phase implement'))
  })

  it('test-command has no immediate effect', () => {
    const { state, message } = refactorTransition(refactorState(2), 'test-command', LIMIT)
    assert.strictEqual(state.editCount, 2)
    assert.strictEqual(message, null)
  })
})
