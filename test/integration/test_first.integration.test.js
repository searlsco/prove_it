const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  invokeHook,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile,
  writeConfig,
  makeConfig,
  assertValidPermissionDecision,
  isolatedEnv
} = require('./hook-harness')

const { saveSessionState, getConsecutiveUntestedEditCount } = require('../../lib/session')

describe('test-first counter tracking', () => {
  let tmpDir, env, origProveItDir
  const SESSION_ID = 'test-session-testfirst'

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_testfirst_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
    env = isolatedEnv(tmpDir)
    // Align test process PROVE_IT_DIR with subprocess so reads/writes go to the same place
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = env.PROVE_IT_DIR
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('increments counter when editing a non-test source file', () => {
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write|Edit',
        tasks: []
      }
    ], {
      sources: ['src/**/*.js', 'test/**/*.test.js'],
      tests: ['test/**/*.test.js']
    }))

    createFile(tmpDir, 'src/app.js', 'console.log("hello")\n')

    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    const count = getConsecutiveUntestedEditCount(SESSION_ID)
    assert.strictEqual(count, 1, 'Counter should be 1 after editing a source file')
  })

  it('resets counter when editing a test file', () => {
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write|Edit',
        tasks: []
      }
    ], {
      sources: ['src/**/*.js', 'test/**/*.test.js'],
      tests: ['test/**/*.test.js']
    }))

    createFile(tmpDir, 'src/app.js', 'console.log("hello")\n')
    createFile(tmpDir, 'test/app.test.js', 'test("it works", () => {})\n')

    // First: edit a source file to set counter to 1
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(getConsecutiveUntestedEditCount(SESSION_ID), 1)

    // Then: edit a test file to reset counter
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'test/app.test.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    const count = getConsecutiveUntestedEditCount(SESSION_ID)
    assert.strictEqual(count, 0, 'Counter should reset after editing a test file')
  })

  it('resets counter when running a test command in Bash', () => {
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write|Edit|Bash',
        tasks: []
      }
    ], {
      sources: ['src/**/*.js'],
      tests: ['test/**/*.test.js']
    }))

    // Set counter manually
    saveSessionState(SESSION_ID, 'consecutiveUntestedEditCount', 5)

    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }, { projectDir: tmpDir, env })

    const count = getConsecutiveUntestedEditCount(SESSION_ID)
    assert.strictEqual(count, 0, 'Counter should reset after running npm test')
  })

  it('resets counter when running a user-configured test command', () => {
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Bash',
        tasks: []
      }
    ], {
      sources: ['src/**/*.js'],
      tests: ['test/**/*.test.js'],
      testCommands: ['my-test-runner']
    }))

    saveSessionState(SESSION_ID, 'consecutiveUntestedEditCount', 3)

    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'my-test-runner --verbose' }
    }, { projectDir: tmpDir, env })

    const count = getConsecutiveUntestedEditCount(SESSION_ID)
    assert.strictEqual(count, 0, 'Counter should reset after running user-configured test command')
  })
})

describe('test-first reminder via additionalContext', () => {
  let tmpDir, env, origProveItDir
  const SESSION_ID = 'test-session-reminder'

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_reminder_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
    env = isolatedEnv(tmpDir)
    origProveItDir = process.env.PROVE_IT_DIR
    process.env.PROVE_IT_DIR = env.PROVE_IT_DIR
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('emits additionalContext when counter meets untestedEditLimit', () => {
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write|Edit',
        tasks: [
          {
            name: 'test-first',
            type: 'script',
            command: path.join(__dirname, '..', '..', 'libexec', 'test-first'),
            quiet: true,
            params: { untestedEditLimit: 2 }
          }
        ]
      }
    ], {
      sources: ['src/**/*.js'],
      tests: ['test/**/*.test.js']
    }))

    createFile(tmpDir, 'src/app.js', 'hello\n')

    // Set counter above untestedEditLimit
    saveSessionState(SESSION_ID, 'consecutiveUntestedEditCount', 3)

    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    assertValidPermissionDecision(result, 'test-first reminder')
    assert.strictEqual(result.output.hookSpecificOutput.permissionDecision, 'allow',
      'Should allow the edit (reminder, not blocker)')

    const ctx = result.output.hookSpecificOutput.additionalContext
    assert.ok(ctx, 'Should have additionalContext')
    assert.ok(ctx.includes('source files without writing or running tests'),
      `additionalContext should contain reminder text, got: ${ctx}`)
  })

  it('does not emit additionalContext when counter is below untestedEditLimit', () => {
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'Write|Edit',
        tasks: [
          {
            name: 'test-first',
            type: 'script',
            command: path.join(__dirname, '..', '..', 'libexec', 'test-first'),
            quiet: true,
            params: { untestedEditLimit: 5 }
          }
        ]
      }
    ], {
      sources: ['src/**/*.js'],
      tests: ['test/**/*.test.js']
    }))

    createFile(tmpDir, 'src/app.js', 'hello\n')

    // Set counter below untestedEditLimit
    saveSessionState(SESSION_ID, 'consecutiveUntestedEditCount', 2)

    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    const ctx = result.output?.hookSpecificOutput?.additionalContext
    assert.ok(!ctx || !ctx.includes('source files without'),
      'Should not have reminder text when below untestedEditLimit')
  })
})

describe('TDD block injection on ExitPlanMode', () => {
  let tmpDir, env

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_tdd_')
    initGitRepo(tmpDir)
    createFile(tmpDir, '.gitkeep', '')
    spawnSync('git', ['add', '.'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
    env = isolatedEnv(tmpDir)
  })

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir)
  })

  it('injects TDD block after title on ExitPlanMode', () => {
    writeConfig(tmpDir, makeConfig([]))

    const plansDir = path.join(tmpDir, '.claude', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    const planText = '# My Plan\n\n## 1. Build feature\n\nDo stuff.\n'
    fs.writeFileSync(path.join(plansDir, 'test-plan.md'), planText)

    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'test-tdd-inject',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: planText }
    }, { projectDir: tmpDir, env })

    const content = fs.readFileSync(path.join(plansDir, 'test-plan.md'), 'utf8')
    assert.ok(content.includes('red-green TDD'), 'Plan should contain TDD block')
    assert.ok(content.includes('Development approach'), 'Plan should have Development approach heading')

    // TDD block should appear between title and first step
    const tddIdx = content.indexOf('Development approach')
    const stepIdx = content.indexOf('## 1. Build feature')
    assert.ok(tddIdx < stepIdx, 'TDD block should appear before first step')
  })

  it('does not double-inject TDD block', () => {
    writeConfig(tmpDir, makeConfig([]))

    const plansDir = path.join(tmpDir, '.claude', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    const planText = '# My Plan\n\n## Development approach\n\nFollow red-green TDD\n\n## 1. Build\n'
    fs.writeFileSync(path.join(plansDir, 'test-plan.md'), planText)

    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'test-tdd-no-dupe',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: planText }
    }, { projectDir: tmpDir, env })

    const content = fs.readFileSync(path.join(plansDir, 'test-plan.md'), 'utf8')
    const count = (content.match(/red-green TDD/g) || []).length
    assert.strictEqual(count, 1, 'Should have exactly one TDD marker')
  })
})
