const { handleToolCall } = require('./bridge')
const { renderMethodologySummary } = require('../../methodology')

const METHODOLOGY_GUIDANCE = renderMethodologySummary()

function injectMethodology (event) {
  const systemPrompt = event?.systemPrompt || ''
  return {
    systemPrompt: systemPrompt
      ? `${systemPrompt}\n\n${METHODOLOGY_GUIDANCE}`
      : METHODOLOGY_GUIDANCE
  }
}

function registerPiExtension (pi) {
  pi.on('before_agent_start', async (event) => injectMethodology(event))
  pi.on('tool_call', async (event, ctx) => handleToolCall(event, ctx))
}

module.exports = registerPiExtension
module.exports.default = registerPiExtension
module.exports.METHODOLOGY_GUIDANCE = METHODOLOGY_GUIDANCE
module.exports.injectMethodology = injectMethodology
