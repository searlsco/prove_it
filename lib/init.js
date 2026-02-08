const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { ensureDir, writeJson } = require('./io')
const { buildConfig } = require('./config')

const PROVE_IT_SHIM_MARKER = '# --- prove_it ---'

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
 * Install a git hook shim for the given event.
 *
 * @returns {{ installed: boolean, existed: boolean, merged: boolean, skipped: boolean }}
 */
function installGitHookShim (repoRoot, gitEvent, autoMerge) {
  const hookPath = path.join(repoRoot, '.git', 'hooks', gitEvent)
  const result = { installed: false, existed: false, merged: false, skipped: false }

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

  // Already has prove_it
  if (isProveItShim(hookPath) || hasProveItSection(hookPath)) {
    return result
  }

  if (autoMerge) {
    let content = fs.readFileSync(hookPath, 'utf8')
    if (!content.endsWith('\n')) content += '\n'
    content += `\n${PROVE_IT_SHIM_MARKER}\nprove_it hook git:${gitEvent}\n${PROVE_IT_SHIM_MARKER}\n`
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
    teamConfig: { path: '.claude/prove_it.json', created: false, existed: false },
    localConfig: { path: '.claude/prove_it.local.json', created: false, existed: false },
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
  } else {
    ensureDir(path.dirname(teamConfigDst))
    const cfg = buildConfig({ gitHooks, defaultChecks })
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
  buildConfig,
  addToGitignore,
  installGitHookShim,
  removeGitHookShim,
  isProveItShim,
  hasProveItSection,
  PROVE_IT_SHIM_MARKER
}
