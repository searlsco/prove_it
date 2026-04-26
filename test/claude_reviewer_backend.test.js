const { describe, it } = require('node:test')
const assert = require('node:assert')

const { createClaudeReviewerPort, reviewerTaskToAgentCheck, runClaudeReviewerTask } = require('../lib/adapters/claude/reviewer_port')

describe('Claude clean-runtime reviewer backend', () => {
  it('maps strict reviewer tasks to the legacy Claude reviewer behavior and propagates provider options', () => {
    let received
    const result = runClaudeReviewerTask({
      taskName: 'coverage-review',
      task: {
        type: 'reviewer',
        intent: 'Check coverage.',
        prompt: 'Review test coverage.',
        model: 'sonnet',
        provider_options: {
          max_turns: 5,
          allowed_tools: ['Read', 'Grep'],
          bypass_permissions: true,
          command: 'claude -p',
          env: { FOO: 'bar' }
        },
        timeout_ms: 1234
      },
      event: {
        adapterId: 'claude',
        rawEventName: 'Stop',
        stage: 'agent_end',
        rootDir: '/repo',
        projectDir: '/repo',
        cwd: '/repo',
        sessionId: 'session-123'
      },
      config: {}
    }, {
      runAgentCheck (check, context) {
        received = { check, context }
        return { pass: true, reason: 'coverage ok', output: 'PASS: coverage ok\n' }
      }
    })

    assert.strictEqual(result.pass, true)
    assert.deepStrictEqual(result.verdict, {
      status: 'pass',
      reason: 'coverage ok',
      body: null,
      evidence: 'PASS: coverage ok\n',
      transcript: { sessionId: 'session-123' }
    })
    assert.deepStrictEqual(received.check, {
      name: 'coverage-review',
      type: 'agent',
      prompt: 'Review test coverage.',
      model: 'sonnet',
      maxAgentTurns: 5,
      command: 'claude -p',
      timeout: 1234
    })
    assert.deepStrictEqual(received.context.taskAllowedTools, ['Read', 'Grep'])
    assert.strictEqual(received.context.taskBypassPermissions, true)
    assert.deepStrictEqual(received.context.configEnv, { FOO: 'bar' })
    assert.strictEqual(received.context.hookEvent, 'Stop')
  })

  it('rejects Codex-shaped models instead of crossing harnesses from Claude sessions', () => {
    let called = false
    const result = runClaudeReviewerTask({
      taskName: 'codex-review',
      task: { type: 'reviewer', prompt: 'Review this.', model: 'gpt-5' },
      event: { adapterId: 'claude', rawEventName: 'Stop', cwd: '/repo', sessionId: 'session-123' }
    }, {
      runAgentCheck () {
        called = true
        return { pass: true, reason: 'should not run' }
      }
    })

    assert.strictEqual(called, false)
    assert.strictEqual(result.pass, false)
    assert.match(result.reason, /Codex model "gpt-5"/)
    assert.match(result.reason, /active Claude harness/)
  })

  it('rejects non-Claude reviewer commands instead of crossing harnesses', () => {
    let called = false
    const result = runClaudeReviewerTask({
      taskName: 'codex-command-review',
      task: {
        type: 'reviewer',
        prompt: 'Review this.',
        provider_options: { command: 'codex exec -' }
      },
      event: { adapterId: 'claude', rawEventName: 'Stop', cwd: '/repo', sessionId: 'session-123' }
    }, {
      runAgentCheck () {
        called = true
        return { pass: true, reason: 'should not run' }
      }
    })

    assert.strictEqual(called, false)
    assert.strictEqual(result.pass, false)
    assert.match(result.reason, /command "codex exec -"/)
    assert.match(result.reason, /active Claude harness/)
  })

  it('uses intent as the prompt when prompt is omitted', () => {
    const check = reviewerTaskToAgentCheck('approach-review', {
      type: 'reviewer',
      intent: 'Look for fixation.'
    })

    assert.strictEqual(check.prompt, 'Look for fixation.')
  })

  it('represents Claude skill-backed reviewer prompts without legacy promptType in strict config', () => {
    const check = reviewerTaskToAgentCheck('done-review', {
      type: 'reviewer',
      prompt: 'skill:prove-done'
    })

    assert.strictEqual(check.promptType, 'skill')
    assert.strictEqual(check.prompt, 'prove-done')
  })

  it('installs a reviewer runner port distinct from the script task port', () => {
    const calls = []
    const port = createClaudeReviewerPort({
      runAgentCheck () {
        calls.push('reviewer')
        return { pass: false, reason: 'found issue', body: 'details' }
      }
    })

    const result = port.run({
      taskName: 'done-review',
      task: { type: 'reviewer', prompt: 'Review done claim.' },
      event: { adapterId: 'claude', rawEventName: 'Stop', cwd: '/repo', sessionId: 'session-123' }
    })

    assert.deepStrictEqual(calls, ['reviewer'])
    assert.strictEqual(result.pass, false)
    assert.strictEqual(result.verdict.status, 'fail')
    assert.strictEqual(result.verdict.reason, 'found issue')
    assert.strictEqual(result.verdict.body, 'details')
  })
})
