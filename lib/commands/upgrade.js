const os = require('os')
const { log } = require('./_helpers')

function cmdUpgrade () {
  const { spawnSync } = require('child_process')
  const { findProveItProject } = require('../config')
  const { runUpgradeSteps } = require('../upgrade')

  const run = (cmd, args, opts) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
    return r.status === 0
  }

  const result = runUpgradeSteps({
    run,
    cwd: process.cwd(),
    homeDir: os.homedir(),
    findProject: findProveItProject,
    log
  })

  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }
}

module.exports = { cmdUpgrade }
