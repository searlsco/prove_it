const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  writeConfig,
  makeConfig,
  isolatedEnv
} = require('./hook-harness')

const { readGrossCounter } = require('../../lib/git')

describe('gross churn accumulation via dispatcher', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_gross_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('increments gross counter on Write to a source file', () => {
    createFile(tmpDir, 'src/app.js', 'module.exports = {}')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write',
        tasks: []
      }
    ], { sources: ['src/**/*.js'] }))

    assert.strictEqual(readGrossCounter(tmpDir), 0,
      'Gross counter should start at 0')

    const content = 'function hello() {\n  return "world"\n}\nmodule.exports = { hello }\n'
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js', content },
      session_id: 'test-gross-write',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    const counter = readGrossCounter(tmpDir)
    assert.strictEqual(counter, content.split('\n').length,
      `Gross counter should equal line count of written content (${content.split('\n').length}), got ${counter}`)
  })

  it('increments gross counter on Edit to a source file', () => {
    createFile(tmpDir, 'src/utils.js', 'function old() {}')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Edit',
        tasks: []
      }
    ], { sources: ['src/**/*.js'] }))

    const oldStr = 'function old() {}'
    const newStr = 'function updated() {\n  return true\n}'
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/utils.js', old_string: oldStr, new_string: newStr },
      session_id: 'test-gross-edit',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    const expected = oldStr.split('\n').length + newStr.split('\n').length
    const counter = readGrossCounter(tmpDir)
    assert.strictEqual(counter, expected,
      `Gross counter should be old+new line count (${expected}), got ${counter}`)
  })

  it('accumulates across multiple PreToolUse invocations', () => {
    createFile(tmpDir, 'src/a.js', '')
    createFile(tmpDir, 'src/b.js', '')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write',
        tasks: []
      }
    ], { sources: ['src/**/*.js'] }))

    const content1 = 'line1\nline2\nline3\n'
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'src/a.js', content: content1 },
      session_id: 'test-gross-accum',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    const content2 = 'alpha\nbeta\n'
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'src/b.js', content: content2 },
      session_id: 'test-gross-accum',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    const expected = content1.split('\n').length + content2.split('\n').length
    const counter = readGrossCounter(tmpDir)
    assert.strictEqual(counter, expected,
      `Gross counter should accumulate across invocations (${expected}), got ${counter}`)
  })

  it('does NOT increment for files outside sources', () => {
    createFile(tmpDir, 'docs/readme.txt', 'hello')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write',
        tasks: []
      }
    ], { sources: ['src/**/*.js'] }))

    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/readme.txt', content: 'line1\nline2\nline3\n' },
      session_id: 'test-gross-nonsource',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(readGrossCounter(tmpDir), 0,
      'Gross counter should remain 0 for non-source files')
  })

  it('does NOT increment for non-edit tools', () => {
    createFile(tmpDir, 'src/app.js', 'code')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Read',
        tasks: []
      }
    ], { sources: ['src/**/*.js'] }))

    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/app.js' },
      session_id: 'test-gross-read',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    assert.strictEqual(readGrossCounter(tmpDir), 0,
      'Gross counter should remain 0 for non-edit tools')
  })

  it('accumulates gross churn for custom fileEditingTools', () => {
    createFile(tmpDir, 'src/app.js', 'code')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'mcp__custom_editor__write_file',
        tasks: []
      }
    ], {
      sources: ['src/**/*.js'],
      fileEditingTools: ['mcp__custom_editor__write_file']
    }))

    const content = 'new\ncontent\nhere\n'
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__custom_editor__write_file',
      tool_input: { file_path: 'src/app.js', content },
      session_id: 'test-gross-custom',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    // computeWriteLines uses longest-string heuristic for unknown tools,
    // so the content field (longest string) is used for line counting
    const counter = readGrossCounter(tmpDir)
    assert.strictEqual(counter, content.split('\n').length,
      `Custom fileEditingTool should accumulate gross churn (${content.split('\n').length}), got ${counter}`)
  })

  it('increments for builtin tools even without matcher', () => {
    // A config with no PreToolUse hooks at all—the accumulation is infrastructure,
    // not task-dependent. It runs before task matching.
    createFile(tmpDir, 'src/app.js', 'code')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'check', type: 'script', command: 'true' }
        ]
      }
    ], { sources: ['src/**/*.js'] }))

    const content = 'function main() {\n  console.log("hi")\n}\n'
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js', content },
      session_id: 'test-gross-infra',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    const counter = readGrossCounter(tmpDir)
    assert.strictEqual(counter, content.split('\n').length,
      `Gross churn accumulates even without PreToolUse hooks (infrastructure-level), got ${counter}`)
  })

  it('increments for NotebookEdit on source files', () => {
    createFile(tmpDir, 'src/analysis.ipynb', '{}')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'NotebookEdit',
        tasks: []
      }
    ], { sources: ['src/**/*'] }))

    const newSource = 'import pandas as pd\ndf = pd.read_csv("data.csv")\ndf.head()'
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'src/analysis.ipynb', new_source: newSource, edit_mode: 'replace' },
      session_id: 'test-gross-notebook',
      cwd: tmpDir
    }, { projectDir: tmpDir, env: isolatedEnv(tmpDir) })

    const expected = newSource.split('\n').length
    const counter = readGrossCounter(tmpDir)
    assert.strictEqual(counter, expected,
      `NotebookEdit should accumulate gross churn (${expected}), got ${counter}`)
  })
})
