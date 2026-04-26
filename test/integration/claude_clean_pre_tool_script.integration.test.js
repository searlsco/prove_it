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
  makeConfig,
  makeExecutable,
  writeConfig
} = require('./hook-harness')
const { PROFILE_VERSION } = require('../../lib/redesign/config')
const { backchannelReadmePath } = require('../../lib/paths')

function writeStrictConfig (dir, { tasks, preTool }) {
  const cfgPath = path.join(dir, '.prove_it', 'config.json')
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify({
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    tasks,
    agent_workflows: {
      pre_tool: preTool
    },
    adapters: {
      claude: { enabled: true }
    }
  }, null, 2), 'utf8')
}

function writeScript (dir, name, body) {
  const scriptPath = path.join(dir, 'script', name)
  createFile(dir, path.join('script', name), `#!/usr/bin/env bash\n${body}\n`)
  makeExecutable(scriptPath)
  return scriptPath
}

function invokePreTool (projectDir, input, env = {}) {
  return invokeHook('claude:PreToolUse', {
    hook_event_name: 'PreToolUse',
    session_id: 'clean-pre-tool-session',
    cwd: projectDir,
    ...input
  }, {
    projectDir,
    env: { ...isolatedEnv(projectDir), ...env }
  })
}

describe('Claude clean-runtime PreToolUse script tasks', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_claude_clean_pre_tool_')
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  it('runs strict .prove_it pre_tool script tasks and allows passing tool calls without reading legacy Claude config', () => {
    writeScript(tmpDir, 'strict-pass', 'echo strict-pass >> strict.log')
    writeStrictConfig(tmpDir, {
      tasks: {
        strict_pass: { type: 'script', command: './script/strict-pass' }
      },
      preTool: ['strict_pass']
    })
    writeConfig(tmpDir, makeConfig({
      claude: {
        PreToolUse: [{ name: 'legacy-fail', type: 'script', command: './script/missing-legacy' }]
      }
    }))

    const result = invokePreTool(tmpDir, {
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' }
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output, null, 'passing clean PreToolUse scripts should not emit a Claude permission decision')
    assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'strict.log'), 'utf8'), 'strict-pass\n')
  })

  it('allows Claude writes to clean-runtime backchannel paths before task denial logic', () => {
    writeScript(tmpDir, 'fail-pre-tool', 'echo "focused check failed" >&2\nexit 7')
    writeStrictConfig(tmpDir, {
      tasks: {
        fail_pre_tool: { type: 'script', command: './script/fail-pre-tool' }
      },
      preTool: ['fail_pre_tool']
    })

    const result = invokePreTool(tmpDir, {
      tool_name: 'Write',
      tool_input: {
        file_path: backchannelReadmePath(fs.realpathSync(tmpDir), 'clean-pre-tool-session', 'fail_pre_tool'),
        content: 'PASS unrelated failure'
      }
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('creates Claude backchannel files for strict task failures when appeal is configured', () => {
    writeScript(tmpDir, 'fail-pre-tool', 'echo "focused check failed" >&2\nexit 7')
    writeStrictConfig(tmpDir, {
      tasks: {
        fail_pre_tool: { type: 'script', command: './script/fail-pre-tool', appeal: { enabled: true, threshold: 1 } }
      },
      preTool: ['fail_pre_tool']
    })

    const result = invokePreTool(tmpDir, {
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js', content: 'module.exports = {}\n' }
    })
    const readmePath = backchannelReadmePath(tmpDir, 'clean-pre-tool-session', 'fail_pre_tool')

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /backchannel\/fail_pre_tool\/README\.md/)
    assert.strictEqual(fs.existsSync(readmePath), true)
  })

  it('hard-blocks Claude PreToolUse when a strict script task fails with useful failure text', () => {
    writeScript(tmpDir, 'fail-pre-tool', 'echo "focused check failed" >&2\nexit 7')
    writeStrictConfig(tmpDir, {
      tasks: {
        fail_pre_tool: { type: 'script', command: './script/fail-pre-tool' }
      },
      preTool: ['fail_pre_tool']
    })

    const result = invokePreTool(tmpDir, {
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js', content: 'module.exports = {}\n' }
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /script task "fail_pre_tool"/)
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /focused check failed/)
    assert.match(result.output.systemMessage, /focused check failed/)
  })

  it('runs multiple strict pre_tool tasks in order and stops at the first failure', () => {
    writeScript(tmpDir, 'first', 'echo first >> order.log')
    writeScript(tmpDir, 'second', 'echo second >> order.log\necho "second task failed" >&2\nexit 1')
    writeScript(tmpDir, 'third', 'echo third >> order.log')
    writeStrictConfig(tmpDir, {
      tasks: {
        first: { type: 'script', command: './script/first' },
        second: { type: 'script', command: './script/second' },
        third: { type: 'script', command: './script/third' }
      },
      preTool: ['first', 'second', 'third']
    })

    const result = invokePreTool(tmpDir, {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' }
    })

    assert.strictEqual(result.exitCode, 0)
    assert.deepStrictEqual(fs.readFileSync(path.join(tmpDir, 'order.log'), 'utf8').trim().split('\n'), ['first', 'second'])
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /second task failed/)
    assert.doesNotMatch(result.output.hookSpecificOutput.permissionDecisionReason, /third/)
  })

  it('hard-blocks when a configured strict script task is missing', () => {
    writeStrictConfig(tmpDir, {
      tasks: {
        missing_script: { type: 'script', command: './script/not-there' }
      },
      preTool: ['missing_script']
    })

    const result = invokePreTool(tmpDir, {
      tool_name: 'Bash',
      tool_input: { command: 'echo ok' }
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /Script not found: \.\/script\/not-there/)
  })

  it('honors matcher and trigger filters while giving scripts normalized Claude event, command, cwd, target paths, adapter id, and session id', () => {
    createFile(tmpDir, 'script/context-probe', `#!/usr/bin/env node
const fs = require('fs')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
function ok (condition, message) {
  if (!condition) {
    console.error(message)
    process.exit(1)
  }
}
ok(input.hook_event_name === 'PreToolUse', 'missing hook event')
ok(input.adapter_id === 'claude', 'missing adapter id')
ok(input.session_id === 'clean-pre-tool-session', 'missing session id')
ok(typeof input.cwd === 'string' && input.cwd.endsWith(process.cwd().split('/').pop()), 'missing cwd')
ok(input.tool_name === 'Bash', 'missing tool name')
ok(input.command === 'printf hi > src/app.js', 'missing command')
ok(Array.isArray(input.target_paths) && input.target_paths.includes('src/app.js'), 'missing target path')
ok(input.normalized_event && input.normalized_event.stage === 'pre_tool', 'missing normalized event stage')
ok(input.normalized_event && input.normalized_event.adapterId === 'claude', 'missing normalized event adapter')
fs.appendFileSync('context.log', 'ran\\n')
`)
    makeExecutable(path.join(tmpDir, 'script', 'context-probe'))
    writeStrictConfig(tmpDir, {
      tasks: {
        context_probe: {
          type: 'script',
          command: './script/context-probe',
          matcher: 'Bash',
          triggers: ['src/app\\.js']
        }
      },
      preTool: ['context_probe']
    })

    const nonMatchingTool = invokePreTool(tmpDir, {
      tool_name: 'Read',
      tool_input: { file_path: 'src/app.js' }
    })
    const nonMatchingCommand = invokePreTool(tmpDir, {
      tool_name: 'Bash',
      tool_input: { command: 'printf hi > README.md' }
    })
    const matching = invokePreTool(tmpDir, {
      tool_name: 'Bash',
      tool_input: { command: 'printf hi > src/app.js' }
    })

    assert.strictEqual(nonMatchingTool.exitCode, 0)
    assert.strictEqual(nonMatchingTool.output, null)
    assert.strictEqual(nonMatchingCommand.exitCode, 0)
    assert.strictEqual(nonMatchingCommand.output, null)
    assert.strictEqual(matching.exitCode, 0)
    assert.strictEqual(matching.output, null)
    assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'context.log'), 'utf8'), 'ran\n')
  })
})
