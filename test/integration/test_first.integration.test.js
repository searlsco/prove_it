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
  isolatedEnv
} = require('./hook-harness')

const { saveSessionState, setPhase, loadSessionState, readCommandResults } = require('../../lib/session')

function testFirstConfig (tmpDir, extra = {}) {
  return makeConfig([
    {
      type: 'claude',
      event: 'PreToolUse',
      matcher: 'Write|Edit|Bash',
      tasks: [
        {
          name: 'test-first',
          type: 'script',
          command: path.join(__dirname, '..', '..', 'libexec', 'test-first'),
          quiet: true,
          params: { untestedEditLimit: 3 }
        }
      ]
    }
  ], {
    sources: ['src/**/*.js', 'test/**/*.test.js'],
    tests: ['test/**/*.test.js'],
    ...extra
  })
}

describe('TDD mode state machine integration', () => {
  let tmpDir, env, origProveItDir
  const SESSION_ID = 'test-session-tdd-sm'

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_tdd_sm_')
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

  it('nudges after N source edits without test activity', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')

    // Make 3 source edits
    for (let i = 0; i < 3; i++) {
      invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: SESSION_ID,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
      }, { projectDir: tmpDir, env })
    }

    // The 3rd edit should have triggered a nudge via additionalContext
    const state = loadSessionState(SESSION_ID, 'tddState')
    assert.strictEqual(state.step, 'needs-test')
    assert.strictEqual(state.editCount, 3)
  })

  it('emits TDD nudge message with refactor escape hatch', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')

    // Pre-set state to just below limit
    saveSessionState(SESSION_ID, 'tddState', { step: 'needs-test', editCount: 2, mode: 'tdd' })

    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    const ctx = result.output?.hookSpecificOutput?.additionalContext || ''
    assert.ok(ctx.includes('source file edits without writing or running tests'),
      `Should have TDD nudge, got: ${ctx}`)
    assert.ok(ctx.includes('prove_it phase refactor'),
      `Should mention refactor escape hatch, got: ${ctx}`)
  })

  it('warns about skipped red step (test-edit → source-edit without running)', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')
    createFile(tmpDir, 'test/app.test.js', 'test("it", () => {})\n')

    // Simulate: test-edit puts us in needs-red
    saveSessionState(SESSION_ID, 'tddState', { step: 'needs-red', editCount: 0, mode: 'tdd' })

    // Source edit without running test first
    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    const ctx = result.output?.hookSpecificOutput?.additionalContext || ''
    assert.ok(ctx.includes('without running the new test'),
      `Should warn about skipped red step, got: ${ctx}`)
  })

  it('detects vacuous test (test-edit → test-pass without source edits)', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')

    // Simulate: test-edit puts us in needs-red
    saveSessionState(SESSION_ID, 'tddState', { step: 'needs-red', editCount: 0, mode: 'tdd' })

    // Dispatcher logs a test pass via PostToolUse
    invokeHook('claude:PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'All tests passed'
    }, { projectDir: tmpDir, env })

    // Next PreToolUse picks up the command log and transitions
    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    const ctx = result.output?.hookSpecificOutput?.additionalContext || ''
    assert.ok(ctx.includes('vacuous'),
      `Should warn about vacuous test, got: ${ctx}`)
  })

  it('full red-green cycle produces no warnings', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')
    createFile(tmpDir, 'test/app.test.js', 'test("it", () => {})\n')

    // Step 1: Write test → needs-red
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'test/app.test.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    let state = loadSessionState(SESSION_ID, 'tddState')
    assert.strictEqual(state.step, 'needs-red', 'After test edit, should be in needs-red')

    // Step 2: Run test, it fails (dispatcher logs command result)
    invokeHook('claude:PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'Test failed'
    }, { projectDir: tmpDir, env })

    // Step 3: Write source code — test-first reads command log and transitions through needs-green
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    state = loadSessionState(SESSION_ID, 'tddState')
    assert.strictEqual(state.step, 'needs-test', 'After source edit from needs-green, should be needs-test')

    // Step 4: Run test, it passes (dispatcher logs command result)
    invokeHook('claude:PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'All tests passed'
    }, { projectDir: tmpDir, env })

    // Step 5: Next PreToolUse picks up the pass, resets state
    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    state = loadSessionState(SESSION_ID, 'tddState')
    assert.strictEqual(state.editCount, 1, 'Edit count should be 1 (fresh after reset + this edit)')
    // Should not have any warning messages
    const ctx = result.output?.hookSpecificOutput?.additionalContext || ''
    assert.ok(!ctx.includes('vacuous'), 'Should not warn about vacuous test after source edit')
  })
})

