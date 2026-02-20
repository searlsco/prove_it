#!/usr/bin/env node
/**
 * prove_it CLI
 *
 * Commands:
 *   install   - Install prove_it globally (~/.claude/) including /prove skill
 *   uninstall - Remove prove_it from global config
 *   init      - Initialize prove_it in current repository
 *   deinit    - Remove prove_it files from current repository
 *   doctor    - Check installation status and report issues
 *   monitor   - Tail hook results in real time
 *   hook      - Run a hook dispatcher (claude:<Event> or git:<event>)
 *   run_builtin - Run a builtin check directly
 *   record    - Record a test run result for mtime caching
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { loadJson, writeJson, getProveItDir, buildGlobalConfig, configHash } = require('./lib/shared')

function rmIfExists (p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function log (...args) {
  console.log(...args)
}

function getClaudeDir () {
  return path.join(os.homedir(), '.claude')
}

// ============================================================================
// Install command
// ============================================================================

function addHookGroup (hooksObj, eventName, group) {
  if (!hooksObj[eventName]) hooksObj[eventName] = []
  const groupStr = JSON.stringify(group)
  const exists = hooksObj[eventName].some(g => JSON.stringify(g) === groupStr)
  if (!exists) {
    hooksObj[eventName].push(group)
  }
}

function removeProveItGroups (groups) {
  if (!Array.isArray(groups)) return groups
  return groups.filter(g => {
    const hooks = g && g.hooks ? g.hooks : []
    const serialized = JSON.stringify(hooks)
    // Remove all prove_it hook registrations (old .js files, short-form, v2 dispatch)
    if (serialized.includes('prove_it_test.js')) return false
    if (serialized.includes('prove_it_session_start.js')) return false
    if (serialized.includes('prove_it_stop.js')) return false
    if (serialized.includes('prove_it_done.js')) return false
    if (serialized.includes('prove_it_edit.js')) return false
    if (serialized.includes('prove_it hook ')) return false
    return true
  })
}

function buildHookGroups () {
  return [
    {
      event: 'SessionStart',
      group: {
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
      }
    },
    {
      event: 'PreToolUse',
      group: {
        matcher: 'Edit|Write|NotebookEdit|Bash',
        hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }]
      }
    },
    {
      event: 'Stop',
      group: {
        hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
      }
    }
  ]
}

function isGlobalConfigCurrent () {
  const cfgPath = path.join(getProveItDir(), 'config.json')
  const cfg = loadJson(cfgPath)
  if (!cfg || !cfg.initSeed) return false
  const contentHash = configHash(cfg)
  if (contentHash === cfg.initSeed) {
    // Unedited — current only if it matches fresh defaults
    const fresh = buildGlobalConfig()
    return contentHash === configHash(fresh)
  }
  // Edited — current if all default taskEnv keys are present
  const defaults = buildGlobalConfig()
  if (!cfg.taskEnv) return false
  for (const [k, v] of Object.entries(defaults.taskEnv)) {
    if (cfg.taskEnv[k] !== v) return false
  }
  return true
}

function isInstallCurrent (settings) {
  if (!settings || !settings.hooks) return false
  const expected = buildHookGroups()
  for (const { event, group } of expected) {
    const found = findProveItGroup(settings, event)
    if (!found || JSON.stringify(found) !== JSON.stringify(group)) return false
  }
  if (!isGlobalConfigCurrent()) return false
  return true
}

function isSkillCurrent (claudeDir) {
  const skillPath = path.join(claudeDir, 'skills', 'prove', 'SKILL.md')
  const shippedPath = path.join(__dirname, 'lib', 'skills', 'prove.md')
  if (!fs.existsSync(skillPath)) return false
  return fs.readFileSync(skillPath, 'utf8') === fs.readFileSync(shippedPath, 'utf8')
}

function cmdInstall () {
  const claudeDir = getClaudeDir()
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath) || {}

  // Check if already up to date
  if (isInstallCurrent(settings) && isSkillCurrent(claudeDir)) {
    log('prove_it already up to date.')
    log(`  Settings: ${settingsPath}`)
    return
  }

  if (!settings.hooks) settings.hooks = {}

  // Clean up old-style hook registrations first
  for (const k of Object.keys(settings.hooks)) {
    settings.hooks[k] = removeProveItGroups(settings.hooks[k])
    if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
      delete settings.hooks[k]
    }
  }

  // Register dispatchers
  for (const { event, group } of buildHookGroups()) {
    addHookGroup(settings.hooks, event, group)
  }

  writeJson(settingsPath, settings)

  // Global config — seed-based 3-way merge (same pattern as project config)
  const globalCfgPath = path.join(getProveItDir(), 'config.json')
  const existingGlobal = loadJson(globalCfgPath)
  if (!existingGlobal) {
    // No config — write fresh with initSeed
    const fresh = buildGlobalConfig()
    fresh.initSeed = configHash(fresh)
    writeJson(globalCfgPath, fresh)
  } else if (existingGlobal.initSeed && configHash(existingGlobal) === existingGlobal.initSeed) {
    // Unedited — auto-upgrade if defaults changed
    const fresh = buildGlobalConfig()
    const freshHash = configHash(fresh)
    if (configHash(existingGlobal) !== freshHash) {
      fresh.initSeed = freshHash
      writeJson(globalCfgPath, fresh)
    }
  } else {
    // Edited or legacy (no initSeed) — preserve user config, ensure taskEnv defaults
    const defaults = buildGlobalConfig()
    if (existingGlobal.enabled === undefined) existingGlobal.enabled = true
    if (!existingGlobal.taskEnv) existingGlobal.taskEnv = {}
    Object.assign(existingGlobal.taskEnv, defaults.taskEnv)
    writeJson(globalCfgPath, existingGlobal)
  }

  // Install /prove skill
  const skillDir = path.join(claudeDir, 'skills', 'prove')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.copyFileSync(
    path.join(__dirname, 'lib', 'skills', 'prove.md'),
    path.join(skillDir, 'SKILL.md')
  )

  log('prove_it installed.')
  log(`  Settings: ${settingsPath}`)
  log(`  Config:   ${globalCfgPath}`)
  log(`  Skill:    ${path.join(skillDir, 'SKILL.md')}`)
  log('')
  log('════════════════════════════════════════════════════════════════════')
  log('IMPORTANT: Restart Claude Code for hooks to take effect.')
  log('════════════════════════════════════════════════════════════════════')
  log('')
  log('Next steps:')
  log('  1. Restart Claude Code (required)')
  log('  2. Run: prove_it init  in a repo to add project config')
  log('  3. Run: prove_it doctor  to verify installation')
}

// ============================================================================
// Uninstall command
// ============================================================================

function cmdUninstall () {
  const claudeDir = getClaudeDir()
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath)

  if (settings && settings.hooks) {
    for (const k of Object.keys(settings.hooks)) {
      settings.hooks[k] = removeProveItGroups(settings.hooks[k])
      if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
        delete settings.hooks[k]
      }
    }
    writeJson(settingsPath, settings)
  }

  // Remove prove_it files (best-effort)
  rmIfExists(path.join(claudeDir, 'prove_it'))
  rmIfExists(path.join(claudeDir, 'rules', 'prove_it.md'))
  rmIfExists(path.join(claudeDir, 'skills', 'prove'))

  log('prove_it uninstalled.')
  log(`  Settings: ${settingsPath}`)
  log('  Removed: ~/.claude/prove_it/')
  log('  Removed: ~/.claude/rules/prove_it.md')
  log('  Removed: ~/.claude/skills/prove/')
}

// ============================================================================
// Init command
// ============================================================================

/**
 * Ask a yes/no question via readline.
 * @returns {Promise<boolean>}
 */
