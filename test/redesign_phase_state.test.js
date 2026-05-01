const { describe, it } = require('node:test')
const assert = require('node:assert')

const { SESSION_KEYS } = require('../lib/session')
const { createMemoryStatePort } = require('../lib/redesign/state_port')
const {
  VALID_PHASES,
  parsePhaseCommand,
  readPhase,
  setPhase
} = require('../lib/redesign/phase_state')

describe('shared clean phase state', () => {
  it('stores valid phases in shared session state and defaults missing or invalid state to unknown', () => {
    const statePort = createMemoryStatePort()

    assert.deepStrictEqual(VALID_PHASES, ['unknown', 'plan', 'implement', 'refactor'])
    assert.strictEqual(readPhase(statePort, 'session-1'), 'unknown')

    const result = setPhase(statePort, 'session-1', 'implement', { now: 123 })
    assert.deepStrictEqual(result, {
      ok: true,
      reason: null,
      phase: { phase: 'implement', at: 123 }
    })
    assert.strictEqual(readPhase(statePort, 'session-1'), 'implement')
    assert.deepStrictEqual(statePort.readSessionState('session-1', SESSION_KEYS.PHASE), { phase: 'implement', at: 123 })

    statePort.writeSessionState('session-1', SESSION_KEYS.PHASE, { phase: 'bogus', at: 456 })
    assert.strictEqual(readPhase(statePort, 'session-1'), 'unknown')
  })

  it('rejects invalid phases without corrupting existing phase state', () => {
    const statePort = createMemoryStatePort()
    assert.strictEqual(setPhase(statePort, 'session-1', 'refactor', { now: 123 }).ok, true)

    assert.deepStrictEqual(setPhase(statePort, 'session-1', 'bogus', { now: 456 }), {
      ok: false,
      reason: 'invalid_phase',
      phase: null
    })
    assert.strictEqual(readPhase(statePort, 'session-1'), 'refactor')
  })

  it('parses path-prefixed prove_it phase shell commands and leaves unrelated commands alone', () => {
    assert.deepStrictEqual(parsePhaseCommand('prove_it phase plan'), {
      matched: true,
      valid: true,
      phase: 'plan'
    })
    assert.deepStrictEqual(parsePhaseCommand('/tmp/test-bin/prove_it phase refactor && echo skipped'), {
      matched: true,
      valid: true,
      phase: 'refactor'
    })
    assert.deepStrictEqual(parsePhaseCommand('prove_it phase bogus'), {
      matched: true,
      valid: false,
      phase: 'bogus'
    })
    assert.strictEqual(parsePhaseCommand('echo prove_it phase implement'), null)
  })
})