describe('Refactor mode integration', () => {
  let tmpDir, env, origProveItDir
  const SESSION_ID = 'test-session-refactor'

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_refactor_')
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

  it('nudges after N edits without test run in refactor mode', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')
    setPhase(SESSION_ID, 'refactor')

    // Pre-set state to just below limit
    saveSessionState(SESSION_ID, 'tddState', { step: 'idle', editCount: 2, mode: 'refactor' })

    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    const ctx = result.output?.hookSpecificOutput?.additionalContext || ''
    assert.ok(ctx.includes('without running your test suite'),
      `Should have refactor nudge, got: ${ctx}`)
  })

  it('test pass resets counter in refactor mode', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')
    setPhase(SESSION_ID, 'refactor')

    saveSessionState(SESSION_ID, 'tddState', { step: 'idle', editCount: 5, mode: 'refactor' })

    // Dispatcher logs test pass
    invokeHook('claude:PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'All tests passed'
    }, { projectDir: tmpDir, env })

    // Next PreToolUse picks up the pass from command log
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    const state = loadSessionState(SESSION_ID, 'tddState')
    assert.strictEqual(state.editCount, 1, 'Edit count should be 1 (reset + this edit)')
  })

  it('test failure warns about behavior change in refactor mode', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')
    setPhase(SESSION_ID, 'refactor')

    saveSessionState(SESSION_ID, 'tddState', { step: 'idle', editCount: 0, mode: 'refactor' })

    // Dispatcher logs test failure
    invokeHook('claude:PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'Tests failed'
    }, { projectDir: tmpDir, env })

    // Next PreToolUse picks up the failure from command log
    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    const ctx = result.output?.hookSpecificOutput?.additionalContext || ''
    assert.ok(ctx.includes('Test failure during refactor'),
      `Should warn about behavior change, got: ${ctx}`)
  })

  it('test file edit warns about mode mismatch in refactor mode', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'test/app.test.js', 'test("it", () => {})\n')
    setPhase(SESSION_ID, 'refactor')

    saveSessionState(SESSION_ID, 'tddState', { step: 'idle', editCount: 0, mode: 'refactor' })

    const result = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'test/app.test.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    assert.strictEqual(result.exitCode, 0)
    const ctx = result.output?.hookSpecificOutput?.additionalContext || ''
    assert.ok(ctx.includes('editing test files during a refactor'),
      `Should warn about mode mismatch, got: ${ctx}`)
  })
})

describe('Plan mode integration', () => {
  let tmpDir, env, origProveItDir
  const SESSION_ID = 'test-session-plan'

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_plan_')
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

  it('no tracking or messages in plan mode', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')
    setPhase(SESSION_ID, 'plan')

    // Many edits should produce no nudge
    for (let i = 0; i < 5; i++) {
      invokeHook('claude:PreToolUse', {
        hook_event_name: 'PreToolUse',
        session_id: SESSION_ID,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
      }, { projectDir: tmpDir, env })
    }

    // No tddState should be saved in plan mode
    const state = loadSessionState(SESSION_ID, 'tddState')
    assert.strictEqual(state, null, 'Should not track state in plan mode')
  })
})