function askYesNo (rl, question, defaultYes = true) {
  const hint = defaultYes ? '(Y/n)' : '(y/N)'
  return new Promise(resolve => {
    rl.question(`${question} ${hint} `, answer => {
      const trimmed = answer.trim().toLowerCase()
      if (trimmed === '') return resolve(defaultYes)
      resolve(trimmed === 'y' || trimmed === 'yes')
    })
  })
}

/**
 * Parse init flags from argv.
 * Returns { flags, hasExplicitFlags } where flags contains the parsed values
 * and hasExplicitFlags indicates whether any flags were explicitly provided.
 */
function parseInitFlags (args) {
  const flags = { gitHooks: true, defaultChecks: true, autoMergeGitHooks: false, overwrite: null }
  let hasExplicitFlags = false

  for (const arg of args) {
    if (arg === '--git-hooks') { flags.gitHooks = true; hasExplicitFlags = true } else if (arg === '--no-git-hooks') { flags.gitHooks = false; hasExplicitFlags = true } else if (arg === '--default-checks') { flags.defaultChecks = true; hasExplicitFlags = true } else if (arg === '--no-default-checks') { flags.defaultChecks = false; hasExplicitFlags = true } else if (arg === '--automatic-git-hook-merge') { flags.autoMergeGitHooks = true; hasExplicitFlags = true } else if (arg === '--no-automatic-git-hook-merge') { flags.autoMergeGitHooks = false; hasExplicitFlags = true } else if (arg === '--overwrite') { flags.overwrite = true; hasExplicitFlags = true } else if (arg === '--no-overwrite') { flags.overwrite = false; hasExplicitFlags = true }
  }

  return { flags, hasExplicitFlags }
}

