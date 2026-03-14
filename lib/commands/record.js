const path = require('path')

function cmdRecord () {
  const { saveRunData } = require('../testing')

  const args = process.argv.slice(3)
  let name = null
  let hasPass = false
  let hasFail = false
  let hasResult = false
  let resultCode = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && i + 1 < args.length) {
      name = args[++i]
    } else if (args[i] === '--pass') {
      hasPass = true
    } else if (args[i] === '--fail') {
      hasFail = true
    } else if (args[i] === '--result') {
      hasResult = true
      if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
        resultCode = parseInt(args[++i], 10)
      }
    }
  }

  // Exactly one mode must be provided
  const modeCount = (hasPass ? 1 : 0) + (hasFail ? 1 : 0) + (hasResult ? 1 : 0)
  if (!name || modeCount !== 1 || (hasResult && resultCode === null)) {
    console.error('Usage: prove_it record --name <checkName> --pass|--fail|--result <N>')
    process.exit(1)
  }

  const pass = hasResult ? resultCode === 0 : hasPass
  const exitCode = hasResult ? resultCode : (pass ? 0 : 1)
  const result = pass ? 'pass' : 'fail'

  const localCfgPath = path.join(process.cwd(), '.claude', 'prove_it', 'config.local.json')
  const runKey = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  saveRunData(localCfgPath, runKey, { at: Date.now(), result })

  console.error(`prove_it: recorded ${runKey} ${result}`)
  process.exit(exitCode)
}

module.exports = { cmdRecord }
