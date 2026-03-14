const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { loadJson, ensureTrailingNewline } = require('../shared')
const { askConflict } = require('../conflict')
const { log, askYesNo, guardProjectDir } = require('./_helpers')

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

async function cmdInit (options = {}) {
  guardProjectDir('init')
  const { initProject, overwriteTeamConfig, isTrackedByGit } = require('../init')
  const repoRoot = process.cwd()
  const { preservedSources, preservedTests } = options

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

    const results = initProject(repoRoot, { ...flags, preservedSources, preservedTests })

    // Handle edited config--prompt or respect --overwrite/--no-overwrite
    let overwritten = false
    const preserved = {}
    for (const key of ['sourcesPreserved', 'testsPreserved']) {
      if (results.teamConfig[key]) preserved[key] = true
    }
    if (results.teamConfig.edited) {
      if (flags.overwrite === true) {
        const owResult = overwriteTeamConfig(repoRoot, { ...flags, preservedSources, preservedTests })
        overwritten = true
        Object.assign(preserved, owResult)
      } else if (flags.overwrite === null && rl) {
        const { buildConfig: buildCfg, configHash: cfgHash, hasCustomValue } = require('../config')
        const teamConfigPath = path.join(repoRoot, '.claude', 'prove_it', 'config.json')
        const existingContent = fs.readFileSync(teamConfigPath, 'utf8')
        const existingCfg = JSON.parse(existingContent)

        // Build proposed config (mirrors overwriteTeamConfig logic)
        const keyOverrides = {}
        if (preservedSources) keyOverrides.sources = preservedSources
        if (preservedTests) keyOverrides.tests = preservedTests
        const proposedCfg = buildCfg({ gitHooks: flags.gitHooks, defaultChecks: flags.defaultChecks })
        const proposedPreserved = {}
        for (const key of ['sources', 'tests']) {
          const value = keyOverrides[key] || (hasCustomValue(key, existingCfg) ? existingCfg[key] : null)
          if (value) {
            proposedCfg[key] = value
            proposedPreserved[`${key}Preserved`] = true
          }
        }
        proposedCfg.initSeed = cfgHash(proposedCfg)
        const proposedContent = JSON.stringify(proposedCfg, null, 2) + '\n'

        const tracked = fs.existsSync(path.join(repoRoot, '.git')) && isTrackedByGit(repoRoot, '.claude/prove_it/config.json')
        const result = await askConflict(rl, {
          label: '.claude/prove_it/config.json',
          existingPath: teamConfigPath,
          existing: existingContent,
          proposed: proposedContent,
          defaultYes: tracked
        })
        if (result.answer === 'quit') {
          log('Aborted.')
          process.exit(1)
        }
        if (result.answer === 'yes') {
          // Write the accepted content (may be agent-merged, not the original proposed)
          fs.writeFileSync(teamConfigPath, ensureTrailingNewline(result.content))
          overwritten = true
          Object.assign(preserved, proposedPreserved)
        }
      }
      // flags.overwrite === false or user said no -> keep existing
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

    if (preserved.sourcesPreserved) {
      log('  Preserved: sources globs from previous config')
    }
    if (preserved.testsPreserved) {
      log('  Preserved: tests globs from previous config')
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

    if (results.doneRuleFile.created) {
      log(`  Created: ${results.doneRuleFile.path}`)
    } else if (results.doneRuleFile.existed) {
      log(`  Exists:  ${results.doneRuleFile.path}`)
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

    if (results.proveItGitignore && results.proveItGitignore.created) {
      log('  Created: .claude/prove_it/.gitignore')
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

    if (results.doneRuleFile.created) {
      todos.push({
        done: false,
        text: "Customize .claude/rules/done.md with your project's definition of done"
      })
    }

    // Sources glob TODO--check the team config for placeholder globs
    const teamCfg = loadJson(path.join(repoRoot, '.claude', 'prove_it', 'config.json'))
    const teamSources = teamCfg?.sources
    if (Array.isArray(teamSources) && teamSources.some(s => s.includes('replace/these/with/globs'))) {
      todos.push({
        done: false,
        text: 'Replace the placeholder sources globs in .claude/prove_it/config.json\n' +
          '        Sources controls which files trigger run caching, reviewer gating,\n' +
          '        and git-based churn tracking (e.g. ["src/**/*.*", "test/**/*.*"])'
      })
    } else if (Array.isArray(teamSources) && teamSources.length > 0) {
      todos.push({ done: true, text: 'Sources globs configured' })
    }

    if (results.teamConfig.upgraded || overwritten) {
      todos.push({
        done: false,
        text: 'Review updated .claude/prove_it/config.json (check commands)'
      })
    } else {
      todos.push({
        done: false,
        text: 'Customize .claude/prove_it/config.json (check commands)'
      })
    }

    if (results.teamConfigNeedsCommit || results.teamConfig.upgraded || overwritten) {
      todos.push({ done: false, text: 'Commit changes' })
    } else if (results.teamConfig.existed) {
      todos.push({ done: true, text: '.claude/prove_it/config.json committed' })
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

module.exports = { cmdInit }
