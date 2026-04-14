const { spawnSync } = require('child_process')
const { readDispatcherPid, writeCancelSentinel } = require('../session')
const { log, requireSessionId } = require('./_helpers')

function killDescendants (pid) {
  try {
    const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 2000 })
    if (r.stdout) {
      for (const childPid of r.stdout.trim().split('\n').filter(Boolean)) {
        killDescendants(Number(childPid))
        try { process.kill(Number(childPid), 'SIGKILL') } catch {}
      }
    }
  } catch {}
}

function cmdCancel () {
  const sessionId = requireSessionId('cancel')

  const pidData = readDispatcherPid(sessionId)
  if (!pidData) {
    console.error('prove_it cancel: no running dispatcher found for this session.')
    process.exit(1)
  }

  // Write cancel sentinel so dispatcher exits cleanly with approve
  writeCancelSentinel(sessionId)

  // Kill the dispatcher's entire process tree. We must kill grandchildren
  // first (e.g., `sleep 30` inside a script) because spawnSync blocks until
  // all stdio is closed — killing only direct children leaves grandchildren
  // holding pipes open.
  const { pid } = pidData
  killDescendants(pid)

  // Wait for the dispatcher to exit cleanly via the sentinel.
  // When its child dies, spawnSync returns, dispatcher reads sentinel, exits.
  for (let i = 0; i < 10; i++) {
    try { process.kill(pid, 0) } catch { break } // process gone
    spawnSync('sleep', ['0.2'])
  }
  // SIGKILL as fallback if still running
  try { process.kill(pid, 'SIGKILL') } catch {}

  log(`prove_it: Cancelled running tasks for session ${sessionId}`)
}

module.exports = { cmdCancel }
