const { writeDisabledSentinel, disableSessionControl } = require('../session')
const { log, requireSessionId } = require('./_helpers')

function cmdDisable () {
  const sessionId = requireSessionId('disable')
  writeDisabledSentinel(sessionId)
  disableSessionControl(sessionId)
  log('⚠️  prove_it is disabled for this session. Run `! prove_it enable` to re-enable hooks.')
}

module.exports = { cmdDisable }
