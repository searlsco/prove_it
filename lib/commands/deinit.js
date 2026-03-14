const fs = require('fs')
const path = require('path')
const { rmIfExists, log, guardProjectDir } = require('./_helpers')

function cmdDeinit () {
  guardProjectDir('deinit')
  const { isScriptTestStub, isDefaultRuleFile, isDefaultDoneFile, removeGitHookShim } = require('../init')
  const repoRoot = process.cwd()
  const removed = []
  const skipped = []

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
    const { deleteAllRefs } = require('../git')
    const refCount = deleteAllRefs(repoRoot)
    if (refCount > 0) {
      removed.push(`refs/worktree/prove_it/* (${refCount} refs)`)
    }
  }

  // Clean up default rule files (only if unmodified)
  const ruleFilePath = path.join(repoRoot, '.claude', 'rules', 'testing.md')
  if (fs.existsSync(ruleFilePath)) {
    if (isDefaultRuleFile(ruleFilePath)) {
      rmIfExists(ruleFilePath)
      removed.push('.claude/rules/testing.md')
    } else {
      skipped.push('.claude/rules/testing.md (customized)')
    }
  }

  const doneRuleFilePath = path.join(repoRoot, '.claude', 'rules', 'done.md')
  if (fs.existsSync(doneRuleFilePath)) {
    if (isDefaultDoneFile(doneRuleFilePath)) {
      rmIfExists(doneRuleFilePath)
      removed.push('.claude/rules/done.md')
    } else {
      skipped.push('.claude/rules/done.md (customized)')
    }
  }

  // Remove rules/ directory if empty
  const rulesDir = path.join(repoRoot, '.claude', 'rules')
  try {
    if (fs.existsSync(rulesDir) && fs.readdirSync(rulesDir).length === 0) {
      fs.rmdirSync(rulesDir)
      removed.push('.claude/rules/')
    }
  } catch {}

  // Clean up .claude/prove_it/ runtime directory (sessions, backchannel, .gitignore)
  const proveItDir = path.join(repoRoot, '.claude', 'prove_it')
  if (fs.existsSync(proveItDir)) {
    fs.rmSync(proveItDir, { recursive: true, force: true })
    removed.push('.claude/prove_it/')
  }

  // Clean up legacy flat-file configs from pre-directory layout
  for (const legacy of ['.claude/prove_it.json', '.claude/prove_it.local.json']) {
    const legacyPath = path.join(repoRoot, legacy)
    if (fs.existsSync(legacyPath)) {
      rmIfExists(legacyPath)
      removed.push(legacy)
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

module.exports = { cmdDeinit }
