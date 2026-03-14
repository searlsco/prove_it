#!/usr/bin/env node
/**
 * prove_it CLI
 *
 * Commands:
 *   install   - Install prove_it globally (~/.claude/) including /prove skill
 *   uninstall - Remove prove_it from global config
 *   init      - Initialize prove_it in current repository
 *   deinit    - Remove prove_it files from current repository
 *   doctor    - Check installation status and report issues
 *   monitor   - Tail hook results in real time
 *   hook      - Run a hook dispatcher (claude:<Event> or git:<event>)
 *   prefix    - Print install directory (for resolving libexec scripts)
 *   signal    - Declare a lifecycle signal (done, stuck, idle)
 *   phase     - Set session activity phase (unknown, plan, implement, refactor)
 *   record    - Record a test run result for run caching
 *   upgrade   - Update via Homebrew, reinstall hooks, reinit project
 */
const path = require('path')
const { loadJson } = require('./lib/shared')
const { log } = require('./lib/commands/_helpers')
const { showHelp, getVersion } = require('./lib/commands/help')

function main () {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'install': {
      const { cmdInstall } = require('./lib/commands/install')
      cmdInstall().catch(err => {
        console.error(`prove_it install failed: ${err.message}`)
        process.exit(1)
      })
      break
    }
    case 'uninstall': {
      const { cmdUninstall } = require('./lib/commands/uninstall')
      cmdUninstall()
      break
    }
    case 'reinstall': {
      const { cmdUninstall } = require('./lib/commands/uninstall')
      const { cmdInstall } = require('./lib/commands/install')
      cmdUninstall()
      cmdInstall().catch(err => {
        console.error(`prove_it reinstall failed: ${err.message}`)
        process.exit(1)
      })
      break
    }
    case 'init': {
      const { cmdInit } = require('./lib/commands/init')
      cmdInit().catch(err => {
        console.error(`prove_it init failed: ${err.message}`)
        process.exit(1)
      })
      break
    }
    case 'deinit': {
      const { cmdDeinit } = require('./lib/commands/deinit')
      cmdDeinit()
      break
    }
    case 'upgrade': {
      const { cmdUpgrade } = require('./lib/commands/upgrade')
      cmdUpgrade()
      break
    }
    case 'reinit': {
      const { hasCustomValue } = require('./lib/config')
      const { cmdDeinit } = require('./lib/commands/deinit')
      const { cmdInit } = require('./lib/commands/init')
      const cfgPath = path.join(process.cwd(), '.claude', 'prove_it', 'config.json')
      const existing = loadJson(cfgPath)
      const reinitOptions = {}
      for (const key of ['sources', 'tests']) {
        if (hasCustomValue(key, existing)) {
          const camel = 'preserved' + key.charAt(0).toUpperCase() + key.slice(1)
          reinitOptions[camel] = existing[key]
        }
      }
      cmdDeinit()
      cmdInit(reinitOptions).catch(err => {
        console.error(`prove_it reinit failed: ${err.message}`)
        process.exit(1)
      })
      break
    }
    case 'doctor':
    case 'diagnose': {
      const { cmdDoctor } = require('./lib/commands/doctor')
      cmdDoctor()
      break
    }
    case 'hook': {
      const { cmdHook } = require('./lib/commands/hook')
      cmdHook(args[1])
      break
    }
    case 'record': {
      const { cmdRecord } = require('./lib/commands/record')
      cmdRecord()
      break
    }
    case 'prefix':
      console.log(__dirname)
      break
    case 'signal': {
      const { cmdSignal } = require('./lib/commands/signal')
      cmdSignal()
      break
    }
    case 'phase': {
      const { cmdPhase } = require('./lib/commands/phase')
      cmdPhase()
      break
    }
    case 'monitor': {
      const { cmdMonitor } = require('./lib/commands/monitor')
      cmdMonitor()
      break
    }
    case '-v':
    case '--version':
    case 'version':
      log(getVersion())
      break
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showHelp()
      break
    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run "prove_it help" for usage.')
      process.exit(1)
  }
}

main()
