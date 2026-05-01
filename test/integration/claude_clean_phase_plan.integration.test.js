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
const { SIGNAL_PLAN_MARKER, PHASE_PLAN_MARKER } = require('../../lib/plan')
const { getPhase, setPhase, setSignal } = require('../../lib/session')

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function writeStrictConfig (dir, { tasks = {}, preTool = [], postTool = [], agentEnd = [] } = {}) {
  writeJson(path.join(dir, '.prove_it', 'config.json'), {
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    tasks,
    agent_workflows: {
      pre_tool: preTool,
      post_tool: postTool,
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

function invokePreTool (projectDir, sessionId, toolName, toolInput, env) {
  return invokeHook('claude:PreToolUse', {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: toolName,
    tool_input: toolInput
  }, { projectDir, cwd: projectDir, env })
}

function invokePostTool (projectDir, sessionId, toolName, toolInput, env) {
  return invokeHook('claude:PostToolUse', {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd: projectDir,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { ok: true }
  }, { projectDir, cwd: projectDir, env })
}

function invokeStop (projectDir, sessionId, env) {
  return invokeHook('claude:Stop', {
    hook_event_name: 'Stop',
    session_id: sessionId,
    cwd: projectDir
  }, { projectDir, cwd: projectDir, env })
}

function additionalContext (result) {
  return result.output?.hookSpecificOutput?.additionalContext || ''
}

describe('Claude clean-runtime phase and plan-file behavior', () => {
  let tmpDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_claude_clean_phase_plan_')
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

  it('intercepts valid phase commands before denying Bash tasks and preserves state for unknown phases', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        deny_bash: { type: 'script', command: writeScript(tmpDir, 'deny-bash', 'echo bash task ran >&2\nexit 1'), matcher: 'Bash' }
      },
      preTool: ['deny_bash']
    })

    const valid = invokePreTool(tmpDir, 'clean-phase-command', 'Bash', { command: 'prove_it phase implement' }, env)
    assert.strictEqual(valid.exitCode, 0)
    assert.match(additionalContext(valid), /phase "implement" recorded/)
    assert.match(valid.output.systemMessage, /continue/)
    assert.doesNotMatch(valid.stderr + valid.stdout, /bash task ran/)
    assert.strictEqual(getPhase('clean-phase-command'), 'implement')

    const invalid = invokePreTool(tmpDir, 'clean-phase-command', 'Bash', { command: 'prove_it phase design' }, env)
    assert.strictEqual(invalid.exitCode, 0)
    assert.strictEqual(invalid.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(invalid.output.hookSpecificOutput.permissionDecisionReason, /bash task ran/)
    assert.strictEqual(getPhase('clean-phase-command'), 'implement')
  })

  it('sets plan phase on EnterPlanMode while still running matching pre-tool tasks', () => {
    const marker = path.join(tmpDir, 'plan-entry-ran')
    writeStrictConfig(tmpDir, {
      tasks: {
        plan_entry: { type: 'script', command: writeScript(tmpDir, 'plan-entry', `touch ${JSON.stringify(marker)}`), matcher: 'EnterPlanMode' }
      },
      preTool: ['plan_entry']
    })

    const result = invokePreTool(tmpDir, 'clean-enter-plan', 'EnterPlanMode', {}, env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(fs.existsSync(marker), true)
    assert.strictEqual(getPhase('clean-enter-plan'), 'plan')
  })

  it('gates pre, post, and completion tasks with when.phase', () => {
    const preMarker = path.join(tmpDir, 'pre-implement-ran')
    const postMarker = path.join(tmpDir, 'post-refactor-ran')
    const doneMarker = path.join(tmpDir, 'done-implement-ran')
    writeStrictConfig(tmpDir, {
      tasks: {
        pre_implement: { type: 'script', command: writeScript(tmpDir, 'pre-implement', `touch ${JSON.stringify(preMarker)}`), when: { phase: 'implement' } },
        post_refactor: { type: 'script', command: writeScript(tmpDir, 'post-refactor', `touch ${JSON.stringify(postMarker)}`), when: { phase: 'refactor' } },
        done_implement: { type: 'script', command: writeScript(tmpDir, 'done-implement', `touch ${JSON.stringify(doneMarker)}`), when: { phase: 'implement' } }
      },
      preTool: ['pre_implement'],
      postTool: ['post_refactor'],
      agentEnd: ['done_implement']
    })

    setPhase('clean-phase-gates', 'implement')
    const pre = invokePreTool(tmpDir, 'clean-phase-gates', 'Write', { file_path: 'src/app.js', content: '' }, env)
    assert.strictEqual(pre.exitCode, 0)
    assert.strictEqual(fs.existsSync(preMarker), true)

    const post = invokePostTool(tmpDir, 'clean-phase-gates', 'Write', { file_path: 'src/app.js', content: '' }, env)
    assert.strictEqual(post.exitCode, 0)
    assert.strictEqual(fs.existsSync(postMarker), false)

    setSignal('clean-phase-gates', 'done', null)
    const stop = invokeStop(tmpDir, 'clean-phase-gates', env)
    assert.strictEqual(stop.exitCode, 0)
    assert.strictEqual(stop.output.decision, 'approve')
    assert.strictEqual(fs.existsSync(doneMarker), true)
    assert.strictEqual(getPhase('clean-phase-gates'), 'unknown')
  })

  it('injects signal and phase blocks into ExitPlanMode plan files idempotently when clean done-gated tasks exist', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        done_check: { type: 'script', command: 'true', when: { signal: 'done' } }
      },
      agentEnd: ['done_check']
    })
    const plansDir = path.join(env.HOME, '.claude', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    const planText = '# Refactor Plan\n\n### 1. Preserve existing behavior\n\nDo work.\n\n### 2. Run tests\n\nTest.\n\n## Verification\n\n- npm test'
    const planPath = path.join(plansDir, 'plan.md')
    fs.writeFileSync(planPath, planText, 'utf8')

    const first = invokePreTool(tmpDir, 'clean-exit-plan', 'ExitPlanMode', { plan: planText }, env)
    const second = invokePreTool(tmpDir, 'clean-exit-plan', 'ExitPlanMode', { plan: planText }, env)

    assert.strictEqual(first.exitCode, 0)
    assert.strictEqual(second.exitCode, 0)
    const content = fs.readFileSync(planPath, 'utf8')
    assert.strictEqual((content.match(/Run `prove_it signal done`/g) || []).length, 1)
    assert.strictEqual(content.split(PHASE_PLAN_MARKER).length - 1, 1)
    assert.match(content, /### 3\. Run `prove_it signal done`/)
    assert.match(content, /prove_it phase refactor/)
    assert.ok(content.indexOf(PHASE_PLAN_MARKER) < content.indexOf(SIGNAL_PLAN_MARKER))
    assert.ok(content.indexOf(SIGNAL_PLAN_MARKER) < content.indexOf('## Verification'))
  })

  it('gracefully no-ops ExitPlanMode plan mutation when no matching plan file exists', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        done_check: { type: 'script', command: 'true', when: { signal: 'done' } }
      },
      agentEnd: ['done_check']
    })

    const result = invokePreTool(tmpDir, 'clean-exit-plan-missing', 'ExitPlanMode', { plan: '### 1. Missing file' }, env)

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stderr, '')
  })
})
