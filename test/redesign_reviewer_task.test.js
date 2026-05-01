const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { behaviorForCapability } = require('../lib/adapter_capabilities')
const { loadEffectiveConfig, PROFILE_VERSION } = require('../lib/redesign/config')
const { normalizeLifecycleEvent } = require('../lib/redesign/events')
const { runWorkflowEngine } = require('../lib/redesign/engine')
const { createMemoryStatePort } = require('../lib/redesign/state_port')

function strictRepo (task, pipeline = ['review']) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_reviewer_'))
  fs.mkdirSync(path.join(repo, '.prove_it'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.prove_it', 'config.json'), JSON.stringify({
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    tasks: { review: task },
    agent_workflows: { agent_end: pipeline },
    adapters: { claude: { enabled: true } }
  }, null, 2))
  return repo
}

function stopEvent (repo, adapterId = 'claude') {
  return normalizeLifecycleEvent({
    adapterId,
    rawEventName: adapterId === 'claude' ? 'Stop' : 'agent_end',
    rawEvent: { session_id: 'session-123' },
    cwd: repo
  })
}

function completionCapabilities (adapterId = 'claude') {
  return {
    completion_verification: behaviorForCapability(adapterId, 'completion_verification')
  }
}

function config ({ tasks, agentEnd = ['review'], postTool = [] }) {
  return {
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    globs: { source: [], test: [] },
    tasks,
    agent_workflows: {
      session_start: [],
      pre_tool: [],
      post_tool: postTool,
      post_tool_failure: [],
      agent_end: agentEnd
    },
    git_workflows: { pre_commit: [], pre_push: [] },
    adapters: {}
  }
}

