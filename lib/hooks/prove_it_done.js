#!/usr/bin/env node
/**
 * prove_it: Done hook (pre-commit gate)
 *
 * Handles:
 * - PreToolUse (Bash): wraps selected "completion boundary" commands with the full test suite
 *
 * Mtime-based skip logic:
 * - Tracks last run timestamp for full tests in .claude/prove_it.local.json
 * - Compares to max mtime of tracked files (git ls-files or configured globs)
 * - If last run passed after latest mtime → skip (no re-run needed)
 * - If last run failed after latest mtime → block immediately (fix tests first)
 *
 * Test script resolution (explicit config wins):
 * - Full: cfg.commands.test.full > script/test > script/test_slow
 */
const {
  readStdin,
  tryRun,
  isGitRepo,
  gitHead,
  emitJson,
  truncateChars,
  defaultTestConfig,
  loadGlobalConfig,
  isIgnoredPath,
  loadEffectiveConfig,
  saveRunData,
  resolveFullTests,
  testScriptExists,
  logReview,
  resolveTestRoot,
  runTests,
  shouldSkipTests,
  testScriptMissingMessage,
  runReviewer
} = require('../shared')

function shouldRequireTests (command, regexes) {
  const cmd = command || ''
  return regexes.some((re) => {
    try {
      return new RegExp(re, 'i').test(cmd)
    } catch {
      return false
    }
  })
}

const DEFAULT_CODE_PROMPT = `Review staged changes for three things:

## 1. Test coverage
- Source changes should have corresponding test changes
- New functions/methods need test cases
- Bug fixes need regression tests
- Be lenient for: docs, config, refactors where existing tests apply

## 2. Problems the tests may have missed
- Logic errors, edge cases, incorrect assumptions
- Anything that looks wrong but wouldn't cause a test failure

## 3. Dead code
- Unused functions, variables, or imports being added
- Code that can never execute
- Commented-out code that should be deleted

FAIL if ANY of these three checks fail. PASS only if all three pass.

Do NOT flag:
- Style issues or naming preferences
- Documentation gaps
- Existing dead code (only flag NEW dead code in this diff)`

function getCodeReviewerPrompt (userPrompt, stagedDiff) {
  const job = userPrompt || DEFAULT_CODE_PROMPT

  let diffSection = ''
  if (stagedDiff) {
    diffSection = `\n## Staged changes (about to be committed)\n\n\`\`\`diff\n${stagedDiff}\n\`\`\`\n`
  }

  return `You are a code reviewer. A coding agent is about to commit.
${diffSection}
## Your task

${job}

## Rules

- If no changes staged, return PASS
- Only FAIL for real problems - when in doubt, PASS
- If diff not provided above, run: git diff --cached

## Response format

Return EXACTLY one of:
- PASS
- FAIL: <reason>

One line only. Be concise.`
}

function runCodeReview (sessionId, projectDir, rootDir, cfg) {
  if (!cfg.hooks?.done?.reviewer?.enabled) return null

  const stagedResult = tryRun('git diff --cached', { cwd: rootDir })
  const stagedDiff = stagedResult.code === 0 ? stagedResult.stdout.trim() : null

  if (!stagedDiff) {
    logReview(sessionId, projectDir, 'code', 'PASS', 'no staged changes')
    return { status: 'PASS' }
  }

  const prompt = getCodeReviewerPrompt(cfg.hooks.done.reviewer.prompt, stagedDiff)
  const review = runReviewer(rootDir, cfg.hooks.done.reviewer, prompt)

  if (!review.available) {
    const reason = `${review.binary || 'reviewer'} not found`
    logReview(sessionId, projectDir, 'code', 'FAIL', reason)
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'prove_it: Code review failed.\n\n' +
          `${reason} - cannot verify code.\n\n` +
          `Install ${review.binary || 'reviewer'} or disable code reviewer in .claude/prove_it.json`
      }
    })
    process.exit(0)
  }

  if (review.error) {
    logReview(sessionId, projectDir, 'code', 'FAIL', review.error)
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `prove_it: Code review failed.\n\nReviewer error: ${review.error}`
      }
    })
    process.exit(0)
  }

  if (review.pass === false) {
    logReview(sessionId, projectDir, 'code', 'FAIL', review.reason)
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'prove_it: Code review failed.\n\n' +
          `${review.reason}\n\n` +
          'Fix the issue before committing.'
      }
    })
    process.exit(0)
  }

  logReview(sessionId, projectDir, 'code', 'PASS', null)
  return { status: 'PASS' }
}

