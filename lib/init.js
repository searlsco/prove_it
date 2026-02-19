const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { loadJson, ensureDir, writeJson } = require('./io')
const { buildConfig, configHash } = require('./config')

const PROVE_IT_SHIM_MARKER = '# --- prove_it ---'

const DEFAULT_RULE_CONTENT = [
  '# Testing Rules',
  '',
  'Every feature and bug fix must be thoroughly covered by automated tests',
  'that verify correctness without human intervention.',
  '',
  'Your work will be evaluated at each review checkpoint (before tool use,',
  'after each turn, and before each commit) against this standard:',
  '',
  '- New behavior requires new tests that would fail if the code were reverted',
  '- Bug fixes require regression tests that reproduce the original failure',
  '- "Hard to test" is not a valid exemption — if it runs, it can be tested',
  '',
  '<!-- TODO: Customize these rules for your project -->',
  ''
].join('\n')

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
 * Generate a git hook shim script for prove_it.
 */
function makeShim (gitEvent) {
  return `#!/usr/bin/env bash\nprove_it hook git:${gitEvent}\n`
}

/**
 * Check if a file is a prove_it shim (the entire file).
 */
function isProveItShim (filePath) {
  if (!fs.existsSync(filePath)) return false
  const content = fs.readFileSync(filePath, 'utf8')
  return content.includes('prove_it hook git:')
}

/**
 * Check if a file has a prove_it merged section.
 */
function hasProveItSection (filePath) {
  if (!fs.existsSync(filePath)) return false
  const content = fs.readFileSync(filePath, 'utf8')
  return content.includes(PROVE_IT_SHIM_MARKER)
}

/**
 * Check if content has a non-comment line starting with `exec `.
 */
function hasExecLine (content) {
  return content.split('\n').some(line => {
    const trimmed = line.trim()
    return !trimmed.startsWith('#') && /^exec\s/.test(trimmed)
  })
}

/**
 * Check if a prove_it section is positioned after an exec line in hook content.
 */
function isProveItAfterExec (content) {
  const lines = content.split('\n')
  let foundExec = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('#') && /^exec\s/.test(trimmed)) {
      foundExec = true
    }
    if (foundExec && trimmed === PROVE_IT_SHIM_MARKER) {
      return true
    }
  }
  return false
}

/**
 * Remove the prove_it marked section from content string.
 * Returns the content with the section removed.
 */
function removeProveItSectionFromContent (content) {
  const lines = content.split('\n')
  const filtered = []
  let inSection = false
  for (const line of lines) {
    if (line.trim() === PROVE_IT_SHIM_MARKER) {
      inSection = !inSection
      continue
    }
    if (!inSection) filtered.push(line)
  }
  // Remove trailing blank lines left by section removal
  while (filtered.length > 0 && filtered[filtered.length - 1] === '') {
    filtered.pop()
  }
  return filtered.length > 0 ? filtered.join('\n') + '\n' : ''
}

/**
 * Insert the prove_it section before the first exec line in content.
 */
function insertBeforeExec (content, gitEvent) {
  const lines = content.split('\n')
  const section = `${PROVE_IT_SHIM_MARKER}\nprove_it hook git:${gitEvent}\n${PROVE_IT_SHIM_MARKER}`
  const result = []
  let inserted = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inserted && !trimmed.startsWith('#') && /^exec\s/.test(trimmed)) {
      result.push(section)
      result.push('')
      inserted = true
    }
    result.push(line)
  }
  return result.join('\n')
}

/**
 * Install a git hook shim for the given event.
 *
 * @returns {{ installed: boolean, existed: boolean, merged: boolean, skipped: boolean }}
 */
