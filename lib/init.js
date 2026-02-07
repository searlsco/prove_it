const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { ensureDir, writeJson } = require('./io')
const { tier1Config, tier2Config, tier3Config } = require('./config')

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
    if (content.split('\n').some(line => line.trim() === pattern)) {
      return false
    }
  }

  if (content && !content.endsWith('\n')) {
    content += '\n'
  }
  content += pattern + '\n'
  fs.writeFileSync(gitignorePath, content)
  return true
}

/**
 * Get the tier config generator for a given tier number.
 */
function getTierConfig (tier) {
  switch (tier) {
    case 1: return tier1Config()
    case 2: return tier2Config()
    case 3: return tier3Config()
    default: return tier3Config()
  }
}

/**
 * Initialize prove_it in a project directory.
 *
 * @param {string} repoRoot - The project directory
 * @param {object} options - { tier, claudeHooks, gitHooks, defaultChecks }
 * @returns {object} - Results of what was created/existed
 */
function initProject (repoRoot, options = {}) {
  const tier = options.tier || 3
  const results = {
    teamConfig: { path: '.claude/prove_it.json', created: false, existed: false },
    localConfig: { path: '.claude/prove_it.local.json', created: false, existed: false },
    scriptTest: { path: 'script/test', created: false, existed: false, isStub: false },
    addedToGitignore: false,
    teamConfigNeedsCommit: false
  }

  // Write team config
  const teamConfigDst = path.join(repoRoot, '.claude', 'prove_it.json')
  if (fs.existsSync(teamConfigDst)) {
    results.teamConfig.existed = true
  } else {
    ensureDir(path.dirname(teamConfigDst))
    const cfg = getTierConfig(tier)
    writeJson(teamConfigDst, cfg)
    results.teamConfig.created = true
  }

  // Write local config
  const localConfigDst = path.join(repoRoot, '.claude', 'prove_it.local.json')
  if (fs.existsSync(localConfigDst)) {
    results.localConfig.existed = true
  } else {
    ensureDir(path.dirname(localConfigDst))
    writeJson(localConfigDst, {})
    results.localConfig.created = true
  }

  // Create stub script/test if missing
  const scriptTest = path.join(repoRoot, 'script', 'test')
  if (fs.existsSync(scriptTest)) {
    results.scriptTest.existed = true
    results.scriptTest.isStub = isScriptTestStub(scriptTest)
  } else {
    ensureDir(path.dirname(scriptTest))
    const stub = '#!/bin/bash\n# prove_it: Replace this with your test suite\nset -e\necho "No tests configured. Edit script/test to run your test suite."\nexit 1\n'
    fs.writeFileSync(scriptTest, stub)
    fs.chmodSync(scriptTest, 0o755)
    results.scriptTest.created = true
    results.scriptTest.isStub = true
  }

  // Add prove_it.local.json to .gitignore
  if (!isIgnoredByGit(repoRoot, '.claude/prove_it.local.json')) {
    results.addedToGitignore = addToGitignore(repoRoot, '.claude/prove_it.local.json')
  }

  // Check if team config needs to be committed
  results.teamConfigNeedsCommit =
    fs.existsSync(teamConfigDst) && !isTrackedByGit(repoRoot, '.claude/prove_it.json')

  return results
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

module.exports = {
  initProject,
  isScriptTestStub,
  getTierConfig,
  addToGitignore
}
