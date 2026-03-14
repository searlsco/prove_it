const fs = require('fs')
const path = require('path')
const { loadJson } = require('../shared')
const { generateStandaloneSkill } = require('../skills')
const { SKILLS, RETIRED_SKILLS, getClaudeDir, log, findProveItGroup } = require('./_helpers')

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
  const { loadEffectiveConfig } = require('../config')
  const { validateConfig } = require('../validate')
  const { isTrackedByGit, isProveItShim, hasProveItSection, hasExecLine, isProveItAfterExec } = require('../init')
  const claudeDir = getClaudeDir()
  const repoRoot = process.cwd()
  const issues = []

  log('prove_it doctor\n')

  // Effective merged config (shown first for quick reference)
  log('Effective combined config:')
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

  log('\nGlobal installation:')

  // Check settings.json for hook registration--per-dispatcher structured validation
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath)
  if (settings && settings.hooks) {
    checkDispatcher(settings, 'SessionStart', 'prove_it hook claude:SessionStart', 'startup|resume|clear|compact', issues)
    checkDispatcher(settings, 'PreToolUse', 'prove_it hook claude:PreToolUse', null, issues)
    checkDispatcher(settings, 'PostToolUse', 'prove_it hook claude:PostToolUse', null, issues)
    checkDispatcher(settings, 'PostToolUseFailure', 'prove_it hook claude:PostToolUseFailure', null, issues)
    checkDispatcher(settings, 'Stop', 'prove_it hook claude:Stop', null, issues)
    checkDispatcher(settings, 'TaskCompleted', 'prove_it hook claude:TaskCompleted', null, issues)
  } else {
    log('  [ ] settings.json missing or has no hooks')
    issues.push("Run 'prove_it install' to register hooks")
  }

  // Check skills
  for (const { name, src } of SKILLS) {
    const skillPath = path.join(claudeDir, 'skills', name, 'SKILL.md')
    const shippedSkillPath = path.join(__dirname, '..', 'skills', src)
    if (fs.existsSync(skillPath)) {
      const installed = fs.readFileSync(skillPath, 'utf8')
      const shipped = fs.readFileSync(shippedSkillPath, 'utf8')
      const expected = generateStandaloneSkill(shipped)
      if (installed === expected) {
        log(`  [x] /${name} skill (current)`)
      } else {
        log(`  [!] /${name} skill (outdated--run prove_it install to update)`)
        issues.push(`/${name} skill is outdated`)
      }
    } else {
      log(`  [ ] /${name} skill not installed`)
      issues.push(`/${name} skill not installed--run 'prove_it install'`)
    }
  }

  // Check for retired skills
  for (const name of RETIRED_SKILLS) {
    const retiredPath = path.join(claudeDir, 'skills', name, 'SKILL.md')
    if (fs.existsSync(retiredPath)) {
      log(`  [!] /${name} skill is retired (run prove_it install to remove)`)
      issues.push(`/${name} skill is retired--run 'prove_it install' to remove`)
    }
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
  const teamConfigPath = path.join(repoRoot, '.claude', 'prove_it', 'config.json')
  if (fs.existsSync(teamConfigPath)) {
    log('  [x] Team config exists: .claude/prove_it/config.json')
    const teamCfg = loadJson(teamConfigPath)
    const hookCount = (teamCfg.hooks || []).length
    log(`      ${hookCount} hook entries`)

    // Sub-check: is team config tracked by git?
    if (fs.existsSync(path.join(repoRoot, '.git'))) {
      if (isTrackedByGit(repoRoot, '.claude/prove_it/config.json')) {
        log('      Tracked by git')
      } else {
        log('      [ ] Not tracked by git')
        issues.push('Team config .claude/prove_it/config.json is not committed to git')
      }
    }
  } else {
    log('  [ ] Team config missing: .claude/prove_it/config.json')
    issues.push("Run 'prove_it init' to create project config")
  }

  // Check local config
  const localConfigPath = path.join(repoRoot, '.claude', 'prove_it', 'config.local.json')
  if (fs.existsSync(localConfigPath)) {
    log('  [x] Local config exists: .claude/prove_it/config.local.json')
    const localConfig = loadJson(localConfigPath)
    if (localConfig?.runs) {
      const { runResult } = require('../testing')
      for (const [key, run] of Object.entries(localConfig.runs)) {
        log(`      Last ${key}: ${runResult(run)} at ${new Date(run.at).toISOString()}`)
      }
    }
  } else {
    log('  [ ] Local config missing (optional): .claude/prove_it/config.local.json')
  }

  // Check .claude/prove_it/.gitignore
  const proveItGitignorePath = path.join(repoRoot, '.claude', 'prove_it', '.gitignore')
  if (fs.existsSync(proveItGitignorePath)) {
    const gitignoreContent = fs.readFileSync(proveItGitignorePath, 'utf8')
    if (gitignoreContent.includes('config.local.json')) {
      log('  [x] .claude/prove_it/.gitignore includes config.local.json')
    } else {
      log('  [ ] .claude/prove_it/.gitignore missing config.local.json')
      issues.push('Add config.local.json to .claude/prove_it/.gitignore')
    }
  } else if (fs.existsSync(path.join(repoRoot, '.claude', 'prove_it'))) {
    log('  [ ] .claude/prove_it/.gitignore missing')
    issues.push("Run 'prove_it init' to create .claude/prove_it/.gitignore")
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

    // 3. Git hook shims--for each type:'git' hook in config
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

module.exports = { cmdDoctor }
