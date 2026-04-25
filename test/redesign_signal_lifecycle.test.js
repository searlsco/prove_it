const { describe, it } = require('node:test')
const assert = require('node:assert')

const {
  createMemoryStatePort,
  createObjectStatePort,
  createStatePort
} = require('../lib/redesign/state_port')
const {
  clearSignalOnPass,
  parseSignalCommand,
  preserveSignalOnFailure,
  readSignal,
  setSignal,
  settleSignalAfterVerification
} = require('../lib/redesign/signal_lifecycle')

function requiredPortMethods () {
  return [
    'read',
    'write',
    'readSessionState',
    'writeSessionState',
    'getSessionState',
    'setSessionState',
    'readSignal',
    'writeSignal',
    'clearSignal'
  ]
}

describe('shared signal lifecycle', () => {
  it('exposes a state port interface for signal and session state reads/writes', () => {
    const port = createMemoryStatePort()

    for (const method of requiredPortMethods()) {
      assert.strictEqual(typeof port[method], 'function', `${method} should be a function`)
    }

    assert.strictEqual(port.writeSessionState('session-1', 'workflow', { ok: true }), true)
    assert.deepStrictEqual(port.readSessionState('session-1', 'workflow'), { ok: true })
    assert.strictEqual(port.writeSignal('session-1', { type: 'done', message: null, at: 123 }), true)
    assert.deepStrictEqual(port.readSignal('session-1'), { type: 'done', message: null, at: 123 })
    assert.strictEqual(port.clearSignal('session-1'), true)
    assert.strictEqual(port.readSignal('session-1'), null)
  })

  it('does not throw or write when a session-required port is missing a session id', () => {
    const store = {}
    const port = createMemoryStatePort(store)

    assert.deepStrictEqual(setSignal(port, null, 'done', null, { now: 123 }), {
      ok: false,
      reason: 'state_unavailable',
      signal: null
    })
    assert.strictEqual(readSignal(port, null), null)
    assert.deepStrictEqual(store, {})
  })

  it('tolerates corrupted adapter state while reading, preserving, and clearing signals', () => {
    const port = createObjectStatePort({ sessions: 'not an object' })

    assert.strictEqual(readSignal(port, 'session-1'), null)
    assert.deepStrictEqual(preserveSignalOnFailure(port, 'session-1'), {
      ok: true,
      action: 'preserve',
      signal: null
    })
    assert.deepStrictEqual(clearSignalOnPass(port, 'session-1'), {
      ok: true,
      action: 'none',
      signal: null
    })
  })

  it('preserves a failed verification signal and clears a successful verification signal', () => {
    const port = createMemoryStatePort()

    assert.strictEqual(setSignal(port, 'session-1', 'done', 'ready', { now: 123 }).ok, true)
    const failed = settleSignalAfterVerification(port, 'session-1', false)
    assert.strictEqual(failed.action, 'preserve')
    assert.deepStrictEqual(readSignal(port, 'session-1'), { type: 'done', message: 'ready', at: 123 })

    const passed = settleSignalAfterVerification(port, 'session-1', true)
    assert.strictEqual(passed.action, 'clear')
    assert.deepStrictEqual(passed.signal, { type: 'done', message: 'ready', at: 123 })
    assert.strictEqual(readSignal(port, 'session-1'), null)
  })

  it('can persist Pi adapter-native signal state without a harness session id', () => {
    const piSessionState = {}
    const port = createObjectStatePort(piSessionState, { requireSessionId: false })

    assert.strictEqual(setSignal(port, null, 'stuck', 'need help', { now: 456 }).ok, true)
    assert.deepStrictEqual(readSignal(port, null), { type: 'stuck', message: 'need help', at: 456 })
  })

  it('wraps thrown state adapters as tolerant no-ops', () => {
    const port = createStatePort({
      readSessionState () { throw new Error('bad read') },
      writeSessionState () { throw new Error('bad write') }
    })

    assert.strictEqual(readSignal(port, 'session-1'), null)
    assert.strictEqual(setSignal(port, 'session-1', 'done', null).ok, false)
    assert.deepStrictEqual(clearSignalOnPass(port, 'session-1'), {
      ok: true,
      action: 'none',
      signal: null
    })
  })

  it('parses Claude/Pi prove_it signal shell commands and leaves unknown signals routable to the CLI', () => {
    assert.deepStrictEqual(parseSignalCommand('prove_it signal done --message "ready to review"'), {
      matched: true,
      valid: true,
      type: 'done',
      message: 'ready to review'
    })
    assert.deepStrictEqual(parseSignalCommand('/tmp/bin/prove_it signal bogus'), {
      matched: true,
      valid: false,
      type: 'bogus',
      message: null
    })
    assert.strictEqual(parseSignalCommand('echo prove_it signal done'), null)
  })
})
