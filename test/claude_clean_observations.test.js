const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { invokeHook, isolatedEnv } = require('./integration/hook-harness')
const { PROFILE_VERSION } = require('../lib/redesign/config')

function tmpRepo () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_claude_clean_obs_'))
}

function writeJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function writeStrictConfig (repo, overrides = {}) {
  writeJson(path.join(repo, '.prove_it', 'config.json'), {
    schema_version: 1,
    profile_version: PROFILE_VERSION,
    globs: {
      source: ['src/**/*.js'],
      test: ['test/**/*.test.js']
    },
    tasks: {},
    agent_workflows: {
      pre_tool: [],
      post_tool: [],
      post_tool_failure: [],
      agent_end: []
    },
    adapters: { claude: { enabled: true } },
    ...overrides
  })
}

function envFor (repo) {
  return isolatedEnv(path.join(repo, '.home'))
}

function invokeClaudeHook (repo, hookEvent, input, env) {
  return invokeHook(`claude:${hookEvent}`, {
    hook_event_name: hookEvent,
    session_id: 'session-obs',
    cwd: repo,
    ...input
  }, {
    cwd: repo,
    projectDir: repo,
    env
  })
}

function readState (env, sessionId = 'session-obs') {
  return JSON.parse(fs.readFileSync(path.join(env.PROVE_IT_DIR, 'sessions', `${sessionId}.json`), 'utf8'))
}

