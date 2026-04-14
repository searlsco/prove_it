const { clearDisabledSentinel, readDisabledSentinel } = require('../session')
const { log } = require('./_helpers')

function cmdEnable () {
  const sessionId = process.env.PROVE_IT_SESSION_ID
  if (!sessionId) {
    console.error('prove_it enable: PROVE_IT_SESSION_ID is not set.')
    console.error('This command must be run from within a Claude Code session (via ! prove_it enable).')
    process.exit(1)
  }

  const wasDisabled = readDisabledSentinel(sessionId)
  clearDisabledSentinel(sessionId)
  if (wasDisabled) {
    log(`prove_it: hooks re-enabled for session ${sessionId}`)
  } else {
    log(`prove_it: hooks were already enabled for session ${sessionId}`)
  }
}

module.exports = { cmdEnable }
