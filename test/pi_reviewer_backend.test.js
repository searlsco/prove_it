const { describe, it } = require('node:test')
const assert = require('node:assert')

const { createPiReviewerPort, createPiTaskPort, runPiReviewerTask } = require('../lib/adapters/pi/task_port')

describe('Pi reviewer backend', () => {
  it('uses the active Pi harness defaults for reviewer tasks', () => {
    const calls = []
    const result = runPiReviewerTask({
      taskName: 'coverage-review',
      task: { type: 'reviewer', prompt: 'Review test coverage.' },
      event: { rootDir: '/repo', cwd: '/repo' }
    }, {
      runner (command, options) {
        calls.push({ command, options })
        return { code: 0, stdout: 'PASS: coverage is sufficient\n', stderr: '' }
      }
    })

    assert.deepStrictEqual(result, {
      pass: true,
      reason: 'coverage is sufficient',
      output: 'PASS: coverage is sufficient\n',
      verdict: {
        status: 'pass',
        reason: 'coverage is sufficient',
        body: null,
        evidence: 'PASS: coverage is sufficient\n',
        transcript: null
      }
    })
    assert.strictEqual(calls.length, 1)
    assert.match(calls[0].command, /^pi -p --no-session\b/)
    assert.doesNotMatch(calls[0].command, /claude|codex/)
    assert.doesNotMatch(calls[0].command, /--model/)
    assert.strictEqual(calls[0].options.cwd, '/repo')
    assert.match(calls[0].options.input, /Review test coverage\./)
    assert.match(calls[0].options.input, /PASS, FAIL, or SKIP/)
  })

  it('passes an explicit task model to Pi without changing harnesses', () => {
    let command
    const result = runPiReviewerTask({
      taskName: 'explicit-review',
      task: { type: 'reviewer', prompt: 'Review this.', model: 'anthropic/claude-sonnet-4-5:high' },
      event: { rootDir: '/repo' }
    }, {
      runner (cmd) {
        command = cmd
        return { code: 0, stdout: 'SKIP: not enough context\n', stderr: '' }
      }
    })

    assert.strictEqual(result.pass, true)
    assert.strictEqual(result.skipped, true)
    assert.match(command, /^pi -p --no-session\b/)
    assert.match(command, /--model 'anthropic\/claude-sonnet-4-5:high'/)
    assert.doesNotMatch(command, /claude -p|codex exec/)
  })

  it('installs a Pi task port that keeps script tasks on scripts and agent tasks on Pi', () => {
    const scriptCalls = []
    const reviewerCalls = []
    const port = createPiTaskPort(null, { cwd: '/repo' }, {
      scriptPort: {
        run (context) {
          scriptCalls.push(context.taskName)
          return { pass: true, reason: 'script ok' }
        }
      },
      reviewer (context) {
        reviewerCalls.push(context.taskName)
        return { pass: true, reason: 'review ok' }
      }
    })

    assert.deepStrictEqual(port.run({ taskName: 'tests', task: { type: 'script', command: './script/test' } }), { pass: true, reason: 'script ok' })
    assert.deepStrictEqual(port.run({ taskName: 'review', task: { type: 'reviewer', prompt: 'Review.' } }), { pass: true, reason: 'review ok' })
    assert.deepStrictEqual(port.run({ taskName: 'legacy-agent-review', task: { type: 'agent', prompt: 'Review.' } }), { pass: true, reason: 'review ok' })
    assert.deepStrictEqual(scriptCalls, ['tests'])
    assert.deepStrictEqual(reviewerCalls, ['review', 'legacy-agent-review'])
  })

  it('exposes a reviewer provider port for the workflow engine active-harness path', () => {
    const calls = []
    const port = createPiReviewerPort(null, { cwd: '/repo' }, {
      reviewer (context) {
        calls.push([context.taskName, context.piContext.cwd])
        return { pass: true, reason: 'pi review ok' }
      }
    })

    assert.deepStrictEqual(port.run({ taskName: 'review', task: { type: 'reviewer', prompt: 'Review.' } }), { pass: true, reason: 'pi review ok' })
    assert.deepStrictEqual(calls, [['review', '/repo']])
  })
})
