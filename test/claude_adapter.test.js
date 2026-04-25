const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')

const {
  LEGACY_CONFIG_DENY_REASON,
  claudeStopEffectFromVerification,
  emitClaudePreToolUseEffect,
  emitClaudeStopEffect
} = require('../lib/adapters/claude/effects')
const { createMemoryStatePort } = require('../lib/redesign/state_port')
const { readSignal, setSignal } = require('../lib/redesign/signal_lifecycle')
const {
  runClaudePreToolUseTaskThroughSharedEngine,
  legacyGuardProtectedPaths
} = require('../lib/adapters/claude/bridge')

function guardTask (overrides = {}) {
  return {
    name: 'lock-config',
    type: 'script',
    command: '$(prove_it prefix)/libexec/guard-config',
    matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
    ...overrides
  }
}

describe('Claude adapter shared-engine bridge', () => {
  it('routes a legacy Claude guard-config edit through a normalized event and shared block effect', () => {
    const seen = []
    const result = runClaudePreToolUseTaskThroughSharedEngine({
      task: guardTask(),
      input: {
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        tool_name: 'Write',
        tool_input: { file_path: '.claude/prove_it/config.json', content: '{}' },
        cwd: '/repo'
      },
      projectDir: '/repo',
      rootDir: '/repo',
      effectPort: {
        emit (effect, context) {
          seen.push({ effect, context })
        }
      }
    })

    assert.strictEqual(result.handled, true)
    assert.strictEqual(result.effect.effect, 'block')
    assert.strictEqual(result.effect.adapter, 'claude')
    assert.strictEqual(result.effect.capability, 'pre_tool_blocking')
    assert.strictEqual(result.effect.legacyReason, LEGACY_CONFIG_DENY_REASON)
    assert.deepStrictEqual(seen.map(entry => entry.effect.effect), ['block'])
    assert.strictEqual(seen[0].context.event.adapterId, 'claude')
    assert.strictEqual(seen[0].context.event.stage, 'pre_tool')
    assert.deepStrictEqual(seen[0].context.event.targetPaths, ['.claude/prove_it/config.json'])
  })

  it('routes supported Bash redirect parsing through the shared engine', () => {
    const result = runClaudePreToolUseTaskThroughSharedEngine({
      task: guardTask(),
      input: {
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        tool_name: 'Bash',
        tool_input: { command: 'echo "{}" > .claude/prove_it/config.json' },
        cwd: '/repo'
      },
      projectDir: '/repo',
      rootDir: '/repo'
    })

    assert.strictEqual(result.handled, true)
    assert.strictEqual(result.effect.effect, 'block')
    assert.strictEqual(result.effect.legacyReason, LEGACY_CONFIG_DENY_REASON)
  })

  it('keeps legacy .claude/prove_it paths adapter-owned, outside the clean shared defaults', () => {
    assert.deepStrictEqual(legacyGuardProtectedPaths(guardTask()), [
      '.claude/prove_it.json',
      '.claude/prove_it.local.json',
      '.claude/prove_it/config.json',
      '.claude/prove_it/config.local.json'
    ])
  })

  it('preserves custom guard-config denial wording when params.paths are routed', () => {
    const result = runClaudePreToolUseTaskThroughSharedEngine({
      task: guardTask({ params: { paths: ['.claude/prove_it/config.json'] } }),
      input: {
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        tool_name: 'Write',
        tool_input: { file_path: '.claude/prove_it/config.json', content: '{}' },
        cwd: '/repo'
      },
      projectDir: '/repo',
      rootDir: '/repo'
    })

    assert.strictEqual(result.handled, true)
    assert.match(result.effect.legacyReason, /Cannot modify guarded paths/)
    assert.match(result.effect.legacyReason, /Protected patterns: \.claude\/prove_it\/config\.json/)
  })
})

describe('Claude adapter effect renderer', () => {
  let captured
  const origWrite = process.stdout.write

  beforeEach(() => {
    captured = ''
    process.stdout.write = (chunk) => { captured += chunk }
  })

  afterEach(() => {
    process.stdout.write = origWrite
  })

  it('renders a shared pre_tool block effect as Claude-owned PreToolUse deny JSON', () => {
    emitClaudePreToolUseEffect({
      effect: 'block',
      reason: 'shared engine reason',
      legacyReason: LEGACY_CONFIG_DENY_REASON
    })

    const output = JSON.parse(captured)
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny')
    assert.strictEqual(output.hookSpecificOutput.permissionDecisionReason, LEGACY_CONFIG_DENY_REASON)
    assert.strictEqual(output.systemMessage, LEGACY_CONFIG_DENY_REASON)
  })

  it('renders Claude Stop hard-block effects and preserves failed done signals through shared lifecycle', () => {
    const statePort = createMemoryStatePort()
    setSignal(statePort, 'session-1', 'done', 'ready', { now: 123 })

    const effect = claudeStopEffectFromVerification({
      passed: false,
      reason: 'prove_it: stop checks failed',
      statePort,
      sessionId: 'session-1'
    })
    emitClaudeStopEffect(effect)

    const output = JSON.parse(captured)
    assert.strictEqual(effect.effect, 'fail')
    assert.strictEqual(effect.capability, 'completion_verification')
    assert.strictEqual(effect.enforcement, 'hard_block')
    assert.strictEqual(effect.signalLifecycle.action, 'preserve')
    assert.deepStrictEqual(readSignal(statePort, 'session-1'), { type: 'done', message: 'ready', at: 123 })
    assert.strictEqual(output.decision, 'block')
    assert.strictEqual(output.reason, 'prove_it: stop checks failed')
    assert.strictEqual(output.systemMessage, 'prove_it: stop checks failed')
  })

  it('renders Claude Stop approval effects and clears passed done signals through shared lifecycle', () => {
    const statePort = createMemoryStatePort()
    setSignal(statePort, 'session-1', 'done', null, { now: 456 })

    const effect = claudeStopEffectFromVerification({
      passed: true,
      reason: 'prove_it: all checks passed',
      statePort,
      sessionId: 'session-1'
    })
    emitClaudeStopEffect(effect)

    const output = JSON.parse(captured)
    assert.strictEqual(effect.effect, 'approve')
    assert.strictEqual(effect.signalLifecycle.action, 'clear')
    assert.strictEqual(readSignal(statePort, 'session-1'), null)
    assert.strictEqual(output.decision, 'approve')
    assert.strictEqual(output.reason, 'prove_it: all checks passed')
    assert.strictEqual(output.systemMessage, undefined)
  })
})