function scriptHasRecord (filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return content.includes('prove_it record')
  } catch {
    return false
  }
}

async function cmdInit () {
  const { initProject, overwriteTeamConfig } = require('./lib/init')
  const repoRoot = process.cwd()

  const args = process.argv.slice(3)
  const { flags, hasExplicitFlags } = parseInitFlags(args)

  const isTTY = process.stdin.isTTY && process.stdout.isTTY

  const rl = (isTTY && !hasExplicitFlags)
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null

  try {
    // Interactive mode: TTY with no explicit flags
    if (rl) {
      flags.gitHooks = await askYesNo(rl, 'Install git hooks?')

      if (flags.gitHooks) {
        const hasExistingHooks =
          fs.existsSync(path.join(repoRoot, '.git', 'hooks', 'pre-commit')) ||
          fs.existsSync(path.join(repoRoot, '.git', 'hooks', 'pre-push'))
        if (hasExistingHooks) {
          flags.autoMergeGitHooks = await askYesNo(rl, 'Merge with existing git hooks automatically?')
        }
      }

      flags.defaultChecks = await askYesNo(rl, 'Include default checks (code review, coverage review)?')
    }

    const results = initProject(repoRoot, flags)

    // Handle edited config — prompt or respect --overwrite/--no-overwrite
    let overwritten = false
    if (results.teamConfig.edited) {
      if (flags.overwrite === true) {
        overwriteTeamConfig(repoRoot, flags)
        overwritten = true
      } else if (flags.overwrite === null && rl) {
        const doOverwrite = await askYesNo(rl, 'Existing prove_it.json has been customized. Overwrite with current defaults?', false)
        if (doOverwrite) {
          overwriteTeamConfig(repoRoot, flags)
          overwritten = true
        }
      }
      // flags.overwrite === false or user said no → keep existing
    }

    log('prove_it initialized.\n')

    if (results.teamConfig.created) {
      log(`  Created: ${results.teamConfig.path}`)
    } else if (results.teamConfig.upgraded) {
      log(`  Updated: ${results.teamConfig.path} (upgraded to current defaults)`)
    } else if (overwritten) {
      log(`  Updated: ${results.teamConfig.path} (overwritten with current defaults)`)
    } else if (results.teamConfig.upToDate) {
      log(`  Exists:  ${results.teamConfig.path} (up to date)`)
    } else if (results.teamConfig.edited) {
      log(`  Exists:  ${results.teamConfig.path} (customized)`)
    } else {
      log(`  Exists:  ${results.teamConfig.path}`)
    }

    if (results.localConfig.created) {
      log(`  Created: ${results.localConfig.path}`)
    } else {
      log(`  Exists:  ${results.localConfig.path}`)
    }

    if (results.ruleFile.created) {
      log(`  Created: ${results.ruleFile.path}`)
    } else if (results.ruleFile.existed) {
      log(`  Exists:  ${results.ruleFile.path}`)
    }

    if (results.scriptTest.created) {
      log(`  Created: ${results.scriptTest.path} (stub)`)
    } else if (results.scriptTest.isStub) {
      log(`  Exists:  ${results.scriptTest.path} (stub - needs customization)`)
    } else {
      log(`  Exists:  ${results.scriptTest.path}`)
    }

    if (results.scriptTestFast.created) {
      log(`  Created: ${results.scriptTestFast.path} (stub)`)
    } else if (results.scriptTestFast.isStub) {
      log(`  Exists:  ${results.scriptTestFast.path} (stub - needs customization)`)
    } else {
      log(`  Exists:  ${results.scriptTestFast.path}`)
    }

    if (results.addedToGitignore) {
      log('  Added to .gitignore: .claude/prove_it.local.json')
    }

    // Report git hook results
    const skippedHooks = []
    if (results.gitHookFiles.preCommit || results.gitHookFiles.prePush) {
      for (const [label, hookName] of [['pre-commit', 'preCommit'], ['pre-push', 'prePush']]) {
        const r = results.gitHookFiles[hookName]
        if (!r) continue
        if (r.installed) log(`  Installed: .git/hooks/${label}`)
        else if (r.merged) log(`  Merged: .git/hooks/${label} (appended prove_it)`)
        else if (r.skipped) skippedHooks.push(label)
        else if (r.repositioned) log(`  Fixed: .git/hooks/${label} (moved prove_it before exec)`)
        else if (r.existed) log(`  Exists: .git/hooks/${label} (already has prove_it)`)
      }
    }

    if (skippedHooks.length > 0) {
      const hooks = skippedHooks.join(', ')
      console.error(`\nError: existing git hooks found: ${hooks}`)
      console.error('Either merge prove_it into your hooks manually, or re-run with --automatic-git-hook-merge')
      process.exit(1)
    }

    // Build TODO list
    const todos = []
    const scriptsNeedingRecord = []

    for (const [scriptPath, label, editMsg] of [
      ['script/test', 'script/test', 'Edit script/test to run your full test suite'],
      ['script/test_fast', 'script/test_fast', 'Edit script/test_fast to run your fast (unit) tests']
    ]) {
      const resultKey = scriptPath === 'script/test' ? 'scriptTest' : 'scriptTestFast'
      const scriptResult = results[resultKey]
      if (scriptResult.isStub) {
        todos.push({ done: false, text: editMsg })
      } else if (!scriptHasRecord(path.join(repoRoot, scriptPath))) {
        scriptsNeedingRecord.push(label)
      } else {
        todos.push({ done: true, text: `${label} records results` })
      }
    }

    if (results.ruleFile.created) {
      todos.push({
        done: false,
        text: "Customize .claude/rules/testing.md with your project's testing standards"
      })
    }

    // Sources glob TODO — check the team config for placeholder globs
    const teamCfg = loadJson(path.join(repoRoot, '.claude', 'prove_it.json'))
    const teamSources = teamCfg?.sources
    if (Array.isArray(teamSources) && teamSources.some(s => s.includes('replace/these/with/globs'))) {
      todos.push({
        done: false,
        text: 'Replace the placeholder sources globs in .claude/prove_it.json\n' +
          '        Sources controls which files trigger mtime-based reviewer gating\n' +
          '        and git-based churn tracking (e.g. ["src/**/*.*", "test/**/*.*"])'
      })
    } else if (Array.isArray(teamSources) && teamSources.length > 0) {
      todos.push({ done: true, text: 'Sources globs configured' })
    }

    if (results.teamConfig.upgraded || overwritten) {
      todos.push({
        done: false,
        text: 'Review updated .claude/prove_it.json (check commands)'
      })
    } else {
      todos.push({
        done: false,
        text: 'Customize .claude/prove_it.json (check commands)'
      })
    }

    if (results.teamConfigNeedsCommit || results.teamConfig.upgraded || overwritten) {
      todos.push({ done: false, text: 'Commit changes' })
    } else if (results.teamConfig.existed) {
      todos.push({ done: true, text: '.claude/prove_it.json committed' })
    }

    log('\nTODO:')
    for (const todo of todos) {
      const checkbox = todo.done ? '[x]' : '[ ]'
      log(`  ${checkbox} ${todo.text}`)
    }

    if (scriptsNeedingRecord.length > 0) {
      log(`\n  [ ] To skip redundant test runs, add this trap to ${scriptsNeedingRecord.join(' and ')}:`)
      for (const label of scriptsNeedingRecord) {
        const checkName = label === 'script/test' ? 'full-tests' : 'fast-tests'
        log(`\n    # ${label}`)
        log(`    trap 'prove_it record --name ${checkName} --result $?' EXIT`)
      }
    }
    log('')
  } finally {
    if (rl) rl.close()
  }
}

