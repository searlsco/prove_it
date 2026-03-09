function runUpgradeSteps ({ run, cwd, homeDir, findProject, log }) {
  log('Upgrading prove_it...')
  if (!run('brew', ['upgrade', 'searlsco/tap/prove_it'])) {
    return { ok: false, error: 'brew upgrade failed' }
  }

  log('Reinstalling hooks and skills...')
  if (!run('prove_it', ['install'])) {
    return { ok: false, error: 'prove_it install failed' }
  }

  const projectDir = findProject(cwd)
  if (projectDir && projectDir !== homeDir) {
    log(`Reinitializing project (${projectDir})...`)
    if (!run('prove_it', ['init'], { cwd: projectDir })) {
      return { ok: false, error: 'prove_it init failed' }
    }
  }

  log('')
  log('Upgrade complete. Restart Claude Code for changes to take effect.')
  return { ok: true }
}

module.exports = { runUpgradeSteps }
