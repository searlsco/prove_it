const { handleAgentEnd, handleSignalTool, handleToolCall, handleTurnEnd } = require('./bridge')
const { renderMethodologySummary } = require('../../methodology')
const { VALID_SIGNALS } = require('../../redesign/signal_lifecycle')

const METHODOLOGY_GUIDANCE = renderMethodologySummary()

function injectMethodology (event) {
  const systemPrompt = event?.systemPrompt || ''
  return {
    systemPrompt: systemPrompt
      ? `${systemPrompt}\n\n${METHODOLOGY_GUIDANCE}`
      : METHODOLOGY_GUIDANCE
  }
}

function signalToolDefinition (pi) {
  return {
    name: 'prove_it_signal',
    label: 'prove_it Signal',
    description: 'Declare a prove_it completion signal such as done, stuck, or idle using shared signal semantics.',
    promptSnippet: 'Declare prove_it completion signals for coherent task completion or blockers.',
    promptGuidelines: [
      'Use prove_it_signal with signal="done" once after completing a coherent coding task and before claiming the work is complete.'
    ],
    parameters: {
      type: 'object',
      properties: {
        signal: {
          type: 'string',
          enum: VALID_SIGNALS,
          description: 'The prove_it signal to declare.'
        },
        message: {
          type: 'string',
          description: 'Optional short context for the signal.'
        }
      },
      required: ['signal'],
      additionalProperties: false
    },
    async execute (_toolCallId, params, _signal, _onUpdate, ctx) {
      return handleSignalTool(params, ctx, pi)
    }
  }
}

function registerPiExtension (pi) {
  pi.on('before_agent_start', async (event) => injectMethodology(event))
  pi.on('tool_call', async (event, ctx) => handleToolCall(event, ctx, pi))
  pi.on('turn_end', async (event, ctx) => handleTurnEnd(event, ctx, pi))
  pi.on('agent_end', async (event, ctx) => handleAgentEnd(event, ctx, pi))
  if (typeof pi.registerTool === 'function') pi.registerTool(signalToolDefinition(pi))
}

module.exports = registerPiExtension
module.exports.default = registerPiExtension
module.exports.METHODOLOGY_GUIDANCE = METHODOLOGY_GUIDANCE
module.exports.injectMethodology = injectMethodology
module.exports.signalToolDefinition = signalToolDefinition