// ============================================================================
// Deinit command
// ============================================================================

const PROVE_IT_PROJECT_FILES = [
  '.claude/prove_it.json',
  '.claude/prove_it.local.json'
]

function cmdDeinit () {
  const { isScriptTestStub, isDefaultRuleFile, removeGitHookShim } = require('./lib/init')
  const repoRoot = process.cwd()
  const removed = []
  const skipped = []

  for (const relPath of PROVE_IT_PROJECT_FILES) {
    const absPath = path.join(repoRoot, relPath)
    if (fs.existsSync(absPath)) {
      rmIfExists(absPath)
      removed.push(relPath)
    }
  }

  for (const scriptRel of ['script/test', 'script/test_fast']) {
    const scriptAbs = path.join(repoRoot, scriptRel)
    if (fs.existsSync(scriptAbs)) {
      try {
        if (isScriptTestStub(scriptAbs)) {
          rmIfExists(scriptAbs)
          removed.push(scriptRel)
        } else {
          skipped.push(`${scriptRel} (customized)`)
        }
      } catch {
        skipped.push(`${scriptRel} (error reading)`)
      }
    }
  }

  // Remove script/ directory if empty
  const scriptDir = path.join(repoRoot, 'script')
  try {
    if (fs.existsSync(scriptDir) && fs.readdirSync(scriptDir).length === 0) {
      fs.rmdirSync(scriptDir)
      removed.push('script/')
    }
  } catch {}

  // Clean up git hook shims
  if (fs.existsSync(path.join(repoRoot, '.git'))) {
    for (const gitEvent of ['pre-commit', 'pre-push']) {
      if (removeGitHookShim(repoRoot, gitEvent)) {
        removed.push(`.git/hooks/${gitEvent}`)
      }
    }
  }

  // Clean up prove_it git refs (churn tracking)
  if (fs.existsSync(path.join(repoRoot, '.git'))) {
    const { deleteAllRefs } = require('./lib/git')
    const refCount = deleteAllRefs(repoRoot)
    if (refCount > 0) {
      removed.push(`refs/worktree/prove_it/* (${refCount} refs)`)
    }
  }

  // Clean up default rule file (only if unmodified)
  const ruleFilePath = path.join(repoRoot, '.claude', 'rules', 'testing.md')
  if (fs.existsSync(ruleFilePath)) {
    if (isDefaultRuleFile(ruleFilePath)) {
      rmIfExists(ruleFilePath)
      removed.push('.claude/rules/testing.md')
      // Remove rules/ directory if empty
      const rulesDir = path.join(repoRoot, '.claude', 'rules')
      try {
        if (fs.existsSync(rulesDir) && fs.readdirSync(rulesDir).length === 0) {
          fs.rmdirSync(rulesDir)
          removed.push('.claude/rules/')
        }
      } catch {}
    } else {
      skipped.push('.claude/rules/testing.md (customized)')
    }
  }

  const claudeDir = path.join(repoRoot, '.claude')
  if (fs.existsSync(claudeDir)) {
    try {
      const contents = fs.readdirSync(claudeDir)
      if (contents.length === 0) {
        fs.rmdirSync(claudeDir)
        removed.push('.claude/')
      }
    } catch {}
  }

  log('prove_it project files removed.')
  if (removed.length > 0) {
    log('  Removed:')
    for (const f of removed) log(`    - ${f}`)
  }
  if (skipped.length > 0) {
    log('  Skipped:')
    for (const f of skipped) log(`    - ${f}`)
  }
  if (removed.length === 0 && skipped.length === 0) {
    log('  (nothing to remove)')
  }
}