describe('clean-runtime reviewer tasks', () => {
  it('accepts strict reviewer task schema with intent, prompt, triggers, when, provider options, lifecycle flags, and failure behavior', () => {
    const repo = strictRepo({
      type: 'reviewer',
      description: 'Coverage reviewer',
      intent: 'Check whether tests prove the behavior change.',
      prompt: 'Review test coverage for the current diff.',
      matcher: 'Bash',
      triggers: ['prove_it signal done'],
      when: { signal: 'done' },
      model: 'sonnet',
      provider: 'claude',
      provider_options: {
        max_turns: 4,
        allowed_tools: ['Read', 'Grep'],
        bypass_permissions: true,
        command: 'claude -p',
        env: { FOO: 'bar' }
      },
      async: true,
      failure_behavior: 'block',
      appeal: { enabled: true, threshold: 1 }
    })

    try {
      const explained = loadEffectiveConfig(repo)
      const task = explained.effective.tasks.review
      assert.strictEqual(task.type, 'reviewer')
      assert.strictEqual(task.intent, 'Check whether tests prove the behavior change.')
      assert.deepStrictEqual(task.provider_options.allowed_tools, ['Read', 'Grep'])
      assert.strictEqual(task.async, true)
      assert.strictEqual(task.failure_behavior, 'block')
      assert.deepStrictEqual(task.appeal, { enabled: true, threshold: 1 })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('rejects unknown reviewer providers in strict config', () => {
    const repo = strictRepo({
      type: 'reviewer',
      prompt: 'Review this.',
      provider: 'typo-harness'
    })

    try {
      assert.throws(
        () => loadEffectiveConfig(repo),
        /tasks\.review\.provider must be one of claude, pi, codex/
      )
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('runs reviewer tasks through the reviewer port instead of the script task port', () => {
    const effectiveConfig = config({
      tasks: {
        review: { type: 'reviewer', prompt: 'Review this.' }
      }
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    const reviewerCalls = []
    const reviewerPort = {
      run (context) {
        reviewerCalls.push(context)
        return { pass: true, reason: 'review passed', verdict: { status: 'pass', reason: 'review passed' } }
      }
    }
    const taskPort = { run: () => assert.fail('reviewer tasks must not use the script task port') }

    const effect = runWorkflowEngine({
      event: stopEvent(process.cwd()),
      effectiveConfig,
      adapterCapabilities: completionCapabilities('claude'),
      statePort,
      taskPort,
      reviewerPort
    })

    assert.strictEqual(effect.effect, 'approve')
    assert.strictEqual(reviewerCalls.length, 1)
    assert.strictEqual(reviewerCalls[0].taskName, 'review')
    assert.strictEqual(reviewerCalls[0].task.type, 'reviewer')
  })

  it('loads configured context_files into reviewer context in order', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_reviewer_context_'))
    fs.mkdirSync(path.join(repo, '.prove_it', 'rules'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.prove_it', 'rules', 'testing.md'), 'Testing standards first.\n')
    fs.writeFileSync(path.join(repo, 'docs', 'review.md'), 'Review standards second.\n')

    try {
      const effectiveConfig = config({
        tasks: {
          review: {
            type: 'reviewer',
            prompt: 'Review this.',
            context_files: ['.prove_it/rules/testing.md', 'docs/review.md']
          }
        }
      })
      const statePort = createMemoryStatePort()
      statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
      let received

      const effect = runWorkflowEngine({
        event: stopEvent(repo, 'claude'),
        effectiveConfig,
        adapterCapabilities: completionCapabilities('claude'),
        statePort,
        reviewerPort: {
          run (context) {
            received = context.contextFiles
            return { pass: true, reason: 'review passed' }
          }
        }
      })

      assert.strictEqual(effect.effect, 'approve')
      assert.deepStrictEqual(received.map(file => [file.path, file.content]), [
        ['.prove_it/rules/testing.md', 'Testing standards first.\n'],
        ['docs/review.md', 'Review standards second.\n']
      ])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('fails reviewer tasks when a context file is missing or unreadable', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_missing_context_'))

    try {
      const effectiveConfig = config({
        tasks: {
          review: { type: 'reviewer', prompt: 'Review this.', context_files: ['docs/missing.md'] }
        }
      })
      const statePort = createMemoryStatePort()
      statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })

      const effect = runWorkflowEngine({
        event: stopEvent(repo, 'claude'),
        effectiveConfig,
        adapterCapabilities: completionCapabilities('claude'),
        statePort,
        reviewerPort: { run: () => assert.fail('missing context files must fail before invoking reviewer') }
      })

      assert.strictEqual(effect.effect, 'fail')
      assert.match(effect.reason, /context file not found: docs\/missing\.md/)

      fs.mkdirSync(path.join(repo, 'docs', 'as-directory'), { recursive: true })
      const unreadableConfig = config({
        tasks: {
          review: { type: 'reviewer', prompt: 'Review this.', context_files: ['docs/as-directory'] }
        }
      })
      statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })

      const unreadableEffect = runWorkflowEngine({
        event: stopEvent(repo, 'claude'),
        effectiveConfig: unreadableConfig,
        adapterCapabilities: completionCapabilities('claude'),
        statePort,
        reviewerPort: { run: () => assert.fail('unreadable context files must fail before invoking reviewer') }
      })

      assert.strictEqual(unreadableEffect.effect, 'fail')
      assert.match(unreadableEffect.reason, /context file error: docs\/as-directory/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('rejects reviewer context_files that escape the project root', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_escape_context_'))

    try {
      for (const [contextFile, expected] of [
        ['../outside.md', /context_files\[0\] must stay within the project root/],
        [path.join(repo, 'docs', 'review.md'), /context_files\[0\] must be a project-relative path/]
      ]) {
        const effectiveConfig = config({
          tasks: {
            review: { type: 'reviewer', prompt: 'Review this.', context_files: [contextFile] }
          }
        })
        const statePort = createMemoryStatePort()
        statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })

        const effect = runWorkflowEngine({
          event: stopEvent(repo, 'claude'),
          effectiveConfig,
          adapterCapabilities: completionCapabilities('claude'),
          statePort,
          reviewerPort: { run: () => assert.fail('escaping context files must fail before invoking reviewer') }
        })

        assert.strictEqual(effect.effect, 'fail')
        assert.match(effect.reason, expected)
        assert.match(effect.reason, new RegExp(contextFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('normalizes reviewer fail and skip verdicts into completion lifecycle outcomes', () => {
    for (const [rawResult, expectedEffect, expectedReason] of [
      [{ pass: false, reason: 'missing edge case', body: 'src/app.js:10' }, 'fail', /missing edge case/],
      [{ pass: true, skipped: true, reason: 'not relevant' }, 'approve', /completion verification passed/]
    ]) {
      const effectiveConfig = config({
        tasks: {
          review: { type: 'reviewer', prompt: 'Review this.' }
        }
      })
      const statePort = createMemoryStatePort()
      statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
      const effect = runWorkflowEngine({
        event: stopEvent(process.cwd()),
        effectiveConfig,
        adapterCapabilities: completionCapabilities('claude'),
        statePort,
        reviewerPort: { run: () => rawResult }
      })

      assert.strictEqual(effect.effect, expectedEffect)
      assert.match(effect.reason || effect.message, expectedReason)
    }
  })

  it('keeps non-blocking reviewer failure output visible for failures-only tasks', () => {
    const effectiveConfig = config({
      tasks: {
        review: { type: 'reviewer', prompt: 'Review this.', failure_behavior: 'warn', output: 'failures_only' }
      },
      agentEnd: [],
      postTool: ['review']
    })

    const effect = runWorkflowEngine({
      event: normalizeLifecycleEvent({ adapterId: 'claude', rawEventName: 'PostToolUse', rawEvent: { session_id: 'session-123' }, cwd: process.cwd() }),
      effectiveConfig,
      reviewerPort: { run: () => ({ pass: false, reason: 'non-blocking advisory' }) }
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.match(effect.reason, /non-blocking advisory/)
  })

  it('honors reviewer failure_behavior warn as non-blocking lifecycle output', () => {
    const effectiveConfig = config({
      tasks: {
        review: { type: 'reviewer', prompt: 'Review this.', failure_behavior: 'warn' }
      }
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })

    const effect = runWorkflowEngine({
      event: stopEvent(process.cwd(), 'claude'),
      effectiveConfig,
      adapterCapabilities: completionCapabilities('claude'),
      statePort,
      reviewerPort: { run: () => ({ pass: false, reason: 'non-blocking advisory' }) }
    })

    assert.strictEqual(effect.effect, 'approve')
    assert.strictEqual(effect.signalLifecycle.action, 'clear')
  })

  it('renders a missing active-harness reviewer backend as an actionable task failure', () => {
    const effectiveConfig = config({
      tasks: {
        review: { type: 'reviewer', prompt: 'Review this.' }
      }
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })

    const effect = runWorkflowEngine({
      event: stopEvent(process.cwd(), 'claude'),
      effectiveConfig,
      adapterCapabilities: completionCapabilities('claude'),
      statePort
    })

    assert.strictEqual(effect.effect, 'fail')
    assert.match(effect.reason, /reviewer task "review" cannot run/)
    assert.match(effect.reason, /active adapter "claude"/)
  })

  it('does not allow reviewer tasks to request a different harness than the active adapter', () => {
    const effectiveConfig = config({
      tasks: {
        review: { type: 'reviewer', prompt: 'Review this.', provider: 'pi', context_files: ['docs/review.md'] }
      }
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })

    const effect = runWorkflowEngine({
      event: stopEvent(process.cwd(), 'claude'),
      effectiveConfig,
      adapterCapabilities: completionCapabilities('claude'),
      statePort,
      reviewerPort: { run: () => ({ pass: true, reason: 'should not run' }) }
    })

    assert.strictEqual(effect.effect, 'fail')
    assert.match(effect.reason, /requested reviewer provider "pi"/)
    assert.match(effect.reason, /active adapter is "claude"/)
  })

  it('launches and harvests async reviewer tasks through the reviewer provider port', () => {
    const effectiveConfig = config({
      tasks: {
        review: { type: 'reviewer', prompt: 'Review this.', async: true }
      },
      agentEnd: [],
      postTool: ['review']
    })
    const statePort = createMemoryStatePort()
    const launches = []
    const reviewerPort = {
      harvestBackgroundTasks () { return [] },
      launchBackgroundTask (context) {
        launches.push(context.taskName)
        return { id: 'review-bg-1', status: 'pending' }
      }
    }

    const launchEffect = runWorkflowEngine({
      event: normalizeLifecycleEvent({ adapterId: 'claude', rawEventName: 'PostToolUse', rawEvent: { session_id: 'session-123' }, cwd: process.cwd() }),
      effectiveConfig,
      statePort,
      reviewerPort
    })

    assert.strictEqual(launchEffect.effect, 'allow')
    assert.deepStrictEqual(launches, ['review'])
    assert.deepStrictEqual(statePort.readSessionState('session-123', 'task_lifecycle').async.pending, [{
      id: 'review-bg-1',
      taskName: 'review',
      taskType: 'reviewer',
      stage: 'post_tool',
      status: 'pending'
    }])

    const harvestEffect = runWorkflowEngine({
      event: normalizeLifecycleEvent({ adapterId: 'claude', rawEventName: 'PostToolUse', rawEvent: { session_id: 'session-123' }, cwd: process.cwd() }),
      effectiveConfig: config({ tasks: {}, postTool: [] }),
      statePort,
      reviewerPort: {
        harvestBackgroundTasks () {
          return [{ id: 'review-bg-1', taskName: 'review', result: { pass: true, reason: 'async review passed' } }]
        },
        consumeBackgroundTask () {}
      }
    })

    assert.strictEqual(harvestEffect.effect, 'allow')
    assert.deepStrictEqual(harvestEffect.asyncResults.map(result => [result.taskName, result.status, result.reason]), [
      ['review', 'pass', 'async review passed']
    ])
  })

  it('consumes harvested async reviewer results through the reviewer provider port', () => {
    const effectiveConfig = config({ tasks: {} })
    const statePort = createMemoryStatePort()
    statePort.writeSessionState('session-123', 'task_lifecycle', {
      async: {
        pending: [{ id: 'review-bg-1', taskName: 'review', taskType: 'reviewer', stage: 'post_tool', status: 'pending' }]
      }
    })
    const calls = []
    const reviewerPort = {
      harvestBackgroundTasks () {
        calls.push('harvest-reviewer')
        return [{ id: 'review-bg-1', taskName: 'review', task: { type: 'reviewer', prompt: 'Review.' }, result: { pass: true, reason: 'async review passed' } }]
      },
      consumeBackgroundTask (result) {
        calls.push(['consume-reviewer', result.id])
      }
    }
    const taskPort = {
      consumeBackgroundTask () {
        assert.fail('reviewer async results must be consumed by the reviewer port')
      }
    }

    const effect = runWorkflowEngine({
      event: normalizeLifecycleEvent({ adapterId: 'claude', rawEventName: 'PostToolUse', rawEvent: { session_id: 'session-123' }, cwd: process.cwd() }),
      effectiveConfig,
      statePort,
      taskPort,
      reviewerPort
    })

    assert.strictEqual(effect.effect, 'allow')
    assert.deepStrictEqual(calls, ['harvest-reviewer', ['consume-reviewer', 'review-bg-1']])
    assert.deepStrictEqual(statePort.readSessionState('session-123', 'task_lifecycle').async.pending, [])
  })

  it('settles and cleans up parallel reviewer tasks through the reviewer provider port', () => {
    const effectiveConfig = config({
      tasks: {
        review: { type: 'reviewer', prompt: 'Review this.', parallel: true }
      }
    })
    const statePort = createMemoryStatePort()
    statePort.writeSignal('session-123', { type: 'done', message: 'ready', at: 123 })
    const calls = []
    const reviewerPort = {
      startParallelTask ({ taskName }) {
        calls.push(['start-reviewer', taskName])
        return { id: 'review-parallel-1' }
      },
      settleParallelBatch (handles) {
        calls.push(['settle-reviewer', handles.map(handle => handle.id).join(',')])
        return handles.map(handle => ({ id: handle.id, taskName: handle.taskName, task: handle.task, result: { pass: true, reason: 'parallel review passed' } }))
      },
      cleanupTasks (handles) {
        calls.push(['cleanup-reviewer', handles.map(handle => handle.id).join(',')])
      }
    }
    const taskPort = {
      settleParallelBatch () {
        assert.fail('reviewer parallel tasks must settle through the reviewer port')
      },
      cleanupTasks () {
        assert.fail('reviewer parallel tasks must clean up through the reviewer port')
      }
    }

    const effect = runWorkflowEngine({
      event: stopEvent(process.cwd(), 'claude'),
      effectiveConfig,
      adapterCapabilities: completionCapabilities('claude'),
      statePort,
      taskPort,
      reviewerPort
    })

    assert.strictEqual(effect.effect, 'approve')
    assert.deepStrictEqual(calls, [
      ['start-reviewer', 'review'],
      ['settle-reviewer', 'review-parallel-1'],
      ['cleanup-reviewer', 'review-parallel-1']
    ])
    assert.strictEqual(effect.signalLifecycle.action, 'clear')
  })
})
