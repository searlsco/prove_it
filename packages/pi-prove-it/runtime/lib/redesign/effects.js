const EFFECT_TYPES = Object.freeze({
  NOOP: 'noop',
  ALLOW: 'allow',
  APPROVE: 'approve',
  BLOCK: 'block',
  FAIL: 'fail',
  CONTEXT_INJECTION: 'context_injection',
  ENV_UPDATE: 'env_update',
  STATE_UPDATE: 'state_update',
  OBSERVATION: 'observation',
  REMEDIATION: 'remediation'
})

function makeEffect (effect, fields = {}) {
  return {
    effect,
    ...fields
  }
}

function noopEffect () {
  return makeEffect(EFFECT_TYPES.NOOP)
}

function allowEffect (fields = {}) {
  return makeEffect(EFFECT_TYPES.ALLOW, fields)
}

function approveEffect (reason, fields = {}) {
  return makeEffect(EFFECT_TYPES.APPROVE, reason ? { reason, ...fields } : fields)
}

function blockEffect (reason, fields = {}) {
  return makeEffect(EFFECT_TYPES.BLOCK, reason ? { reason, ...fields } : fields)
}

function failEffect (reason, fields = {}) {
  return makeEffect(EFFECT_TYPES.FAIL, reason ? { reason, ...fields } : fields)
}

function contextInjectionEffect (context, fields = {}) {
  return makeEffect(EFFECT_TYPES.CONTEXT_INJECTION, { context, ...fields })
}

function envUpdateEffect (env, fields = {}) {
  return makeEffect(EFFECT_TYPES.ENV_UPDATE, { env, ...fields })
}

function stateUpdateEffect (state, fields = {}) {
  return makeEffect(EFFECT_TYPES.STATE_UPDATE, { state, ...fields })
}

function observationEffect (observation, fields = {}) {
  return makeEffect(EFFECT_TYPES.OBSERVATION, { observation, ...fields })
}

function remediationEffect (message, fields = {}) {
  return makeEffect(EFFECT_TYPES.REMEDIATION, { message, ...fields })
}

module.exports = {
  EFFECT_TYPES,
  allowEffect,
  approveEffect,
  blockEffect,
  contextInjectionEffect,
  envUpdateEffect,
  failEffect,
  noopEffect,
  observationEffect,
  remediationEffect,
  stateUpdateEffect
}