// ============================================================================
// Doctor command
// ============================================================================

function findProveItGroup (settings, eventName) {
  const groups = settings.hooks?.[eventName]
  if (!Array.isArray(groups)) return null
  return groups.find(g => {
    const hooks = g && g.hooks ? g.hooks : []
    return hooks.some(h => h.command && h.command.includes('prove_it hook'))
  }) || null
}

function checkDispatcher (settings, eventName, expectedCommand, expectedMatcher, issues) {
  const group = findProveItGroup(settings, eventName)
  if (!group) {
    log(`  [ ] ${eventName} dispatcher`)
    issues.push(`${eventName} dispatcher not registered`)
    return
  }

  const hook = group.hooks.find(h => h.command && h.command.includes('prove_it hook'))
  const subIssues = []

  if (hook.command !== expectedCommand) {
    subIssues.push(`command is "${hook.command}", expected "${expectedCommand}"`)
  }

  if (expectedMatcher !== null) {
    if (group.matcher !== expectedMatcher) {
      subIssues.push(`matcher is "${group.matcher || '(missing)'}", expected "${expectedMatcher}"`)
    }
  } else {
    // Stop should have no matcher
    if (group.matcher) {
      subIssues.push(`has unexpected matcher "${group.matcher}"`)
    }
  }

  if (subIssues.length === 0) {
    const matcherNote = expectedMatcher ? ` (matcher: ${expectedMatcher})` : ''
    log(`  [x] ${eventName} dispatcher${matcherNote}`)
  } else {
    const matcherNote = expectedMatcher ? ` (matcher: ${expectedMatcher})` : ''
    log(`  [!] ${eventName} dispatcher${matcherNote}`)
    for (const sub of subIssues) {
      log(`      ${sub}`)
      issues.push(`${eventName} dispatcher: ${sub}`)
    }
  }
}