function main () {
  let input
  try {
    input = JSON.parse(readStdin())
  } catch (e) {
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `prove_it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`
      }
    })
    process.exit(0)
  }

  const sessionId = input.session_id || null
  const hookEvent = input.hook_event_name
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

  // Only handle PreToolUse events
  if (hookEvent !== 'PreToolUse') process.exit(0)

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0)
  }

  // Skip hooks entirely for non-git directories (tmp, home, bin, etc.)
  if (!isGitRepo(projectDir)) {
    process.exit(0)
  }

  // Check for ignored paths in global config
  const globalCfg = loadGlobalConfig()
  if (isIgnoredPath(projectDir, globalCfg.ignoredPaths)) {
    process.exit(0)
  }

  const { cfg, localCfgPath } = loadEffectiveConfig(projectDir, defaultTestConfig)

  // Check for top-level enabled: false in config
  if (cfg.enabled === false) {
    process.exit(0)
  }

  if (!cfg.hooks?.done?.enabled) process.exit(0)
  if (input.tool_name !== 'Bash') process.exit(0)

  const toolCmd = input.tool_input && input.tool_input.command ? String(input.tool_input.command) : ''
  if (!toolCmd.trim()) process.exit(0)

  // Only require tests for selected boundary commands
  const patterns = cfg.hooks?.done?.triggers || []
  if (!shouldRequireTests(toolCmd, patterns)) process.exit(0)

  const rootDir = resolveTestRoot(projectDir)
  const fullTestCmd = resolveFullTests(rootDir, cfg)

  // Check if test script exists
  if (!testScriptExists(rootDir, fullTestCmd)) {
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: testScriptMissingMessage(fullTestCmd, rootDir)
      }
    })
    process.exit(0)
  }

  // Check mtime-based skip for full tests
  const skipCheck = shouldSkipTests(rootDir, cfg, localCfgPath, 'test_full')

  if (skipCheck.skip && skipCheck.reason === 'passed') {
    // Full tests passed recently — still run reviewer on staged changes
    runCodeReview(sessionId, projectDir, rootDir, cfg)
    process.exit(0)
  }

  if (skipCheck.skip && skipCheck.reason === 'failed') {
    // Full tests failed recently, block immediately
    const lastRun = skipCheck.lastRun
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'prove_it: Tests failed and no code has changed since.\n\n' +
          `Command: ${fullTestCmd}\n` +
          `Last run: ${new Date(lastRun.at).toISOString()}\n` +
          'Result: FAILED\n\n' +
          'Fix the failing tests before committing.\n' +
          '(Tests will re-run automatically when source files change.)'
      }
    })
    process.exit(0)
  }

  // Run full tests at hook time (not deferred to bash)
  const head = gitHead(rootDir)
  const run = runTests(rootDir, fullTestCmd)
  const maxChars = cfg.format?.maxOutputChars || 12000

  // Save run result
  saveRunData(localCfgPath, 'test_full', {
    at: Date.now(),
    head,
    pass: run.code === 0
  })

  if (run.code !== 0) {
    const outputTail = truncateChars(run.combined, maxChars)
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'prove_it: Tests failed; commit blocked.\n\n' +
          `Repo: ${rootDir}\n` +
          `Command: ${fullTestCmd}\n` +
          `Exit: ${run.code}\n` +
          `Duration: ${(run.durationMs / 1000).toFixed(1)}s\n\n` +
          `Tail:\n${outputTail || '(no output captured)'}\n\n` +
          'Fix the failure, then try committing again.'
      }
    })
    process.exit(0)
  }

  // Tests passed — run code reviewer on staged changes
  const codeReview = runCodeReview(sessionId, projectDir, rootDir, cfg)

  // Tests passed, reviewer passed (or not enabled) — allow commit through unchanged
  const reviewerNote = codeReview ? ` | code reviewer: ${codeReview.status}` : ''
  emitJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `prove_it: tests passed (${fullTestCmd})${reviewerNote}`
    }
  })
  process.exit(0)
}

// Export for CLI, auto-run when called directly
if (require.main === module) {
  main()
}
module.exports = { main }
