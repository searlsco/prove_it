const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { loadJson, writeJson, ensureTrailingNewline, getProveItDir, buildGlobalConfig, configHash } = require('../shared')
const { askConflict } = require('../conflict')
const { generateStandaloneSkill } = require('../skills')
const { SKILLS, RETIRED_SKILLS, rmIfExists, getClaudeDir, log, askYesNo, removeProveItGroups, findProveItGroup, buildHookGroups } = require('./_helpers')

function addHookGroup (hooksObj, eventName, group) {
  if (!hooksObj[eventName]) hooksObj[eventName] = []
  const groupStr = JSON.stringify(group)
  const exists = hooksObj[eventName].some(g => JSON.stringify(g) === groupStr)
  if (!exists) {
    hooksObj[eventName].push(group)
  }
}

function isGlobalConfigCurrent () {
  const cfgPath = path.join(getProveItDir(), 'config.json')
  const cfg = loadJson(cfgPath)
  if (!cfg || !cfg.initSeed) return false
  const contentHash = configHash(cfg)
  if (contentHash === cfg.initSeed) {
    // Unedited--current only if it matches fresh defaults
    const fresh = buildGlobalConfig()
    return contentHash === configHash(fresh)
  }
  // Edited--current if all default taskEnv keys are present
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

function areSkillsCurrent (claudeDir) {
  for (const { name, src } of SKILLS) {
    const skillPath = path.join(claudeDir, 'skills', name, 'SKILL.md')
    const shippedPath = path.join(__dirname, '..', 'skills', src)
    if (!fs.existsSync(skillPath)) return false
    const shippedContent = fs.readFileSync(shippedPath, 'utf8')
    const expected = generateStandaloneSkill(shippedContent)
    if (fs.readFileSync(skillPath, 'utf8') !== expected) return false
  }
  return true
}

async function cmdInstall () {
  const claudeDir = getClaudeDir()
  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = loadJson(settingsPath) || {}

  // Check if already up to date
  if (isInstallCurrent(settings) && areSkillsCurrent(claudeDir)) {
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

  // TTY detection + readline (shared by global config merge and skill install)
  const isTTY = process.stdin.isTTY && process.stdout.isTTY
  const skillRl = isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null

  // Global config--seed-based 3-way merge (same pattern as project config)
  const globalCfgPath = path.join(getProveItDir(), 'config.json')
  const existingGlobal = loadJson(globalCfgPath)
  if (!existingGlobal) {
    // No config--write fresh with initSeed
    const fresh = buildGlobalConfig()
    fresh.initSeed = configHash(fresh)
    writeJson(globalCfgPath, fresh)
  } else if (existingGlobal.initSeed && configHash(existingGlobal) === existingGlobal.initSeed) {
    // Unedited--auto-upgrade if defaults changed
    const fresh = buildGlobalConfig()
    const freshHash = configHash(fresh)
    if (configHash(existingGlobal) !== freshHash) {
      fresh.initSeed = freshHash
      writeJson(globalCfgPath, fresh)
    }
  } else if (isTTY && skillRl) {
    // Edited or legacy--interactive merge in TTY
    const proposed = buildGlobalConfig()
    proposed.initSeed = configHash(proposed)
    const result = await askConflict(skillRl, {
      label: globalCfgPath,
      existingPath: globalCfgPath,
      existing: JSON.stringify(existingGlobal, null, 2) + '\n',
      proposed: JSON.stringify(proposed, null, 2) + '\n',
      defaultYes: true
    })
    if (result.answer === 'quit') {
      log('Aborted.')
      if (skillRl) skillRl.close()
      process.exit(1)
    }
    if (result.answer === 'yes') {
      writeJson(globalCfgPath, JSON.parse(result.content))
    }
  } else {
    // Edited or legacy (non-TTY)--preserve user config, ensure taskEnv defaults
    const defaults = buildGlobalConfig()
    if (existingGlobal.enabled === undefined) existingGlobal.enabled = true
    if (!existingGlobal.taskEnv) existingGlobal.taskEnv = {}
    Object.assign(existingGlobal.taskEnv, defaults.taskEnv)
    // Strip legacy keys
    delete existingGlobal.configVersion
    writeJson(globalCfgPath, existingGlobal)
  }

  // Install skills
  try {
    for (const { name, src } of SKILLS) {
      const skillDir = path.join(claudeDir, 'skills', name)
      const skillPath = path.join(skillDir, 'SKILL.md')
      const shippedPath = path.join(__dirname, '..', 'skills', src)
      const shippedContent = fs.readFileSync(shippedPath, 'utf8')
      const standaloneContent = generateStandaloneSkill(shippedContent)

      let doWrite = true
      let writeContent = standaloneContent
      if (fs.existsSync(skillPath)) {
        const existing = fs.readFileSync(skillPath, 'utf8')
        if (existing !== standaloneContent && skillRl) {
          const result = await askConflict(skillRl, {
            label: `~/.claude/skills/${name}/SKILL.md`,
            existingPath: skillPath,
            existing,
            proposed: standaloneContent,
            defaultYes: true
          })
          if (result.answer === 'quit') {
            log('Aborted.')
            process.exit(1)
          }
          doWrite = result.answer === 'yes'
          writeContent = result.content
        }
      }
      if (doWrite) {
        fs.mkdirSync(skillDir, { recursive: true })
        fs.writeFileSync(skillPath, ensureTrailingNewline(writeContent))
      }
    }
    // Clean up retired skills
    for (const name of RETIRED_SKILLS) {
      const retiredDir = path.join(claudeDir, 'skills', name)
      const retiredPath = path.join(retiredDir, 'SKILL.md')
      if (fs.existsSync(retiredPath)) {
        if (isTTY && skillRl) {
          const answer = await askYesNo(skillRl,
            `Skill /${name} has been retired. Remove ~/.claude/skills/${name}/?`,
            true)
          if (answer) {
            rmIfExists(retiredDir)
            log(`  Removed: ~/.claude/skills/${name}/`)
          }
        } else {
          rmIfExists(retiredDir)
          log(`  Removed retired skill: ~/.claude/skills/${name}/`)
        }
      }
    }
  } finally {
    if (skillRl) skillRl.close()
  }

  log('prove_it installed.')
  log(`  Settings: ${settingsPath}`)
  log(`  Config:   ${globalCfgPath}`)
  for (const { name } of SKILLS) {
    log(`  Skill:    ${path.join(claudeDir, 'skills', name, 'SKILL.md')}`)
  }
  log('')
  log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550')
  log('IMPORTANT: Restart Claude Code for hooks to take effect.')
  log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550')
  log('')
  log('Next steps:')
  log('  1. Restart Claude Code (required)')
  log('  2. Run: prove_it init  in a repo to add project config')
  log('  3. Run: prove_it doctor  to verify installation')
}

module.exports = { cmdInstall }
