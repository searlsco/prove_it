const { loadProjectConfig } = require('../../redesign/config')
const { normalizePiToolCall } = require('../../redesign/events')
const { runPreToolWorkflow } = require('../../redesign/engine')

function renderToolCallEffect (effect) {
  if (!effect || effect.effect === 'allow') return undefined
  if (effect.effect === 'block') {
    return { block: true, reason: effect.reason }
  }
  return undefined
}

async function handleToolCall (event, ctx = {}) {
  const cwd = ctx.cwd || event?.cwd || process.cwd()
  let config

  try {
    config = loadProjectConfig(cwd)
  } catch (error) {
    return {
      block: true,
      reason: `prove_it: invalid .prove_it/config.json: ${error.message}`
    }
  }

  if (!config) return undefined

  const normalizedEvent = normalizePiToolCall(event, { ...ctx, cwd })
  const effect = runPreToolWorkflow(config, normalizedEvent)
  return renderToolCallEffect(effect)
}

module.exports = {
  handleToolCall,
  renderToolCallEffect
}