function cmdDoctor () {
  const { loadEffectiveConfig } = require('./lib/config')
  const { validateConfig } = require('./lib/validate')
  const { isTrackedByGit, isProveItShim, hasProveItSection, hasExecLine, isProveItAfterExec } = require('./lib/init')
  const claudeDir = getClaudeDir()
  const repoRoot = process.cwd()
  const issues = []

  log('prove_it doctor\n')
  log('Global installation:')

  // Check settings.json for hook registration — per-dispatcher structured validation
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath)
  if (settings && settings.hooks) {
    checkDispatcher(settings, 'SessionStart', 'prove_it hook claude:SessionStart', 'startup|resume|clear|compact', issues)
    checkDispatcher(settings, 'PreToolUse', 'prove_it hook claude:PreToolUse', 'Edit|Write|NotebookEdit|Bash', issues)
    checkDispatcher(settings, 'Stop', 'prove_it hook claude:Stop', null, issues)
  } else {
    log('  [ ] settings.json missing or has no hooks')
    issues.push("Run 'prove_it install' to register hooks")
  }

  // Check /prove skill
  const skillPath = path.join(claudeDir, 'skills', 'prove', 'SKILL.md')
  const shippedSkillPath = path.join(__dirname, 'lib', 'skills', 'prove.md')
  if (fs.existsSync(skillPath)) {
    const installed = fs.readFileSync(skillPath, 'utf8')
    const shipped = fs.readFileSync(shippedSkillPath, 'utf8')
    if (installed === shipped) {
      log('  [x] /prove skill (current)')
    } else {
      log('  [!] /prove skill (outdated — run prove_it install to update)')
      issues.push('/prove skill is outdated')
    }
  } else {
    log('  [ ] /prove skill not installed')
    issues.push("/prove skill not installed — run 'prove_it install'")
  }

  log('\nCurrent repository:')

  // Check for test scripts
  const scriptTest = path.join(repoRoot, 'script', 'test')
  const scriptTestFast = path.join(repoRoot, 'script', 'test_fast')

  if (fs.existsSync(scriptTest)) {
    log('  [x] Full test script exists: ./script/test')
  } else {
    log('  [ ] Full test script missing: ./script/test')
    issues.push('Create ./script/test for this repository')
  }

  if (fs.existsSync(scriptTestFast)) {
    log('  [x] Fast test script exists: ./script/test_fast')
  } else {
    log('  [ ] Fast test script not configured (optional): ./script/test_fast')
  }

  // Check team config
  const teamConfigPath = path.join(repoRoot, '.claude', 'prove_it.json')
  if (fs.existsSync(teamConfigPath)) {
    log('  [x] Team config exists: .claude/prove_it.json')
    const teamCfg = loadJson(teamConfigPath)
    if (teamCfg?.configVersion === 3) {
      const hookCount = (teamCfg.hooks || []).length
      log(`      Config v3: ${hookCount} hook entries`)
    } else {
      log(`      Warning: config has configVersion ${teamCfg?.configVersion || 'missing'}, expected 3`)
      issues.push('Config may need migration to v3 format')
    }

    // Sub-check: is team config tracked by git?
    if (fs.existsSync(path.join(repoRoot, '.git'))) {
      if (isTrackedByGit(repoRoot, '.claude/prove_it.json')) {
        log('      Tracked by git')
      } else {
        log('      [ ] Not tracked by git')
        issues.push('Team config .claude/prove_it.json is not committed to git')
      }
    }
  } else {
    log('  [ ] Team config missing: .claude/prove_it.json')
    issues.push("Run 'prove_it init' to create project config")
  }

  // Check local config
  const localConfigPath = path.join(repoRoot, '.claude', 'prove_it.local.json')
  if (fs.existsSync(localConfigPath)) {
    log('  [x] Local config exists: .claude/prove_it.local.json')
    const localConfig = loadJson(localConfigPath)
    if (localConfig?.runs) {
      for (const [key, run] of Object.entries(localConfig.runs)) {
        const status = run.pass ? 'passed' : 'failed'
        log(`      Last ${key}: ${status} at ${new Date(run.at).toISOString()}`)
      }
    }
  } else {
    log('  [ ] Local config missing (optional): .claude/prove_it.local.json')
  }

  // Check .gitignore
  const gitignorePath = path.join(repoRoot, '.gitignore')
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8')
    if (gitignoreContent.includes('prove_it.local.json')) {
      log('  [x] .gitignore includes prove_it.local.json')
    } else {
      log('  [ ] .gitignore missing prove_it.local.json')
      issues.push('Add .claude/prove_it.local.json to .gitignore')
    }
  }

  // Effective merged config
  log('\nEffective config:')
  let effectiveCfg = null
  try {
    const defaultFn = () => ({
      enabled: false,
      sources: null,
      hooks: []
    })
    const { cfg } = loadEffectiveConfig(repoRoot, defaultFn)
    effectiveCfg = cfg
    log(JSON.stringify(cfg, null, 2).split('\n').map(l => '  ' + l).join('\n'))
  } catch (e) {
    log(e.message.split('\n').map(l => '  ' + l).join('\n'))
    issues.push('Config validation failed (see above)')
  }

  // Config-aware checks (derived from effective config)
  if (effectiveCfg) {
    log('\nConfig checks:')

    // 1. Sources placeholder check
    const sources = effectiveCfg.sources
    if (Array.isArray(sources) && sources.some(s => s.includes('replace/these/with/globs'))) {
      log('  [ ] Sources need customizing (placeholder glob found)')
      issues.push('Replace placeholder globs in sources with your actual source/test file patterns')
    } else if (Array.isArray(sources) && sources.length > 0) {
      log('  [x] Sources configured')
    }

    // 2. Config validation warnings
    const result = validateConfig(effectiveCfg)
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        log(`  [!] ${w}`)
        issues.push(w)
      }
    }

    // 3. Git hook shims — for each type:'git' hook in config
    const gitHooks = (effectiveCfg.hooks || []).filter(h => h.type === 'git')
    if (gitHooks.length > 0 && fs.existsSync(path.join(repoRoot, '.git'))) {
      for (const hook of gitHooks) {
        const event = hook.event
        const hookPath = path.join(repoRoot, '.git', 'hooks', event)
        if (fs.existsSync(hookPath) && (isProveItShim(hookPath) || hasProveItSection(hookPath))) {
          const hookContent = fs.readFileSync(hookPath, 'utf8')
          if (hasExecLine(hookContent) && isProveItAfterExec(hookContent)) {
            log(`  [!] Git hook shim unreachable: .git/hooks/${event} has 'exec' before prove_it section (run 'prove_it init' to fix)`)
            issues.push(`Git hook shim unreachable: .git/hooks/${event} has 'exec' before prove_it section`)
          } else {
            log(`  [x] Git hook shim installed: .git/hooks/${event}`)
          }
        } else if (fs.existsSync(hookPath)) {
          log(`  [ ] Git hook exists but missing prove_it shim: .git/hooks/${event}`)
          issues.push(`Git hook .git/hooks/${event} exists but doesn't contain prove_it shim`)
        } else {
          log(`  [ ] Git hook shim missing: .git/hooks/${event}`)
          issues.push(`Git hook shim missing for ${event} (run 'prove_it init' to install)`)
        }
      }
    }
  }

  // Summary
  log('')
  if (issues.length === 0) {
    log('Status: All checks passed.')
  } else {
    log('Issues found:')
    for (const issue of issues) {
      log(`  - ${issue}`)
    }
  }
}

