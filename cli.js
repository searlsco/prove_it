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
 *   hook      - Run a hook dispatcher (claude:<Event> or git:<event>)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson, writeJson } = require('./lib/shared')

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
    // Remove old v1 hook registrations
    if (serialized.includes('prove_it_test.js')) return false
    if (serialized.includes('prove_it_session_start.js')) return false
    if (serialized.includes('prove_it_beads.js')) return false
    if (serialized.includes('prove_it_stop.js')) return false
    if (serialized.includes('prove_it_done.js')) return false
    if (serialized.includes('prove_it_edit.js')) return false
    // Remove v2 dispatcher registrations (for re-install / uninstall)
    if (serialized.includes('prove_it hook claude:')) return false
    return true
  })
}

function cmdInstall () {
  const claudeDir = getClaudeDir()
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath) || {}
  if (!settings.hooks) settings.hooks = {}

  // Clean up old-style hook registrations first
  for (const k of Object.keys(settings.hooks)) {
    settings.hooks[k] = removeProveItGroups(settings.hooks[k])
    if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
      delete settings.hooks[k]
    }
  }

  // Register 3 thin dispatchers
  addHookGroup(settings.hooks, 'SessionStart', {
    matcher: 'startup|resume|clear|compact',
    hooks: [{
      type: 'command',
      command: 'prove_it hook claude:SessionStart'
    }]
  })

  addHookGroup(settings.hooks, 'PreToolUse', {
    matcher: 'Edit|Write|NotebookEdit|Bash',
    hooks: [{
      type: 'command',
      command: 'prove_it hook claude:PreToolUse'
    }]
  })

  addHookGroup(settings.hooks, 'Stop', {
    hooks: [{
      type: 'command',
      command: 'prove_it hook claude:Stop',
      timeout: 3600
    }]
  })

  writeJson(settingsPath, settings)

  log('prove_it installed.')
  log(`  Settings: ${settingsPath}`)
  log('')
  log('════════════════════════════════════════════════════════════════════')
  log('IMPORTANT: Restart Claude Code for hooks to take effect.')
  log('════════════════════════════════════════════════════════════════════')
  log('')
  log('Next steps:')
  log('  1. Restart Claude Code (required)')
  log('  2. Run: prove_it init  in a repo to add project config')
  log('  3. Run: prove_it diagnose  to verify installation')
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

  log('prove_it uninstalled.')
  log(`  Settings: ${settingsPath}`)
  log('  Removed: ~/.claude/prove_it/')
  log('  Removed: ~/.claude/rules/prove_it.md')
}

// ============================================================================
// Init command
// ============================================================================

function cmdInit () {
  const { initProject } = require('./lib/init')
  const repoRoot = process.cwd()

  // Parse flags
  const args = process.argv.slice(3)
  let tier = 3
  for (const arg of args) {
    if (arg === '--tier=1' || arg === '--claude-only') tier = 1
    else if (arg === '--tier=2' || arg === '--claude-git') tier = 2
    else if (arg === '--tier=3' || arg === '--all') tier = 3
  }

  const results = initProject(repoRoot, { tier })

  log(`prove_it initialized (tier ${tier}).\n`)

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

  if (results.addedToGitignore) {
    log('  Added to .gitignore: .claude/prove_it.local.json')
  }

  // Build TODO list
  const todos = []

  if (results.scriptTest.isStub) {
    todos.push({ done: false, text: 'Edit script/test to run your full test suite' })
  } else {
    todos.push({ done: true, text: 'script/test configured' })
  }

  const scriptTestFast = path.join(repoRoot, 'script', 'test_fast')
  if (fs.existsSync(scriptTestFast)) {
    todos.push({ done: true, text: 'script/test_fast configured (runs on Stop)' })
  } else {
    todos.push({ done: false, text: 'Create script/test_fast (fast tests, runs on Stop)' })
  }

  todos.push({
    done: false,
    text: 'Customize .claude/prove_it.json (source globs, check commands)'
  })

  if (results.teamConfigNeedsCommit) {
    todos.push({ done: false, text: 'Commit .claude/prove_it.json' })
  } else if (results.teamConfig.existed) {
    todos.push({ done: true, text: '.claude/prove_it.json committed' })
  }

  log('\nTODO:')
  for (const todo of todos) {
    const checkbox = todo.done ? '[x]' : '[ ]'
    log(`  ${checkbox} ${todo.text}`)
  }
  log('')
}

