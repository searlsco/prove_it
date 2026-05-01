'use strict'

const {
  ADAPTER_CAPABILITY_PROFILES,
  CAPABILITY_LABELS,
  CAPABILITY_NAMES,
  validateAdapterCapabilityProfiles
} = require('../../lib/adapter_capabilities')
const { LIFECYCLE_STAGES } = require('../../lib/redesign/events')

const STRENGTH_LABELS = Object.freeze({
  hard_block: 'hard block',
  observe_only: 'observe-only',
  remediation: 'remediation',
  available: 'available'
})

const LOCATION_FIELDS = Object.freeze(['hook', 'event'])
const WORKFLOW_STAGE_EXAMPLES = Object.freeze(Object.values(LIFECYCLE_STAGES))

function displayNameFor (adapterName, profile = {}) {
  return profile.displayName || adapterName.charAt(0).toUpperCase() + adapterName.slice(1)
}

function locationFor (declaration = {}) {
  for (const field of LOCATION_FIELDS) {
    if (declaration[field]) return { type: field, value: declaration[field] }
  }
  return null
}

function capabilityRow (capabilityName, declaration = null) {
  const supported = Boolean(declaration)
  const location = supported ? locationFor(declaration) : null

  return {
    id: capabilityName,
    label: CAPABILITY_LABELS[capabilityName] || capabilityName,
    supported,
    strength: supported ? declaration.strength : null,
    strengthLabel: supported ? STRENGTH_LABELS[declaration.strength] || declaration.strength : 'unsupported',
    locationType: location?.type || null,
    location: location?.value || null,
    diagnostic: supported ? declaration.diagnostic || null : null
  }
}

function adapterModel (adapterName, profile) {
  return {
    id: adapterName,
    displayName: displayNameFor(adapterName, profile),
    capabilities: CAPABILITY_NAMES.map(capabilityName => capabilityRow(
      capabilityName,
      profile.capabilities[capabilityName] || null
    ))
  }
}

function createArchitectureModel ({ profiles = ADAPTER_CAPABILITY_PROFILES } = {}) {
  validateAdapterCapabilityProfiles(profiles)

  return {
    title: 'prove_it architecture visualizer',
    summary: 'prove_it is a methodology/workflow engine. Harnesses such as Claude Code and Pi connect through adapters that normalize harness-native events into shared Workflow Engine stages, then render Workflow Engine effects back to each harness.',
    primaryAudience: [
      'contributors',
      'adapter authors',
      'technical stakeholders'
    ],
    sourceOfTruth: [
      'adapter capability declarations',
      'clean runtime workflow stages',
      'adapter-owned effect rendering boundaries'
    ],
    flow: [
      {
        id: 'harnesses',
        label: 'Harnesses',
        examples: ['Claude Code', 'Pi', 'future adapters'],
        description: 'Agent runtimes expose different native hooks, events, tools, state, and completion semantics.'
      },
      {
        id: 'adapters',
        label: 'Adapters',
        examples: ['Claude Adapter', 'Pi Adapter'],
        description: 'Adapters translate harness-native inputs into normalized lifecycle events and translate Workflow Engine effects back into harness-native protocol responses.'
      },
      {
        id: 'normalized_events',
        label: 'Normalized lifecycle events',
        examples: WORKFLOW_STAGE_EXAMPLES,
        description: 'Shared event shape used by the Workflow Engine regardless of which harness emitted the original event.'
      },
      {
        id: 'workflow_engine',
        label: 'Workflow Engine',
        examples: ['Project Config', 'Tasks', 'Pipelines', 'Signals', 'Session State', 'Evidence', 'Completion Verification'],
        description: 'The shared core evaluates strict project config and emits harness-neutral effects.'
      },
      {
        id: 'effects',
        label: 'Workflow effects',
        examples: ['allow', 'block', 'approve', 'remediation', 'context injection', 'env update'],
        description: 'Harness-neutral outcomes produced by shared workflow evaluation.'
      },
      {
        id: 'rendering',
        label: 'Adapter-specific rendering',
        examples: ['Claude hook JSON', 'Pi extension return values', 'Pi follow-up remediation messages'],
        description: 'Adapters own protocol details so shared workflow behavior does not become harness-specific.'
      }
    ],
    sharedResponsibilities: [
      'strict Project Config evaluation',
      'Task and Pipeline selection',
      'Signal lifecycle semantics',
      'phase and session-control semantics',
      'Completion Verification decisions',
      'Evidence and observation facts',
      'harness-neutral Workflow Effects'
    ],
    adapterResponsibilities: [
      'harness-native activation artifacts',
      'event and hook normalization',
      'session state storage integration',
      'tool and file-path extraction details',
      'reviewer provider integration where supported',
      'backchannel mechanics where supported',
      'protocol-specific effect rendering'
    ],
    adapters: Object.entries(profiles).map(([adapterName, profile]) => adapterModel(adapterName, profile)),
    unsupportedAdapters: [
      {
        id: 'codex',
        displayName: 'Codex',
        status: 'not implemented',
        note: 'Codex is documented as capability discovery only; it is not currently implemented as a prove_it adapter.'
      }
    ]
  }
}

module.exports = {
  STRENGTH_LABELS,
  createArchitectureModel
}