function installGitHookShim (repoRoot, gitEvent, autoMerge) {
  const hookPath = path.join(repoRoot, '.git', 'hooks', gitEvent)
  const result = { installed: false, existed: false, merged: false, skipped: false, repositioned: false }

  if (!fs.existsSync(path.join(repoRoot, '.git', 'hooks'))) {
    ensureDir(path.join(repoRoot, '.git', 'hooks'))
  }

  if (!fs.existsSync(hookPath)) {
    fs.writeFileSync(hookPath, makeShim(gitEvent))
    fs.chmodSync(hookPath, 0o755)
    result.installed = true
    return result
  }

  result.existed = true

  // Already has prove_it — check if it needs repositioning
  if (isProveItShim(hookPath) || hasProveItSection(hookPath)) {
    const content = fs.readFileSync(hookPath, 'utf8')
    if (hasProveItSection(hookPath) && hasExecLine(content) && isProveItAfterExec(content)) {
      // Section is after exec — reposition it
      const cleaned = removeProveItSectionFromContent(content)
      const fixed = insertBeforeExec(cleaned, gitEvent)
      fs.writeFileSync(hookPath, fixed)
      result.repositioned = true
    }
    return result
  }

  if (autoMerge) {
    let content = fs.readFileSync(hookPath, 'utf8')
    if (!content.endsWith('\n')) content += '\n'
    if (hasExecLine(content)) {
      content = insertBeforeExec(content, gitEvent)
    } else {
      content += `\n${PROVE_IT_SHIM_MARKER}\nprove_it hook git:${gitEvent}\n${PROVE_IT_SHIM_MARKER}\n`
    }
    fs.writeFileSync(hookPath, content)
    result.merged = true
  } else {
    result.skipped = true
  }

  return result
}

/**
 * Remove prove_it from a git hook file.
 * Removes the entire file if it's a shim, or the marked section if merged.
 */
function removeGitHookShim (repoRoot, gitEvent) {
  const hookPath = path.join(repoRoot, '.git', 'hooks', gitEvent)
  if (!fs.existsSync(hookPath)) return false

  if (isProveItShim(hookPath) && !hasProveItSection(hookPath)) {
    // Entire file is a prove_it shim — remove it
    fs.unlinkSync(hookPath)
    return true
  }

  if (hasProveItSection(hookPath)) {
    // Remove the marked section
    const content = fs.readFileSync(hookPath, 'utf8')
    const lines = content.split('\n')
    const filtered = []
    let inSection = false
    for (const line of lines) {
      if (line.trim() === PROVE_IT_SHIM_MARKER) {
        inSection = !inSection
        continue
      }
      if (!inSection) filtered.push(line)
    }
    // Remove trailing blank lines left by section removal
    while (filtered.length > 0 && filtered[filtered.length - 1] === '') {
      filtered.pop()
    }
    if (filtered.length > 0) {
      fs.writeFileSync(hookPath, filtered.join('\n') + '\n')
    } else {
      fs.unlinkSync(hookPath)
    }
    return true
  }

  return false
}

/**
 * Initialize prove_it in a project directory.
 *
 * @param {string} repoRoot - The project directory
 * @param {object} options - { gitHooks, defaultChecks, autoMergeGitHooks }
 * @returns {object} - Results of what was created/existed
 */
