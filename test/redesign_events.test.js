const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  LIFECYCLE_STAGES,
  extractTargetPaths,
  normalizeLifecycleEvent,
  normalizePiToolCall
} = require('../lib/redesign/events')
const {
  EFFECT_TYPES,
  allowEffect,
  approveEffect,
  batchEffect,
  blockEffect,
  contextInjectionEffect,
  envUpdateEffect,
  failEffect,
  noopEffect,
  observationEffect,
  remediationEffect,
  stateUpdateEffect
} = require('../lib/redesign/effects')

describe('redesign lifecycle events and effects', () => {
  it('declares the harness-neutral lifecycle stages needed by adapters', () => {
    assert.deepStrictEqual(LIFECYCLE_STAGES, {
      SESSION_START: 'session_start',
      PRE_TOOL: 'pre_tool',
      POST_TOOL: 'post_tool',
      POST_TOOL_FAILURE: 'post_tool_failure',
      AGENT_END: 'agent_end',
      PRE_COMMIT: 'pre_commit',
      PRE_PUSH: 'pre_push'
    })
  })

  it('normalizes Claude hook-shaped input without rendering Claude protocol output', () => {
    const rawEvent = {
      session_id: 'session-123',
      source: 'resume',
      transcript_path: '/tmp/transcript.jsonl',
      tool_name: 'Bash',
      tool_input: {
        command: './script/test_fast',
        file_path: 'src/app.js'
      }
    }

    const event = normalizeLifecycleEvent({
      adapterId: 'claude',
      rawEventName: 'PreToolUse',
      rawEvent,
      cwd: '/repo',
      projectDir: '/repo/project',
      rootDir: '/repo/project'
    })

    assert.strictEqual(event.adapterId, 'claude')
    assert.strictEqual(event.adapter, 'claude')
    assert.strictEqual(event.rawEventName, 'PreToolUse')
    assert.strictEqual(event.rawEvent, rawEvent)
    assert.strictEqual(event.stage, LIFECYCLE_STAGES.PRE_TOOL)
    assert.strictEqual(event.sessionId, 'session-123')
    assert.strictEqual(event.projectDir, '/repo/project')
    assert.strictEqual(event.rootDir, '/repo/project')
    assert.strictEqual(event.cwd, '/repo')
    assert.deepStrictEqual(event.tool, {
      name: 'Bash',
      input: rawEvent.tool_input,
      response: null,
      error: null
    })
    assert.strictEqual(event.toolName, 'Bash')
    assert.strictEqual(event.toolInput, rawEvent.tool_input)
    assert.strictEqual(event.command, './script/test_fast')
    assert.deepStrictEqual(event.targetPaths, ['src/app.js'])
    assert.deepStrictEqual(event.source, {
      kind: 'resume',
      transcriptPath: '/tmp/transcript.jsonl',
      metadata: null
    })
    assert.deepStrictEqual(event.resume, {
      isResume: true,
      metadata: null
    })
  })

  it('normalizes Pi pre-tool calls into the same event contract', () => {
    const rawEvent = {
      sessionId: 'pi-session',
      toolName: 'write',
      input: {
        path: '.prove_it/config.json',
        content: '{}'
      }
    }

    const event = normalizePiToolCall(rawEvent, { cwd: '/repo' })

    assert.strictEqual(event.adapterId, 'pi')
    assert.strictEqual(event.rawEventName, 'tool_call')
    assert.strictEqual(event.rawEvent, rawEvent)
    assert.strictEqual(event.stage, LIFECYCLE_STAGES.PRE_TOOL)
    assert.strictEqual(event.sessionId, 'pi-session')
    assert.strictEqual(event.projectDir, '/repo')
    assert.strictEqual(event.rootDir, '/repo')
    assert.strictEqual(event.cwd, '/repo')
    assert.deepStrictEqual(event.tool, {
      name: 'write',
      input: rawEvent.input,
      response: null,
      error: null
    })
    assert.strictEqual(event.toolName, 'write')
    assert.strictEqual(event.toolInput, rawEvent.input)
    assert.deepStrictEqual(event.targetPaths, ['.prove_it/config.json'])
  })

  it('extracts target paths from Claude, Pi, and generic tool payload shapes', () => {
    assert.deepStrictEqual(extractTargetPaths({
      tool_input: {
        file_path: 'src/claude.js',
        notebook_path: 'notebooks/demo.ipynb'
      },
      input: { path: 'src/pi.js' },
      path: 'src/top-level.js'
    }), [
      'src/top-level.js',
      'src/pi.js',
      'src/claude.js',
      'notebooks/demo.ipynb'
    ])
  })

  it('declares harness-neutral effect constructors for workflow outcomes', () => {
    assert.deepStrictEqual(EFFECT_TYPES, {
      NOOP: 'noop',
      ALLOW: 'allow',
      APPROVE: 'approve',
      BLOCK: 'block',
      FAIL: 'fail',
      CONTEXT_INJECTION: 'context_injection',
      ENV_UPDATE: 'env_update',
      STATE_UPDATE: 'state_update',
      OBSERVATION: 'observation',
      REMEDIATION: 'remediation',
      BATCH: 'batch'
    })

    assert.deepStrictEqual(noopEffect(), { effect: 'noop' })
    assert.deepStrictEqual(allowEffect(), { effect: 'allow' })
    assert.deepStrictEqual(approveEffect('verified'), { effect: 'approve', reason: 'verified' })
    assert.deepStrictEqual(blockEffect('blocked'), { effect: 'block', reason: 'blocked' })
    assert.deepStrictEqual(failEffect('failed'), { effect: 'fail', reason: 'failed' })
    assert.deepStrictEqual(contextInjectionEffect('guidance'), { effect: 'context_injection', context: 'guidance' })
    assert.deepStrictEqual(envUpdateEffect({ A: '1' }), { effect: 'env_update', env: { A: '1' } })
    assert.deepStrictEqual(stateUpdateEffect({ signal: 'done' }), { effect: 'state_update', state: { signal: 'done' } })
    assert.deepStrictEqual(observationEffect({ command: 'npm test' }), { effect: 'observation', observation: { command: 'npm test' } })
    assert.deepStrictEqual(remediationEffect('run tests'), { effect: 'remediation', message: 'run tests' })
    assert.deepStrictEqual(batchEffect([allowEffect()]), { effect: 'batch', effects: [{ effect: 'allow' }] })
  })

  it('keeps shared event/effect modules independent of adapter protocol APIs', () => {
    for (const relativePath of ['../lib/redesign/events.js', '../lib/redesign/effects.js']) {
      const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8')
      assert.doesNotMatch(source, /dispatcher\/protocol/)
      assert.doesNotMatch(source, /adapters\/pi/)
      assert.doesNotMatch(source, /@mariozechner\/pi-coding-agent/)
    }
  })
})
