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
  makeExecutable
} = require('./hook-harness')
const { PROFILE_VERSION } = require('../../lib/redesign/config')
const { getSignal, setSignal } = require('../../lib/session')

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

function writeInvalidStrictConfig (dir) {
  writeJson(path.join(dir, '.prove_it', 'config.json'), {
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    hooks: { claude: { Stop: [] } },
    adapters: { claude: { enabled: true } }
  })
}

function writeLegacyStopConfig (dir) {
  writeJson(path.join(dir, '.claude', 'prove_it', 'config.json'), {
    enabled: true,
    hooks: {
      claude: {
        Stop: [{
          name: 'legacy-stop-should-not-run',
          type: 'script',
          command: 'echo legacy Stop ran >&2; exit 1'
        }]
      }
    }
  })
}

function writeScript (dir, name, body) {
  const scriptPath = path.join(dir, 'script', name)
  createFile(dir, path.join('script', name), `#!/usr/bin/env bash\n${body}\n`)
  makeExecutable(scriptPath)
  return `./script/${name}`
}

function invokeStop (projectDir, sessionId, env) {
  return invokeHook('claude:Stop', {
    hook_event_name: 'Stop',
    session_id: sessionId,
    cwd: projectDir
  }, {
    projectDir,
    cwd: projectDir,
    env
  })
}

describe('Claude clean-runtime Stop completion verification', () => {
  let tmpDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_claude_clean_stop_')
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

  it('no-ops without running completion tasks when no done signal is active', () => {
    const marker = path.join(tmpDir, 'stop-task-ran')
    writeStrictConfig(tmpDir, {
      tasks: {
        completion_check: {
          type: 'script',
          command: writeScript(tmpDir, 'completion-check', `touch ${JSON.stringify(marker)}\necho should not run >&2\nexit 1`)
        }
      },
      agentEnd: ['completion_check']
    })

    const result = invokeStop(tmpDir, 'clean-stop-no-signal', env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, '')
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.output, null)
    assert.strictEqual(fs.existsSync(marker), false, 'completion task must not run without active done')
  })

  it('runs strict .prove_it completion tasks, clears done, and approves Claude Stop when verification passes', () => {
    const sessionId = 'clean-stop-pass'
    const marker = path.join(tmpDir, 'strict-pass-ran')
    setSignal(sessionId, 'done', 'ready for strict checks')
    writeStrictConfig(tmpDir, {
      tasks: {
        completion_check: {
          type: 'script',
          command: writeScript(tmpDir, 'completion-pass', `touch ${JSON.stringify(marker)}\necho strict completion passed`)
        }
      },
      agentEnd: ['completion_check']
    })

    const result = invokeStop(tmpDir, sessionId, env)

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Stop should emit Claude approve JSON')
    assert.strictEqual(result.output.decision, 'approve')
    assert.match(result.output.reason, /completion verification passed/)
    assert.strictEqual(fs.existsSync(marker), true, 'strict completion task should run')
    assert.strictEqual(getSignal(sessionId), null, 'done signal should clear after passing verification')
  })

  it('hard-blocks Claude Stop when strict completion verification fails and preserves done with remediation guidance', () => {
    const sessionId = 'clean-stop-fail'
    setSignal(sessionId, 'done', 'ready for strict checks')
    writeStrictConfig(tmpDir, {
      tasks: {
        completion_check: {
          type: 'script',
          command: writeScript(tmpDir, 'completion-fail', 'echo "strict failure details" >&2\nexit 1')
        }
      },
      agentEnd: ['completion_check']
    })

    const result = invokeStop(tmpDir, sessionId, env)

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'Stop should emit Claude hard-block JSON')
    assert.strictEqual(result.output.decision, 'block')
    assert.match(result.output.reason, /completion_check/)
    assert.match(result.output.reason, /strict failure details/)
    assert.match(result.output.reason, /done signal is preserved/i)
    assert.match(result.output.reason, /fix/i)
    assert.strictEqual(result.output.systemMessage, result.output.reason)
    const signal = getSignal(sessionId)
    assert.notStrictEqual(signal, null, 'done signal should persist after failed verification')
    assert.strictEqual(signal.type, 'done')
    assert.strictEqual(signal.message, 'ready for strict checks')
  })

  it('uses strict .prove_it Stop tasks and never runs legacy .claude/prove_it Stop tasks when both configs exist', () => {
    const sessionId = 'clean-stop-legacy-isolation'
    const marker = path.join(tmpDir, 'strict-stop-ran')
    setSignal(sessionId, 'done', null)
    writeStrictConfig(tmpDir, {
      tasks: {
        strict_completion: {
          type: 'script',
          command: writeScript(tmpDir, 'strict-completion', `touch ${JSON.stringify(marker)}\necho strict Stop ran`)
        }
      },
      agentEnd: ['strict_completion']
    })
    writeLegacyStopConfig(tmpDir)

    const result = invokeStop(tmpDir, sessionId, env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.decision, 'approve')
    assert.strictEqual(fs.existsSync(marker), true)
    assert.doesNotMatch(result.stdout + result.stderr, /legacy Stop ran|legacy-stop-should-not-run/)
  })

  it('hard-blocks active done completion when strict .prove_it config is invalid and does not run legacy Stop tasks', () => {
    const sessionId = 'clean-stop-invalid-strict'
    setSignal(sessionId, 'done', 'ready despite invalid config')
    writeInvalidStrictConfig(tmpDir)
    writeLegacyStopConfig(tmpDir)

    const result = invokeStop(tmpDir, sessionId, env)

    assert.strictEqual(result.exitCode, 0)
    assert.ok(result.output, 'invalid strict config should render Claude Stop JSON')
    assert.strictEqual(result.output.decision, 'block')
    assert.match(result.output.reason, /invalid strict \.prove_it\/config\.json/i)
    assert.match(result.output.reason, /unknown top-level key "hooks"/)
    assert.strictEqual(result.output.systemMessage, result.output.reason)
    assert.strictEqual(getSignal(sessionId).type, 'done')
    assert.doesNotMatch(result.stdout + result.stderr, /legacy Stop ran|legacy-stop-should-not-run/)
  })
})