function initProject (repoRoot, options = {}) {
  const { gitHooks = true, defaultChecks = true, autoMergeGitHooks = false } = options
  const results = {
    teamConfig: { path: '.claude/prove_it.json', created: false, existed: false, upToDate: false, upgraded: false, edited: false },
    localConfig: { path: '.claude/prove_it.local.json', created: false, existed: false },
    ruleFile: { path: '.claude/rules/testing.md', created: false, existed: false },
    scriptTest: { path: 'script/test', created: false, existed: false, isStub: false },
    scriptTestFast: { path: 'script/test_fast', created: false, existed: false, isStub: false },
    addedToGitignore: false,
    teamConfigNeedsCommit: false,
    gitHookFiles: {}
  }

  // Write team config
  const teamConfigDst = path.join(repoRoot, '.claude', 'prove_it.json')
  if (fs.existsSync(teamConfigDst)) {
    results.teamConfig.existed = true
    const existing = loadJson(teamConfigDst)
    if (existing && existing.initSeed) {
      const contentHash = configHash(existing)
      if (contentHash === existing.initSeed) {
        // User hasn't edited — check if it matches current defaults
        const fresh = buildConfig({ gitHooks, defaultChecks })
        const freshHash = configHash(fresh)
        if (contentHash === freshHash) {
          results.teamConfig.upToDate = true
        } else {
          // Auto-upgrade
          fresh.initSeed = freshHash
          writeJson(teamConfigDst, fresh)
          results.teamConfig.upgraded = true
        }
      } else {
        results.teamConfig.edited = true
      }
    } else {
      // Legacy config (no initSeed) — treat as edited
      results.teamConfig.edited = true
    }
  } else {
    ensureDir(path.dirname(teamConfigDst))
    const cfg = buildConfig({ gitHooks, defaultChecks })
    cfg.initSeed = configHash(cfg)
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

  // Create rule file if missing
  if (defaultChecks) {
    const ruleFileDst = path.join(repoRoot, '.claude', 'rules', 'testing.md')
    if (fs.existsSync(ruleFileDst)) {
      results.ruleFile.existed = true
    } else {
      ensureDir(path.dirname(ruleFileDst))
      fs.writeFileSync(ruleFileDst, DEFAULT_RULE_CONTENT)
      results.ruleFile.created = true
    }
  }

  // Create stub script/test if missing
  const scriptTest = path.join(repoRoot, 'script', 'test')
  if (fs.existsSync(scriptTest)) {
    results.scriptTest.existed = true
    results.scriptTest.isStub = isScriptTestStub(scriptTest)
  } else {
    ensureDir(path.dirname(scriptTest))
    const stub = [
      '#!/usr/bin/env bash',
      '# prove_it: full test suite — runs before every git commit',
      '# Replace the test command below, or change the \'full-tests\' command',
      '# in .claude/prove_it.json to point at your existing test runner.',
      'set -e',
      "trap 'prove_it record --name full-tests --result $?' EXIT",
      'echo "No tests configured. Edit script/test to run your test suite."',
      'exit 1',
      ''
    ].join('\n')
    fs.writeFileSync(scriptTest, stub)
    fs.chmodSync(scriptTest, 0o755)
    results.scriptTest.created = true
    results.scriptTest.isStub = true
  }

  // Create stub script/test_fast if missing
  const scriptTestFast = path.join(repoRoot, 'script', 'test_fast')
  if (fs.existsSync(scriptTestFast)) {
    results.scriptTestFast.existed = true
    results.scriptTestFast.isStub = isScriptTestStub(scriptTestFast)
  } else {
    ensureDir(path.dirname(scriptTestFast))
    const stub = [
      '#!/usr/bin/env bash',
      '# prove_it: fast tests — runs every time Claude finishes a response',
      '# Replace the test command below, or change the \'fast-tests\' command',
      '# in .claude/prove_it.json to point at your existing test runner.',
      'set -e',
      "trap 'prove_it record --name fast-tests --result $?' EXIT",
      'echo "No tests configured. Edit script/test_fast to run your fast (unit) tests."',
      'exit 1',
      ''
    ].join('\n')
    fs.writeFileSync(scriptTestFast, stub)
    fs.chmodSync(scriptTestFast, 0o755)
    results.scriptTestFast.created = true
    results.scriptTestFast.isStub = true
  }

  // Add prove_it.local.json to .gitignore
  if (!isIgnoredByGit(repoRoot, '.claude/prove_it.local.json')) {
    results.addedToGitignore = addToGitignore(repoRoot, '.claude/prove_it.local.json')
  }

  // Check if team config needs to be committed
  results.teamConfigNeedsCommit =
    fs.existsSync(teamConfigDst) && !isTrackedByGit(repoRoot, '.claude/prove_it.json')

  // Install git hook shims if requested and .git exists
  if (gitHooks && fs.existsSync(path.join(repoRoot, '.git'))) {
    results.gitHookFiles.preCommit = installGitHookShim(repoRoot, 'pre-commit', autoMergeGitHooks)
    results.gitHookFiles.prePush = installGitHookShim(repoRoot, 'pre-push', autoMergeGitHooks)
  }

  return results
}

/**
 * Overwrite an edited team config with fresh defaults.
 */
function overwriteTeamConfig (repoRoot, options = {}) {
  const { gitHooks = true, defaultChecks = true } = options
  const teamConfigDst = path.join(repoRoot, '.claude', 'prove_it.json')
  const cfg = buildConfig({ gitHooks, defaultChecks })
  cfg.initSeed = configHash(cfg)
  writeJson(teamConfigDst, cfg)
}

function isDefaultRuleFile (filePath) {
  if (!fs.existsSync(filePath)) return false
  try {
    return fs.readFileSync(filePath, 'utf8') === DEFAULT_RULE_CONTENT
  } catch {
    return false
  }
}

function isScriptTestStub (scriptTestPath) {
  if (!fs.existsSync(scriptTestPath)) return false
  try {
    const content = fs.readFileSync(scriptTestPath, 'utf8')
    return content.includes('No tests configured')
  } catch {
    return false
  }
}

module.exports = {
  configHash,
  initProject,
  overwriteTeamConfig,
  isScriptTestStub,
  isDefaultRuleFile,
  isTrackedByGit,
  buildConfig,
  addToGitignore,
  installGitHookShim,
  removeGitHookShim,
  isProveItShim,
  hasProveItSection,
  hasExecLine,
  isProveItAfterExec,
  PROVE_IT_SHIM_MARKER
}
