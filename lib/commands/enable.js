const { clearDisabledSentinel, readDisabledSentinel } = require('../session')
const { log, requireSessionId } = require('./_helpers')

function cmdEnable () {
  const sessionId = requireSessionId('enable')
  const wasDisabled = readDisabledSentinel(sessionId)
  clearDisabledSentinel(sessionId)
  if (wasDisabled) {
    log(`prove_it: hooks re-enabled for session ${sessionId}`)
  } else {
    log(`prove_it: hooks were already enabled for session ${sessionId}`)
  }
}

module.exports = { cmdEnable }