// ============================================================================
// Hook command - dispatches to claude or git dispatcher
// ============================================================================

function cmdHook (hookSpec) {
  if (!hookSpec || !hookSpec.includes(':')) {
    console.error(`Invalid hook spec: ${hookSpec}`)
    console.error('Usage: prove_it hook claude:<Event> or prove_it hook git:<event>')
    console.error('Examples: prove_it hook claude:Stop, prove_it hook git:pre-commit')
    process.exit(1)
  }

  const [type, event] = hookSpec.split(':', 2)

  if (type === 'claude') {
    const { dispatch } = require('./lib/dispatcher/claude')
    dispatch(event)
  } else if (type === 'git') {
    const { dispatch } = require('./lib/dispatcher/git')
    dispatch(event)
  } else {
    console.error(`Unknown hook type: ${type}`)
    console.error('Supported types: claude, git')
    process.exit(1)
  }
}

// ============================================================================
// Record command - record a test run result for mtime caching
// ============================================================================

function cmdRecord () {
  const { saveRunData } = require('./lib/testing')

  const args = process.argv.slice(3)
  let name = null
  let hasPass = false
  let hasFail = false
  let hasResult = false
  let resultCode = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && i + 1 < args.length) {
      name = args[++i]
    } else if (args[i] === '--pass') {
      hasPass = true
    } else if (args[i] === '--fail') {
      hasFail = true
    } else if (args[i] === '--result') {
      hasResult = true
      if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
        resultCode = parseInt(args[++i], 10)
      }
    }
  }

  // Exactly one mode must be provided
  const modeCount = (hasPass ? 1 : 0) + (hasFail ? 1 : 0) + (hasResult ? 1 : 0)
  if (!name || modeCount !== 1 || (hasResult && resultCode === null)) {
    console.error('Usage: prove_it record --name <checkName> --pass|--fail|--result <N>')
    process.exit(1)
  }

  const pass = hasResult ? resultCode === 0 : hasPass
  const exitCode = hasResult ? resultCode : (pass ? 0 : 1)

  const localCfgPath = path.join(process.cwd(), '.claude', 'prove_it.local.json')
  const runKey = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  saveRunData(localCfgPath, runKey, { at: Date.now(), pass })

  console.error(`prove_it: recorded ${runKey} ${pass ? 'pass' : 'fail'}`)
  process.exit(exitCode)
}

// ============================================================================
// Run check command - run a builtin check directly
// ============================================================================