// ============================================================================
// Deinit command
// ============================================================================

const PROVE_IT_PROJECT_FILES = [
  '.claude/prove_it.json',
  '.claude/prove_it.local.json'
]

function cmdDeinit () {
  const { isScriptTestStub } = require('./lib/init')
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

  const scriptTest = path.join(repoRoot, 'script', 'test')
  if (fs.existsSync(scriptTest)) {
    try {
      if (isScriptTestStub(scriptTest)) {
        rmIfExists(scriptTest)
        removed.push('script/test')
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
  const { loadEffectiveConfig } = require('./lib/config')
  const claudeDir = getClaudeDir()
  const repoRoot = process.cwd()
  const issues = []

  log('prove_it diagnose\n')
  log('Global installation:')

  // Check settings.json for hook registration
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath)
  if (settings && settings.hooks) {
    const serialized = JSON.stringify(settings.hooks)
    const hasSessionStart = serialized.includes('prove_it hook claude:SessionStart')
    const hasPreToolUse = serialized.includes('prove_it hook claude:PreToolUse')
    const hasStop = serialized.includes('prove_it hook claude:Stop')

    if (hasSessionStart && hasPreToolUse && hasStop) {
      log('  [x] Hooks registered in settings.json (3 dispatchers)')
    } else {
      log('  [ ] Hooks not fully registered in settings.json')
      if (!hasSessionStart) issues.push('SessionStart dispatcher not registered')
      if (!hasPreToolUse) issues.push('PreToolUse dispatcher not registered')
      if (!hasStop) issues.push('Stop dispatcher not registered')
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
    const teamCfg = loadJson(teamConfigPath)
    if (teamCfg?.configVersion === 2) {
      const hookCount = (teamCfg.hooks || []).length
      log(`      Config v2: ${hookCount} hook entries`)
    } else {
      log('      Warning: config missing configVersion: 2')
      issues.push('Config may need migration to v2 format')
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

  // Check beads
  const beadsDir = path.join(repoRoot, '.beads')
  if (fs.existsSync(beadsDir)) {
    log('  [x] Beads directory exists: .beads/')
  } else {
    log('  [ ] Beads not initialized (optional): .beads/')
  }

  // Effective merged config
  log('\nEffective config (merged):')
  try {
    const defaultFn = () => ({
      enabled: true,
      sources: null,
      format: { maxOutputChars: 12000 },
      hooks: []
    })
    const { cfg } = loadEffectiveConfig(repoRoot, defaultFn)
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
// Main CLI
// ============================================================================

function showHelp () {
  log(`prove_it - Config-driven hook framework for Claude Code

Usage: prove_it <command>

Commands:
  install     Install prove_it globally (~/.claude/)
  uninstall   Remove prove_it from global config
  init        Initialize prove_it in current repository
  deinit      Remove prove_it files from current repository
  diagnose    Check installation status and report issues
  hook        Run a hook dispatcher (claude:<Event> or git:<event>)
  help        Show this help message
  -v, --version  Show version number

Init options:
  --tier=1, --claude-only   Claude hooks only
  --tier=2, --claude-git    Claude + Git hooks
  --tier=3, --all           Claude + Git + Default checks (default)

Examples:
  prove_it install           # Set up global hooks
  prove_it init              # Add project config (tier 3)
  prove_it init --tier=1     # Minimal: claude hooks only
  prove_it diagnose          # Check installation status
  prove_it deinit            # Remove prove_it from current repo
  prove_it uninstall         # Remove global hooks
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
