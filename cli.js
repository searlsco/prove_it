#!/usr/bin/env node
/**
 * prove_it CLI
 *
 * Commands:
 *   install   - Install prove_it globally (~/.claude/)
 *   uninstall - Remove prove_it from global config
 *   init      - Initialize prove_it in current repository
 *   deinit    - Remove prove_it files from current repository
 *   diagnose  - Check installation status and report issues
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson, writeJson, ensureDir, loadEffectiveConfig, defaultTestConfig, defaultBeadsConfig, isBeadsRepo } = require('./lib/shared')

function rmIfExists (p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function chmodX (p) {
  try {
    fs.chmodSync(p, 0o755)
  } catch {}
}

function log (...args) {
  console.log(...args)
}

function getClaudeDir () {
  return path.join(os.homedir(), '.claude')
}

function getSrcRoot () {
  return __dirname
}

// ============================================================================
// Install command
// ============================================================================

function addHookGroup (hooksObj, eventName, group) {
  if (!hooksObj[eventName]) hooksObj[eventName] = []
  // Check if this hook already exists (by command string)
  const groupStr = JSON.stringify(group)
  const exists = hooksObj[eventName].some((g) => JSON.stringify(g) === groupStr)
  if (!exists) {
    hooksObj[eventName].push(group)
  }
}

function cmdInstall () {
  const claudeDir = getClaudeDir()
  const srcRoot = getSrcRoot()
  const globalDir = path.join(srcRoot, 'global')

  const dstRulesDir = path.join(claudeDir, 'rules')
  const dstRulesFile = path.join(dstRulesDir, 'prove_it.md')
  const srcRulesFile = path.join(globalDir, 'CLAUDE.md')

  const dstKitDir = path.join(claudeDir, 'prove_it')
  const srcCfg = path.join(globalDir, 'prove_it', 'config.json')
  const dstCfg = path.join(dstKitDir, 'config.json')

  // Copy rules file (always overwrite on upgrade - it's prove_it's file)
  ensureDir(dstRulesDir)
  fs.copyFileSync(srcRulesFile, dstRulesFile)

  // Create config if missing
  ensureDir(dstKitDir)
  if (!fs.existsSync(dstCfg)) {
    fs.copyFileSync(srcCfg, dstCfg)
  }

  // Merge settings.json hooks - call prove_it CLI directly
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath) || {}
  if (!settings.hooks) settings.hooks = {}

  addHookGroup(settings.hooks, 'SessionStart', {
    matcher: 'startup|resume|clear|compact',
    hooks: [
      {
        type: 'command',
        command: 'prove_it hook session-start'
      }
    ]
  })

  addHookGroup(settings.hooks, 'PreToolUse', {
    matcher: 'Bash',
    hooks: [
      {
        type: 'command',
        command: 'prove_it hook done'
      }
    ]
  })

  // Edit gate: config protection + beads enforcement + source filtering
  addHookGroup(settings.hooks, 'PreToolUse', {
    matcher: 'Edit|Write|NotebookEdit|Bash',
    hooks: [
      {
        type: 'command',
        command: 'prove_it hook edit'
      }
    ]
  })

  addHookGroup(settings.hooks, 'Stop', {
    hooks: [
      {
        type: 'command',
        command: 'prove_it hook stop',
        timeout: 3600
      }
    ]
  })

  writeJson(settingsPath, settings)

  log('prove_it installed.')
  log(`  Rules: ${dstRulesFile}`)
  log(`  Config: ${dstCfg}`)
  log(`  Settings: ${settingsPath}`)
  log('')
  log('════════════════════════════════════════════════════════════════════')
  log('IMPORTANT: Restart Claude Code for hooks to take effect.')
  log('════════════════════════════════════════════════════════════════════')
  log('')
  log('Next steps:')
  log('  1. Restart Claude Code (required)')
  log('  2. Run: prove_it init  in a repo to add local templates')
  log('  3. Run: prove_it diagnose  to verify installation')
}

// ============================================================================
// Uninstall command
// ============================================================================

function removeProveItGroups (groups) {
  if (!Array.isArray(groups)) return groups
  return groups.filter((g) => {
    const hooks = g && g.hooks ? g.hooks : []
    const serialized = JSON.stringify(hooks)
    return (
      !serialized.includes('prove_it_test.js') &&
      !serialized.includes('prove_it_session_start.js') &&
      !serialized.includes('prove_it_beads.js') &&
      !serialized.includes('prove_it_stop.js') &&
      !serialized.includes('prove_it_done.js') &&
      !serialized.includes('prove_it_edit.js') &&
      !serialized.includes('prove_it hook')
    )
  })
}

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

  log('prove_it uninstalled.')
  log(`  Settings: ${settingsPath}`)
  log('  Removed: ~/.claude/prove_it/')
  log('  Removed: ~/.claude/rules/prove_it.md')
}

// ============================================================================
// Init command
// ============================================================================

const { execSync } = require('child_process')

function isIgnoredByGit (repoRoot, relativePath) {
  try {
    execSync(`git check-ignore -q "${relativePath}"`, { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function isTrackedByGit (repoRoot, relativePath) {
  try {
    execSync(`git ls-files --error-unmatch "${relativePath}"`, { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function addToGitignore (repoRoot, pattern) {
  const gitignorePath = path.join(repoRoot, '.gitignore')
  let content = ''

  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8')
    // Check if pattern already exists
    if (content.split('\n').some((line) => line.trim() === pattern)) {
      return false // Already present
    }
  }

  // Add pattern with a newline if needed
  if (content && !content.endsWith('\n')) {
    content += '\n'
  }
  content += pattern + '\n'
  fs.writeFileSync(gitignorePath, content)
  return true
}

function isScriptTestStub (scriptTestPath) {
  if (!fs.existsSync(scriptTestPath)) return false
  try {
    const content = fs.readFileSync(scriptTestPath, 'utf8')
    return content.includes('prove_it:')
  } catch {
    return false
  }
}

function cmdInit () {
  const repoRoot = process.cwd()
  const srcRoot = getSrcRoot()
  const tpl = path.join(srcRoot, 'templates', 'project')

  const results = {
    teamConfig: { path: '.claude/prove_it.json', created: false, existed: false },
    localConfig: { path: '.claude/prove_it.local.json', created: false, existed: false },
    scriptTest: { path: 'script/test', created: false, existed: false, isStub: false }
  }

  // Copy team config
  const teamConfigSrc = path.join(tpl, '.claude', 'prove_it.json')
  const teamConfigDst = path.join(repoRoot, '.claude', 'prove_it.json')
  if (fs.existsSync(teamConfigDst)) {
    results.teamConfig.existed = true
  } else {
    ensureDir(path.dirname(teamConfigDst))
    fs.copyFileSync(teamConfigSrc, teamConfigDst)
    results.teamConfig.created = true
  }

  // Copy local config
  const localConfigSrc = path.join(tpl, '.claude', 'prove_it.local.json')
  const localConfigDst = path.join(repoRoot, '.claude', 'prove_it.local.json')
  if (fs.existsSync(localConfigDst)) {
    results.localConfig.existed = true
  } else {
    ensureDir(path.dirname(localConfigDst))
    fs.copyFileSync(localConfigSrc, localConfigDst)
    results.localConfig.created = true
  }

  // Create stub script/test if missing
  const scriptTest = path.join(repoRoot, 'script', 'test')
  if (fs.existsSync(scriptTest)) {
    results.scriptTest.existed = true
    results.scriptTest.isStub = isScriptTestStub(scriptTest)
  } else {
    ensureDir(path.dirname(scriptTest))
    fs.copyFileSync(path.join(srcRoot, 'templates', 'script', 'test'), scriptTest)
    chmodX(scriptTest)
    results.scriptTest.created = true
    results.scriptTest.isStub = true
  }

  // Check script/test_fast
  const scriptTestFast = path.join(repoRoot, 'script', 'test_fast')
  const hasTestFast = fs.existsSync(scriptTestFast)

  // Add prove_it.local.json to .gitignore only if not already covered
  let addedToGitignore = false
  if (!isIgnoredByGit(repoRoot, '.claude/prove_it.local.json')) {
    addedToGitignore = addToGitignore(repoRoot, '.claude/prove_it.local.json')
  }

  // Check if team config needs to be committed
  const teamConfigNeedsCommit =
    fs.existsSync(teamConfigDst) && !isTrackedByGit(repoRoot, '.claude/prove_it.json')

  // Output results
  log('prove_it initialized.\n')

  // What happened
  if (results.teamConfig.created) {
    log(`  Created: ${results.teamConfig.path}`)
  } else {
    log(`  Exists:  ${results.teamConfig.path}`)
  }

  if (results.localConfig.created) {
    log(`  Created: ${results.localConfig.path}`)
  } else {
    log(`  Exists:  ${results.localConfig.path}`)
  }

  if (results.scriptTest.created) {
    log(`  Created: ${results.scriptTest.path} (stub)`)
  } else if (results.scriptTest.isStub) {
    log(`  Exists:  ${results.scriptTest.path} (stub - needs customization)`)
  } else {
    log(`  Exists:  ${results.scriptTest.path} (customized)`)
  }

  if (addedToGitignore) {
    log('  Added to .gitignore: .claude/prove_it.local.json')
  }

  // Build TODO list
  const todos = []

  // script/test TODO
  if (results.scriptTest.isStub) {
    todos.push({
      done: false,
      text: 'Edit script/test to run your full test suite (unit + integration tests)'
    })
  } else {
    todos.push({
      done: true,
      text: 'script/test configured'
    })
  }

  // script/test_fast TODO
  if (hasTestFast) {
    todos.push({
      done: true,
      text: 'script/test_fast configured (runs on Stop)'
    })
  } else {
    todos.push({
      done: false,
      text: 'Create script/test_fast (fast unit tests, runs on Stop)'
    })
  }

  // Customize team config TODO
  todos.push({
    done: false,
    text: 'Customize .claude/prove_it.json (test commands, source globs)'
  })

  // Commit team config TODO
  if (teamConfigNeedsCommit) {
    todos.push({
      done: false,
      text: 'Commit .claude/prove_it.json'
    })
  } else if (fs.existsSync(teamConfigDst)) {
    todos.push({
      done: true,
      text: '.claude/prove_it.json committed'
    })
  }

  // Print TODOs
  log('\nTODO:')
  for (const todo of todos) {
    const checkbox = todo.done ? '[x]' : '[ ]'
    log(`  ${checkbox} ${todo.text}`)
  }
  log('')
  log('See: https://github.com/searlsco/prove_it#configuration')
}

// ============================================================================
// Deinit command
// ============================================================================

// Files/directories that prove_it owns and can safely remove
const PROVE_IT_PROJECT_FILES = [
  '.claude/prove_it.json',
  '.claude/prove_it.local.json'
]

function cmdDeinit () {
  const repoRoot = process.cwd()
  const removed = []
  const skipped = []

  // Remove files we created
  for (const relPath of PROVE_IT_PROJECT_FILES) {
    const absPath = path.join(repoRoot, relPath)
    if (fs.existsSync(absPath)) {
      rmIfExists(absPath)
      removed.push(relPath)
    }
  }

  // Check script/test - only remove if it's still the stub
  const scriptTest = path.join(repoRoot, 'script', 'test')
  if (fs.existsSync(scriptTest)) {
    try {
      if (isScriptTestStub(scriptTest)) {
        rmIfExists(scriptTest)
        removed.push('script/test')
        // Remove script/ dir if empty
        const scriptDir = path.join(repoRoot, 'script')
        try {
          if (fs.readdirSync(scriptDir).length === 0) {
            fs.rmdirSync(scriptDir)
            removed.push('script/')
          }
        } catch {}
      } else {
        skipped.push('script/test (customized)')
      }
    } catch {
      skipped.push('script/test (error reading)')
    }
  }

  // Try to remove .claude/ if empty
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
// Diagnose command
// ============================================================================

function cmdDiagnose () {
  const claudeDir = getClaudeDir()
  const repoRoot = process.cwd()
  const issues = []

  log('prove_it diagnose\n')
  log('Global installation:')

  // Check global config
  const configPath = path.join(claudeDir, 'prove_it', 'config.json')
  if (fs.existsSync(configPath)) {
    log(`  [x] Config exists: ${configPath}`)
  } else {
    log(`  [ ] Config missing: ${configPath}`)
    issues.push("Run 'prove_it install' to create config")
  }

  // Check settings.json for hook registration
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath)
  if (settings && settings.hooks) {
    const serialized = JSON.stringify(settings.hooks)
    const hasSessionStart = serialized.includes('prove_it hook session-start')
    const hasStop = serialized.includes('prove_it hook stop')
    const hasDone = serialized.includes('prove_it hook done')
    const hasEdit = serialized.includes('prove_it hook edit')

    if (hasSessionStart && hasStop && hasDone && hasEdit) {
      log('  [x] Hooks registered in settings.json')
    } else {
      log('  [ ] Hooks not fully registered in settings.json')
      if (!hasSessionStart) issues.push('SessionStart hook not registered')
      if (!hasStop) issues.push('Stop hook not registered')
      if (!hasDone) issues.push('Done hook not registered')
      if (!hasEdit) issues.push('Edit hook not registered')
    }
  } else {
    log('  [ ] settings.json missing or has no hooks')
    issues.push("Run 'prove_it install' to register hooks")
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
  } else {
    log('  [ ] Team config missing (optional): .claude/prove_it.json')
  }

  // Check local config
  const localConfigPath = path.join(repoRoot, '.claude', 'prove_it.local.json')
  if (fs.existsSync(localConfigPath)) {
    log('  [x] Local config exists: .claude/prove_it.local.json')
    const localConfig = loadJson(localConfigPath)
    if (localConfig?.runs) {
      const fastRun = localConfig.runs.test_fast
      const fullRun = localConfig.runs.test_full
      if (fastRun) {
        const status = fastRun.pass ? 'passed' : 'failed'
        log(`      Last fast run: ${status} at ${new Date(fastRun.at).toISOString()}`)
      }
      if (fullRun) {
        const status = fullRun.pass ? 'passed' : 'failed'
        log(`      Last full run: ${status} at ${new Date(fullRun.at).toISOString()}`)
      }
    }
  } else {
    log('  [ ] Local config missing (optional): .claude/prove_it.local.json')
  }

  // Check .gitignore for prove_it.local.json
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

  // Check beads
  if (isBeadsRepo(repoRoot)) {
    log('  [x] Beads directory exists: .beads/')
    log('      (beads enforcement is active for this repo)')
  } else {
    log('  [ ] Beads not initialized (optional): .beads/')
  }

  // Effective merged config
  log('\nEffective config (merged):')
  try {
    const { cfg } = loadEffectiveConfig(repoRoot, () => ({ ...defaultTestConfig(), ...defaultBeadsConfig() }))
    log(JSON.stringify(cfg, null, 2).split('\n').map(l => '  ' + l).join('\n'))
  } catch (e) {
    log(`  (error loading config: ${e.message})`)
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
// Hook command - runs hook logic directly
// ============================================================================

function cmdHook (hookType) {
  const hookMap = {
    stop: './lib/hooks/prove_it_stop.js',
    done: './lib/hooks/prove_it_done.js',
    edit: './lib/hooks/prove_it_edit.js',
    'session-start': './lib/hooks/prove_it_session_start.js'
  }

  const hookPath = hookMap[hookType]
  if (!hookPath) {
    console.error(`Unknown hook type: ${hookType}`)
    console.error('Available hooks: stop, done, edit, session-start')
    process.exit(1)
  }

  const hook = require(hookPath)
  hook.main()
}

// ============================================================================
// Main CLI
// ============================================================================

function showHelp () {
  log(`prove_it - Verifiability-first hooks for Claude Code

Usage: prove_it <command>

Commands:
  install     Install prove_it globally (~/.claude/)
  uninstall   Remove prove_it from global config
  init        Initialize prove_it in current repository
  deinit      Remove prove_it files from current repository
  diagnose    Check installation status and report issues
  help        Show this help message
  -v, --version  Show version number

Examples:
  prove_it install      # Set up global hooks
  prove_it init         # Add templates to current repo
  prove_it diagnose     # Check installation status
  prove_it deinit       # Remove prove_it from current repo
  prove_it uninstall    # Remove global hooks
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
    case 'init':
      cmdInit()
      break
    case 'deinit':
      cmdDeinit()
      break
    case 'diagnose':
      cmdDiagnose()
      break
    case 'hook':
      cmdHook(args[1])
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