describe('Phase transition resets state machine', () => {
  let tmpDir, env, origProveItDir
  const SESSION_ID = 'test-session-phase-reset'

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_phase_reset_')
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

  it('switching from implement to refactor resets state', () => {
    writeConfig(tmpDir, testFirstConfig(tmpDir))
    createFile(tmpDir, 'src/app.js', 'hello\n')

    // Build up state in TDD mode
    saveSessionState(SESSION_ID, 'tddState', { step: 'needs-test', editCount: 5, mode: 'tdd' })

    // Switch to refactor
    setPhase(SESSION_ID, 'refactor')

    // Next edit should use fresh refactor state
    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'src/app.js'), old_string: 'a', new_string: 'b' }
    }, { projectDir: tmpDir, env })

    const state = loadSessionState(SESSION_ID, 'tddState')
    assert.strictEqual(state.mode, 'refactor', 'Mode should be refactor after phase switch')
    assert.strictEqual(state.editCount, 1, 'Edit count should start fresh')
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
    const injectPlanPath = path.join(__dirname, '..', '..', 'libexec', 'inject-plan')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'ExitPlanMode',
        tasks: [
          {
            name: 'inject-tdd-plan',
            type: 'script',
            command: injectPlanPath,
            quiet: true,
            params: {
              position: 'after-title',
              marker: 'red-green TDD',
              block: '## Development approach\n\nFollow red-green TDD for each change:\n\n- Write a test that expresses the behavior you\'re about to implement\n- Run it and verify it fails for the reason you expect\n- Write the minimum source code to make the test pass\n- Re-run the test in isolation and confirm it passes (or the failure message changes as expected) before moving on\n'
            }
          }
        ]
      }
    ]))

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
    const injectPlanPath = path.join(__dirname, '..', '..', 'libexec', 'inject-plan')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'ExitPlanMode',
        tasks: [
          {
            name: 'inject-tdd-plan',
            type: 'script',
            command: injectPlanPath,
            quiet: true,
            params: {
              position: 'after-title',
              marker: 'red-green TDD',
              block: '## Development approach\n\nFollow red-green TDD for each change:\n'
            }
          }
        ]
      }
    ]))

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

  it('injects TDD block even when injectSignalBlock modifies file first', () => {
    const injectPlanPath = path.join(__dirname, '..', '..', 'libexec', 'inject-plan')
    writeConfig(tmpDir, makeConfig([
      {
        type: 'claude',
        event: 'PreToolUse',
        matcher: 'ExitPlanMode',
        tasks: [
          {
            name: 'inject-tdd-plan',
            type: 'script',
            command: injectPlanPath,
            quiet: true,
            params: {
              position: 'after-title',
              marker: 'red-green TDD',
              block: '## Development approach\n\nFollow red-green TDD for each change:\n'
            }
          }
        ]
      },
      {
        type: 'claude',
        event: 'Stop',
        tasks: [
          { name: 'gated-task', type: 'script', command: 'echo ok', when: { signal: 'done' } }
        ]
      }
    ]))

    const plansDir = path.join(tmpDir, '.claude', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    const planText = '# My Plan\n\n## 1. Build feature\n\nDo stuff.\n\n## Verification\n\n- Run tests'
    fs.writeFileSync(path.join(plansDir, 'test-plan.md'), planText)

    invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'test-tdd-with-signal',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: planText }
    }, { projectDir: tmpDir, env })

    const content = fs.readFileSync(path.join(plansDir, 'test-plan.md'), 'utf8')
    // Signal block should be present (from injectSignalBlock infrastructure)
    assert.ok(content.includes('prove_it signal done'), 'Plan should contain signal block')
    // Phase block should be present (from injectSignalBlock infrastructure)
    assert.ok(content.includes('prove_it phase implement'), 'Plan should contain phase block')
    // TDD block should ALSO be present (from inject-plan script task)
    assert.ok(content.includes('red-green TDD'), 'Plan should contain TDD block after signal block modifies file')
  })
})

describe('Dispatcher-level command result logging', () => {
  let tmpDir, env, origProveItDir
  const SESSION_ID = 'test-session-cmd-log'

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_cmd_log_')
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

  it('logs command result on PostToolUse for Bash', () => {
    writeConfig(tmpDir, makeConfig([
      { type: 'claude', event: 'Stop', tasks: [{ name: 'placeholder', type: 'script', command: 'true' }] }
    ]))

    invokeHook('claude:PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'All tests passed'
    }, { projectDir: tmpDir, env })

    const results = readCommandResults(SESSION_ID, 0)
    assert.strictEqual(results.length, 1, 'Should have logged one command result')
    assert.strictEqual(results[0].command, 'npm test')
    assert.strictEqual(results[0].success, true)
  })

  it('logs FAIL on PostToolUseFailure for Bash', () => {
    writeConfig(tmpDir, makeConfig([
      { type: 'claude', event: 'Stop', tasks: [{ name: 'placeholder', type: 'script', command: 'true' }] }
    ]))

    invokeHook('claude:PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'Tests failed'
    }, { projectDir: tmpDir, env })

    const results = readCommandResults(SESSION_ID, 0)
    assert.strictEqual(results.length, 1, 'Should have logged one command result')
    assert.strictEqual(results[0].command, 'npm test')
    assert.strictEqual(results[0].success, false)
  })

  it('does not log for non-Bash tools on PostToolUse', () => {
    writeConfig(tmpDir, makeConfig([
      { type: 'claude', event: 'Stop', tasks: [{ name: 'placeholder', type: 'script', command: 'true' }] }
    ]))

    invokeHook('claude:PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo.js' },
      tool_response: 'ok'
    }, { projectDir: tmpDir, env })

    const results = readCommandResults(SESSION_ID, 0)
    assert.strictEqual(results.length, 0, 'Should not log for non-Bash tools')
  })
})