describe('Claude clean-runtime observation recording', () => {
  it('records successful Bash command observations with output summary and session association', () => {
    const repo = tmpRepo()
    const env = envFor(repo)
    writeStrictConfig(repo)

    try {
      const result = invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: 'ok\n', stderr: '', exit_code: 0 }
      }, env)

      assert.strictEqual(result.exitCode, 0)
      const observations = readState(env).observations
      assert.strictEqual(observations.sessionId, 'session-obs')
      assert.strictEqual(observations.commandResults.length, 1)
      assert.deepStrictEqual(observations.commandResults[0], {
        type: 'command_result',
        sessionId: 'session-obs',
        stage: 'post_tool',
        toolName: 'Bash',
        command: 'npm test',
        success: true,
        exitCode: 0,
        outputSummary: { stdout: 'ok\n', stderr: '', exitCode: 0 }
      })
      assert.strictEqual(observations.summary.commands.succeeded, 1)
      assert.strictEqual(observations.summary.commands.failed, 0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('records failed Bash command observations and failed tool observations', () => {
    const repo = tmpRepo()
    const env = envFor(repo)
    writeStrictConfig(repo)

    try {
      const result = invokeClaudeHook(repo, 'PostToolUseFailure', {
        tool_name: 'Bash',
        tool_input: { command: 'npm run lint' },
        error: { message: 'exit status 1', stderr: 'lint failed\n', exit_code: 1 }
      }, env)

      assert.strictEqual(result.exitCode, 0)
      const observations = readState(env).observations
      assert.strictEqual(observations.commandResults.length, 1)
      assert.strictEqual(observations.failedCommands.length, 1)
      assert.strictEqual(observations.commandResults[0].success, false)
      assert.strictEqual(observations.commandResults[0].exitCode, 1)
      assert.deepStrictEqual(observations.commandResults[0].errorSummary, {
        message: 'exit status 1',
        stderr: 'lint failed\n',
        exitCode: 1
      })
      assert.strictEqual(observations.toolFailures.length, 1)
      assert.strictEqual(observations.toolFailures[0].type, 'tool_failure')
      assert.strictEqual(observations.toolFailures[0].toolName, 'Bash')
      assert.strictEqual(observations.summary.commands.failed, 1)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('records edit target paths with strict source/test/unrelated classification and accumulates repeated observations', () => {
    const repo = tmpRepo()
    const env = envFor(repo)
    writeStrictConfig(repo)

    try {
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(repo, 'src/app.js'), content: 'one\ntwo\nthree' },
        tool_response: { stdout: 'wrote file' }
      }, env)
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'Edit',
        tool_input: { file_path: 'test/app.test.js', old_string: 'old', new_string: 'new\nline' },
        tool_response: { stdout: 'edited file' }
      }, env)
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'Write',
        tool_input: { file_path: 'docs/readme.md', content: 'docs\n' },
        tool_response: { stdout: 'wrote docs' }
      }, env)
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'Write',
        tool_input: { content: 'missing path' },
        tool_response: { stdout: 'no path in payload' }
      }, env)

      const observations = readState(env).observations
      assert.deepStrictEqual(observations.editedFiles, ['src/app.js', 'test/app.test.js', 'docs/readme.md'])
      assert.deepStrictEqual(observations.changedFiles, ['src/app.js', 'test/app.test.js', 'docs/readme.md'])
      assert.deepStrictEqual(observations.classifiedFiles['src/app.js'], {
        path: 'src/app.js', source: true, test: false, unrelated: false
      })
      assert.deepStrictEqual(observations.classifiedFiles['test/app.test.js'], {
        path: 'test/app.test.js', source: false, test: true, unrelated: false
      })
      assert.deepStrictEqual(observations.classifiedFiles['docs/readme.md'], {
        path: 'docs/readme.md', source: false, test: false, unrelated: true
      })
      assert.strictEqual(observations.fileEdits.length, 3)
      assert.strictEqual(observations.toolResults.length, 4)
      assert.strictEqual(observations.toolResults[3].missingTargetPath, true)
      assert.strictEqual(observations.churn.grossLinesWritten, 7)
      assert.strictEqual(observations.churn.netLinesChanged, 0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('records configured Claude adapter file-editing tools as source/test edits with gross lines written', () => {
    const repo = tmpRepo()
    const env = envFor(repo)
    writeStrictConfig(repo, {
      adapters: {
        claude: {
          enabled: true,
          file_editing_tools: ['mcp__filesystem__write_file']
        }
      }
    })

    try {
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'mcp__filesystem__write_file',
        tool_input: { file_path: 'src/app.js', content: 'one\ntwo\nthree' },
        tool_response: { stdout: 'wrote source' }
      }, env)
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'MCP__FILESYSTEM__WRITE_FILE',
        tool_input: { path: 'test/app.test.js', content: 'alpha\nbeta\ngamma' },
        tool_response: { stdout: 'wrote test' }
      }, env)

      const observations = readState(env).observations
      assert.deepStrictEqual(observations.editedFiles, ['src/app.js', 'test/app.test.js'])
      assert.deepStrictEqual(observations.classifiedFiles['src/app.js'], {
        path: 'src/app.js', source: true, test: false, unrelated: false
      })
      assert.deepStrictEqual(observations.classifiedFiles['test/app.test.js'], {
        path: 'test/app.test.js', source: false, test: true, unrelated: false
      })
      assert.strictEqual(observations.fileEdits.length, 2)
      assert.strictEqual(observations.churn.grossLinesWritten, 6)
      assert.strictEqual(observations.toolResults[0].missingTargetPath, undefined)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('lets configured Claude edit tools satisfy source/test/linesWritten when gates', () => {
    const repo = tmpRepo()
    const env = envFor(repo)
    writeStrictConfig(repo, {
      tasks: {
        mcp_gate: {
          type: 'script',
          command: 'echo "mcp gate ran" && exit 1',
          when: { sourceFilesEdited: true, testFilesEdited: true, linesWritten: 6 }
        }
      },
      agent_workflows: {
        pre_tool: [],
        post_tool: [],
        post_tool_failure: [],
        agent_end: ['mcp_gate']
      },
      adapters: {
        claude: {
          enabled: true,
          file_editing_tools: ['mcp__filesystem__write_file']
        }
      }
    })

    try {
      invokeClaudeHook(repo, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'prove_it signal done --message ready' }
      }, env)
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'mcp__filesystem__write_file',
        tool_input: { file_path: 'src/app.js', content: 'one\ntwo\nthree' },
        tool_response: { stdout: 'wrote source' }
      }, env)
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'mcp__filesystem__write_file',
        tool_input: { file_path: 'test/app.test.js', content: 'alpha\nbeta\ngamma' },
        tool_response: { stdout: 'wrote test' }
      }, env)

      const result = invokeClaudeHook(repo, 'Stop', {}, env)

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output.decision, 'block')
      assert.match(result.output.reason, /mcp_gate/)
      assert.match(result.output.reason, /mcp gate ran/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('preserves missing-target-path behavior for configured Claude edit tools with no detectable path', () => {
    const repo = tmpRepo()
    const env = envFor(repo)
    writeStrictConfig(repo, {
      adapters: {
        claude: {
          enabled: true,
          file_editing_tools: ['mcp__filesystem__write_file']
        }
      }
    })

    try {
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'mcp__filesystem__write_file',
        tool_input: { content: 'missing\npath' },
        tool_response: { stdout: 'no path in payload' }
      }, env)

      const observations = readState(env).observations
      assert.strictEqual(observations.toolResults.length, 1)
      assert.strictEqual(observations.toolResults[0].missingTargetPath, true)
      assert.deepStrictEqual(observations.editedFiles, [])
      assert.deepStrictEqual(observations.fileEdits, [])
      assert.strictEqual(observations.churn.grossLinesWritten, 0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('uses recorded observation facts in later clean when conditions', () => {
    const repo = tmpRepo()
    const env = envFor(repo)
    writeStrictConfig(repo, {
      tasks: {
        source_gate: {
          type: 'script',
          command: 'echo "source gate ran" && exit 1',
          when: { sourceFilesEdited: true, linesWritten: 3 }
        }
      },
      agent_workflows: {
        pre_tool: [],
        post_tool: [],
        post_tool_failure: [],
        agent_end: ['source_gate']
      }
    })

    try {
      invokeClaudeHook(repo, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'prove_it signal done --message ready' }
      }, env)
      invokeClaudeHook(repo, 'PostToolUse', {
        tool_name: 'Write',
        tool_input: { file_path: 'src/app.js', content: 'one\ntwo\nthree' },
        tool_response: { stdout: 'wrote file' }
      }, env)

      const result = invokeClaudeHook(repo, 'Stop', {}, env)

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.output.decision, 'block')
      assert.match(result.output.reason, /source_gate/)
      assert.match(result.output.reason, /source gate ran/)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