function cmdRunCheck () {
  const builtinName = process.argv[3]
  if (!builtinName) {
    console.error('Usage: prove_it run_builtin <namespace>:<name>')
    console.error('Example: prove_it run_builtin config:lock')
    process.exit(1)
  }

  const builtins = require('./lib/checks/builtins')
  const fn = builtins[builtinName]
  if (typeof fn !== 'function') {
    console.error(`Unknown builtin: ${builtinName}`)
    console.error(`Available: ${Object.keys(builtins).filter(k => typeof builtins[k] === 'function').join(', ')}`)
    process.exit(1)
  }

  const { resolveTestRoot } = require('./lib/testing')
  const projectDir = process.cwd()
  const rootDir = resolveTestRoot(projectDir)

  const context = {
    rootDir,
    projectDir,
    sessionId: null,
    toolName: null,
    toolInput: null,
    sources: null,
    maxChars: 12000
  }

  const check = { name: builtinName, type: 'script', command: `prove_it run_builtin ${builtinName}` }
  const result = fn(check, context)
  if (result.output) console.log(result.output)
  process.exit(result.pass ? 0 : 1)
}

// ============================================================================
// Monitor command
// ============================================================================

function cmdMonitor () {
  const { monitor } = require('./lib/monitor')
  const args = process.argv.slice(3)

  const all = args.includes('--all')
  const sessionId = args.find(a => !a.startsWith('--')) || null

  monitor({ all, sessionId })
}

// ============================================================================
// Main CLI
// ============================================================================

function showHelp () {
  log(`prove_it - Config-driven hook framework for Claude Code

Usage: prove_it <command>

Commands:
  install     Install prove_it globally (~/.claude/) and /prove skill
  uninstall   Remove prove_it from global config
  reinstall   Uninstall and reinstall global hooks
  init        Initialize prove_it in current repository
  deinit      Remove prove_it files from current repository
  reinit      Deinit and re-init current repository
  doctor      Check installation status and report issues
  monitor     Tail hook results in real time (run in a separate terminal)
  hook        Run a hook dispatcher (claude:<Event> or git:<event>)
  run_builtin   Run a builtin check directly (e.g. prove_it run_builtin config:lock)
  record      Record a test run result for mtime caching
  help        Show this help message
  -v, --version  Show version number

Monitor options:
  prove_it monitor             Tail most recent session
  prove_it monitor --all       Tail all sessions and project logs
  prove_it monitor <id>        Tail a specific session (prefix match OK)

Record options:
  --name <name>    Check name to record (must match hook config)
  --pass           Record a successful run (exits 0)
  --fail           Record a failed run (exits 1)
  --result <N>     Record pass (N=0) or fail (N!=0), exit with code N

Init options:
  --[no-]git-hooks                Install git hooks (pre-commit, pre-push) (default: yes)
  --[no-]default-checks           Include code review, coverage review (default: yes)
  --[no-]automatic-git-hook-merge Merge with existing git hooks (default: yes)
  --[no-]overwrite                Overwrite customized prove_it.json with defaults

  With no flags and a TTY, prove_it init asks interactively.
  With no flags and no TTY, all defaults apply (equivalent to all features on).

Examples:
  prove_it install                         # Set up global hooks
  prove_it init                            # Interactive setup
  prove_it init --no-git-hooks             # Skip git hooks
  prove_it init --no-default-checks        # Base config only (no agents)
  prove_it doctor                          # Check installation status
  prove_it monitor                         # Watch hook results in real time
  prove_it deinit                          # Remove prove_it from current repo
  prove_it uninstall                       # Remove global hooks
`)
}

function getVersion () {
  const pkg = loadJson(path.join(__dirname, 'package.json'))
  return pkg?.version || 'unknown'
}

function main () {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'install':
      cmdInstall()
      break
    case 'uninstall':
      cmdUninstall()
      break
    case 'reinstall':
      cmdUninstall()
      cmdInstall()
      break
    case 'init':
      cmdInit().catch(err => {
        console.error(`prove_it init failed: ${err.message}`)
        process.exit(1)
      })
      break
    case 'deinit':
      cmdDeinit()
      break
    case 'reinit':
      cmdDeinit()
      cmdInit().catch(err => {
        console.error(`prove_it reinit failed: ${err.message}`)
        process.exit(1)
      })
      break
    case 'doctor':
    case 'diagnose':
      cmdDoctor()
      break
    case 'hook':
      cmdHook(args[1])
      break
    case 'record':
      cmdRecord()
      break
    case 'run_builtin':
      cmdRunCheck()
      break
    case 'monitor':
      cmdMonitor()
      break
    case '-v':
    case '--version':
    case 'version':
      log(getVersion())
      break
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showHelp()
      break
    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run "prove_it help" for usage.')
      process.exit(1)
  }
}

main()
