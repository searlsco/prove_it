const { spawnSync } = require('child_process')
const { readDispatcherPid, writeCancelSentinel } = require('../session')
const { log } = require('./_helpers')

function cmdCancel () {
  const sessionId = process.env.PROVE_IT_SESSION_ID
  if (!sessionId) {
    console.error('prove_it cancel: PROVE_IT_SESSION_ID is not set.')
    console.error('This command must be run from within a Claude Code session (via ! prove_it cancel).')
    process.exit(1)
  }

  const pidData = readDispatcherPid(sessionId)
  if (!pidData) {
    console.error('prove_it cancel: no running dispatcher found for this session.')
    process.exit(1)
  }

  // Write cancel sentinel so dispatcher exits cleanly with approve
  writeCancelSentinel(sessionId)

  // Kill the dispatcher's child processes (the actual test scripts)
  const { pid } = pidData
  try {
    spawnSync('pkill', ['-KILL', '-P', String(pid)], { timeout: 2000 })
  } catch {}

  // Kill the dispatcher itself as fallback
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}

  log(`prove_it: Cancelled running tasks for session ${sessionId}`)
}

module.exports = { cmdCancel }
