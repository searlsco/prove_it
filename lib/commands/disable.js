const { writeDisabledSentinel } = require('../session')
const { log } = require('./_helpers')

function cmdDisable () {
  const sessionId = process.env.PROVE_IT_SESSION_ID
  if (!sessionId) {
    console.error('prove_it disable: PROVE_IT_SESSION_ID is not set.')
    console.error('This command must be run from within a Claude Code session (via ! prove_it disable).')
    process.exit(1)
  }

  writeDisabledSentinel(sessionId)
  log('⚠️  prove_it is disabled for this session. Run `! prove_it enable` to re-enable hooks.')
}

module.exports = { cmdDisable }
