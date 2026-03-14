const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson, writeJson } = require('../shared')
const { SKILLS, rmIfExists, getClaudeDir, log, removeProveItGroups } = require('./_helpers')

function backupGlobalConfig (claudeDir) {
  const configPath = path.join(claudeDir, 'prove_it', 'config.json')
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    if (!content || content.trim().length === 0) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = path.join(os.tmpdir(), `prove_it-backup-${stamp}`)
    fs.mkdirSync(backupDir, { recursive: true })
    const backupPath = path.join(backupDir, 'config.json')
    fs.writeFileSync(backupPath, content)
    return backupPath
  } catch {
    return null
  }
}

function clearDirectoryContents (dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return
    for (const entry of fs.readdirSync(dirPath)) {
      rmIfExists(path.join(dirPath, entry))
    }
  } catch {}
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

  // Back up global config before removing it
  const backupPath = backupGlobalConfig(claudeDir)

  // Remove prove_it directory contents (preserves symlinks and the directory itself)
  clearDirectoryContents(path.join(claudeDir, 'prove_it'))
  rmIfExists(path.join(claudeDir, 'rules', 'prove_it.md'))
  for (const { name } of SKILLS) {
    rmIfExists(path.join(claudeDir, 'skills', name))
  }

  log('prove_it uninstalled.')
  log(`  Settings: ${settingsPath}`)
  if (backupPath) {
    log(`  Backup: ${backupPath}`)
  }
  log('  Removed: ~/.claude/prove_it/ (contents)')
  log('  Removed: ~/.claude/rules/prove_it.md')
  for (const { name } of SKILLS) {
    log(`  Removed: ~/.claude/skills/${name}/`)
  }
}

module.exports = { cmdUninstall }
