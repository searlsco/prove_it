const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  cleanupTempDir,
  createFile,
  createTempDir,
  isolatedEnv,
  invokeHook,
  makeExecutable,
  writeConfig,
  makeConfig
} = require('./hook-harness')
const { PROFILE_VERSION } = require('../../lib/redesign/config')
const { SESSION_KEYS, getSignal, saveSessionState } = require('../../lib/session')

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function writeStrictConfig (dir, { tasks = {}, agentEnd = [] } = {}) {
  writeJson(path.join(dir, '.prove_it', 'config.json'), {
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    tasks,
    agent_workflows: {
      agent_end: agentEnd
    },
    adapters: {
      claude: { enabled: true }
    }
  })
}

function writeScript (dir, name, body) {
  const scriptPath = path.join(dir, 'script', name)
  createFile(dir, path.join('script', name), `#!/usr/bin/env bash\n${body}\n`)
  makeExecutable(scriptPath)
  return `./script/${name}`
}

function invokeTaskCompleted (projectDir, sessionId, subject, env) {
  return invokeHook('claude:TaskCompleted', {
    hook_event_name: 'TaskCompleted',
    session_id: sessionId,
    cwd: projectDir,
    task_id: 'task-1',
    task_subject: subject
  }, { projectDir, cwd: projectDir, env })
}

function invokeStop (projectDir, sessionId, env) {
  return invokeHook('claude:Stop', {
    hook_event_name: 'Stop',
    session_id: sessionId,
    cwd: projectDir
  }, { projectDir, cwd: projectDir, env })
}

function sessionLogText (env, sessionId) {
  const logPath = path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.jsonl`)
  if (!fs.existsSync(logPath)) return ''
  return fs.readFileSync(logPath, 'utf8')
}

describe('Claude clean-runtime TaskCompleted auto-signaling', () => {
  let tmpDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_claude_clean_task_completed_')
    env = isolatedEnv(tmpDir)
    origProveItDir = process.env.PROVE_IT_DIR
    origHome = process.env.HOME
    process.env.PROVE_IT_DIR = env.PROVE_IT_DIR
    process.env.HOME = env.HOME
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    cleanupTempDir(tmpDir)
  })

  it('sets the shared done signal from strict .prove_it done-gated tasks without emitting hook output', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        completion_check: { type: 'script', command: 'true', when: { signal: 'done' } }
      },
      agentEnd: ['completion_check']
    })

    const result = invokeTaskCompleted(tmpDir, 'clean-tc-match', 'Run `prove_it signal done`', env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output, null)
    const signal = getSignal('clean-tc-match')
    assert.notStrictEqual(signal, null)
    assert.strictEqual(signal.type, 'done')
    assert.strictEqual(signal.message, null)
    assert.match(sessionLogText(env, 'clean-tc-match'), /"reviewer":"signal"/)
    assert.match(sessionLogText(env, 'clean-tc-match'), /done \(auto\)/)
    assert.match(sessionLogText(env, 'clean-tc-match'), /TaskCompleted/)
    assert.match(sessionLogText(env, 'clean-tc-match'), /task_completed_signal_done_subject/)
  })

  it('does not set a signal for non-matching task subjects', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        completion_check: { type: 'script', command: 'true', when: { signal: 'done' } }
      },
      agentEnd: ['completion_check']
    })

    const result = invokeTaskCompleted(tmpDir, 'clean-tc-no-match', 'Run unit tests', env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output, null)
    assert.strictEqual(getSignal('clean-tc-no-match'), null)
  })

  it('does not consult legacy .claude/prove_it done-gated tasks when strict clean tasks are not done-gated', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        strict_plain: { type: 'script', command: 'true' }
      },
      agentEnd: ['strict_plain']
    })
    writeConfig(tmpDir, makeConfig({
      claude: {
        Stop: [{ name: 'legacy-gated', type: 'script', command: 'echo legacy', when: { signal: 'done' } }]
      }
    }))

    const result = invokeTaskCompleted(tmpDir, 'clean-tc-strict-vs-legacy', 'Run `prove_it signal done`', env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(getSignal('clean-tc-strict-vs-legacy'), null)
  })

  it('preserves an already active done signal instead of overwriting it', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        completion_check: { type: 'script', command: 'true', when: { signal: 'done' } }
      },
      agentEnd: ['completion_check']
    })
    const existing = { type: 'done', message: 'already ready', at: 123 }
    saveSessionState('clean-tc-already-done', SESSION_KEYS.SIGNAL, existing)

    const result = invokeTaskCompleted(tmpDir, 'clean-tc-already-done', 'Run `prove_it signal done`', env)

    assert.strictEqual(result.exitCode, 0)
    assert.deepStrictEqual(getSignal('clean-tc-already-done'), existing)
    assert.strictEqual(sessionLogText(env, 'clean-tc-already-done'), '')
  })

  it('does not auto-signal when clean effective config has no done-gated tasks', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        plain_check: { type: 'script', command: 'true' },
        stuck_check: { type: 'script', command: 'true', when: { signal: 'stuck' } }
      },
      agentEnd: ['plain_check', 'stuck_check']
    })

    const result = invokeTaskCompleted(tmpDir, 'clean-tc-no-done-gate', 'Run `prove_it signal done`', env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(getSignal('clean-tc-no-done-gate'), null)
  })

  it('runs normal clean Stop completion verification after auto-signal and hard-blocks failures', () => {
    const marker = path.join(tmpDir, 'completion-ran')
    writeStrictConfig(tmpDir, {
      tasks: {
        completion_check: {
          type: 'script',
          command: writeScript(tmpDir, 'completion-fail', `touch ${JSON.stringify(marker)}\necho strict completion failed >&2\nexit 1`),
          when: { signal: 'done' }
        }
      },
      agentEnd: ['completion_check']
    })

    const tc = invokeTaskCompleted(tmpDir, 'clean-tc-stop-verification', 'Signal done to prove_it', env)
    assert.strictEqual(tc.exitCode, 0)
    assert.strictEqual(getSignal('clean-tc-stop-verification').type, 'done')

    const stop = invokeStop(tmpDir, 'clean-tc-stop-verification', env)

    assert.strictEqual(stop.exitCode, 0)
    assert.ok(stop.output, 'Stop should emit a hard-block JSON response')
    assert.strictEqual(stop.output.decision, 'block')
    assert.match(stop.output.reason, /completion_check/)
    assert.match(stop.output.reason, /strict completion failed/)
    assert.match(stop.output.reason, /done signal is preserved/i)
    assert.strictEqual(fs.existsSync(marker), true, 'completion verification task should run')
    assert.strictEqual(getSignal('clean-tc-stop-verification').type, 'done')
  })

  it('retains legacy TaskCompleted behavior when no strict .prove_it config exists', () => {
    writeConfig(tmpDir, makeConfig({
      claude: {
        Stop: [{ name: 'legacy-gated', type: 'script', command: 'echo legacy', when: { signal: 'done' } }]
      }
    }))

    const result = invokeTaskCompleted(tmpDir, 'clean-tc-legacy-oracle', 'Run `prove_it signal done`', env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(getSignal('clean-tc-legacy-oracle').type, 'done')
  })
})
