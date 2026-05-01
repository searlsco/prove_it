'use strict'

const CAPABILITY_NAMES = [
  'pre_tool_blocking',
  'post_tool_observation',
  'prompt_injection',
  'model_callable_tools',
  'session_state',
  'completion_verification'
]

const ENFORCEMENT_STRENGTHS = [
  'hard_block',
  'observe_only',
  'remediation',
  'available'
]

const CAPABILITY_LABELS = {
  pre_tool_blocking: 'pre-tool blocking',
  post_tool_observation: 'post-tool observation',
  prompt_injection: 'prompt injection',
  model_callable_tools: 'model-callable tools',
  session_state: 'session state',
  completion_verification: 'completion verification'
}

const STRENGTH_LABELS = {
  hard_block: 'hard block',
  observe_only: 'observe-only',
  remediation: 'remediation',
  available: 'available'
}

const ADAPTER_CAPABILITY_PROFILES = {
  claude: {
    displayName: 'Claude',
    capabilities: {
      pre_tool_blocking: {
        strength: 'hard_block',
        hook: 'PreToolUse',
        diagnostic: 'Claude PreToolUse supports hard pre-tool blocking.'
      },
      post_tool_observation: {
        strength: 'observe_only',
        hook: 'PostToolUse',
        diagnostic: 'Claude post-tool hooks observe completed tool calls without changing the completed tool result.'
      },
      prompt_injection: {
        strength: 'available',
        hook: 'SessionStart',
        diagnostic: 'Claude SessionStart can inject prove_it guidance into the active session.'
      },
      session_state: {
        strength: 'available',
        diagnostic: 'Claude uses adapter-owned filesystem-backed Session State.'
      },
      completion_verification: {
        strength: 'hard_block',
        hook: 'Stop',
        diagnostic: 'Claude Stop supports hard completion blocking.'
      }
    }
  },
  pi: {
    displayName: 'Pi',
    capabilities: {
      pre_tool_blocking: {
        strength: 'hard_block',
        event: 'tool_call',
        diagnostic: 'Pi tool_call supports hard pre-tool blocking.'
      },
      post_tool_observation: {
        strength: 'observe_only',
        event: 'tool_result',
        diagnostic: 'Pi post-tool hooks observe tool outcomes without blocking completed tool calls.'
      },
      prompt_injection: {
        strength: 'available',
        event: 'before_agent_start',
        diagnostic: 'Pi can inject prove_it guidance before the agent starts.'
      },
      model_callable_tools: {
        strength: 'available',
        diagnostic: 'Pi exposes model-callable tools for in-session prove_it actions.'
      },
      session_state: {
        strength: 'available',
        diagnostic: 'Pi exposes session state for adapter workflows.'
      },
      completion_verification: {
        strength: 'remediation',
        event: 'turn_end',
        diagnostic: 'Pi cannot hard-block completion; prove_it prompts remediation from turn_end and preserves agent_end settlement.'
      }
    }
  }
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateAdapterCapabilityProfile (adapterName, profile) {
  if (!isPlainObject(profile)) {
    throw new Error(`${adapterName}: adapter capability profile must be an object`)
  }
  if (!isPlainObject(profile.capabilities)) {
    throw new Error(`${adapterName}: capabilities must be an object`)
  }

  for (const [capabilityName, declaration] of Object.entries(profile.capabilities)) {
    if (!CAPABILITY_NAMES.includes(capabilityName)) {
      throw new Error(`${adapterName}: unknown capability "${capabilityName}"`)
    }
    if (!isPlainObject(declaration)) {
      throw new Error(`${adapterName}.${capabilityName}: declaration must be an object`)
    }
    if (!ENFORCEMENT_STRENGTHS.includes(declaration.strength)) {
      throw new Error(`${adapterName}.${capabilityName}: unknown enforcement strength "${declaration.strength}"`)
    }
    for (const field of ['event', 'hook', 'diagnostic']) {
      if (declaration[field] !== undefined && typeof declaration[field] !== 'string') {
        throw new Error(`${adapterName}.${capabilityName}: ${field} must be a string`)
      }
    }
  }

  return profile
}

function validateAdapterCapabilityProfiles (profiles) {
  if (!isPlainObject(profiles)) {
    throw new Error('adapter capability profiles must be an object')
  }
  for (const [adapterName, profile] of Object.entries(profiles)) {
    validateAdapterCapabilityProfile(adapterName, profile)
  }
  return profiles
}

function behaviorForCapability (adapterName, capabilityName, profiles = ADAPTER_CAPABILITY_PROFILES) {
  const profile = profiles[adapterName]
  const declaration = profile?.capabilities?.[capabilityName]
  if (!declaration) {
    return {
      adapter: adapterName,
      capability: capabilityName,
      strength: null,
      mode: 'unsupported',
      supported: false,
      canBlock: false,
      observeOnly: false,
      remediation: false
    }
  }

  return {
    adapter: adapterName,
    capability: capabilityName,
    ...declaration,
    mode: declaration.strength,
    supported: true,
    canBlock: declaration.strength === 'hard_block',
    observeOnly: declaration.strength === 'observe_only',
    remediation: declaration.strength === 'remediation'
  }
}

function strengthOf (behavior) {
  if (typeof behavior === 'string') return behavior
  return behavior?.strength || behavior?.mode || null
}

function isHardBlock (behavior) {
  return strengthOf(behavior) === 'hard_block'
}

function isObserveOnly (behavior) {
  return strengthOf(behavior) === 'observe_only'
}

function isRemediation (behavior) {
  return strengthOf(behavior) === 'remediation'
}

function displayNameFor (adapterName, profile) {
  return profile.displayName || adapterName.charAt(0).toUpperCase() + adapterName.slice(1)
}

function locationFor (declaration) {
  return declaration.hook || declaration.event || null
}

function renderCapabilityLine (capabilityName, declaration) {
  const label = CAPABILITY_LABELS[capabilityName] || capabilityName
  const strength = STRENGTH_LABELS[declaration.strength] || declaration.strength
  const location = locationFor(declaration)
  const preposition = declaration.strength === 'remediation' ? 'after' : 'via'
  const suffix = location ? ` ${preposition} ${location}` : ''
  const marker = declaration.strength === 'remediation' ? '[i]' : '[x]'
  return `    ${marker} ${label}: ${strength}${suffix}`
}

function renderAdapterCapabilityDiagnostics (profiles = ADAPTER_CAPABILITY_PROFILES) {
  validateAdapterCapabilityProfiles(profiles)

  const lines = ['Adapter capability diagnostics:']
  for (const [adapterName, profile] of Object.entries(profiles)) {
    lines.push(`  ${displayNameFor(adapterName, profile)} adapter capabilities:`)
    for (const [capabilityName, declaration] of Object.entries(profile.capabilities)) {
      lines.push(renderCapabilityLine(capabilityName, declaration))
      if (declaration.diagnostic) {
        lines.push(`      ${declaration.diagnostic}`)
      }
    }
  }
  return lines.join('\n')
}

module.exports = {
  ADAPTER_CAPABILITY_PROFILES,
  CAPABILITY_LABELS,
  CAPABILITY_NAMES,
  ENFORCEMENT_STRENGTHS,
  behaviorForCapability,
  isHardBlock,
  isObserveOnly,
  isRemediation,
  renderAdapterCapabilityDiagnostics,
  validateAdapterCapabilityProfile,
  validateAdapterCapabilityProfiles
}
