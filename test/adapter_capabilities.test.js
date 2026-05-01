const { describe, it } = require('node:test')
const assert = require('node:assert')

const {
  ADAPTER_CAPABILITY_PROFILES,
  behaviorForCapability,
  isHardBlock,
  isObserveOnly,
  isRemediation,
  renderAdapterCapabilityDiagnostics,
  validateAdapterCapabilityProfile,
  validateAdapterCapabilityProfiles
} = require('../lib/adapter_capabilities')

describe('adapter capability profiles', () => {
  it('validates the shipped Claude and Pi capability declarations', () => {
    assert.doesNotThrow(() => validateAdapterCapabilityProfiles(ADAPTER_CAPABILITY_PROFILES))

    assert.deepStrictEqual(
      ADAPTER_CAPABILITY_PROFILES.claude.capabilities.pre_tool_blocking,
      {
        strength: 'hard_block',
        hook: 'PreToolUse',
        diagnostic: 'Claude PreToolUse supports hard pre-tool blocking.'
      }
    )
    assert.deepStrictEqual(
      ADAPTER_CAPABILITY_PROFILES.claude.capabilities.completion_verification,
      {
        strength: 'hard_block',
        hook: 'Stop',
        diagnostic: 'Claude Stop supports hard completion blocking.'
      }
    )
    assert.strictEqual(ADAPTER_CAPABILITY_PROFILES.claude.capabilities.post_tool_observation.strength, 'observe_only')
    assert.strictEqual(ADAPTER_CAPABILITY_PROFILES.claude.capabilities.prompt_injection.strength, 'available')
    assert.strictEqual(ADAPTER_CAPABILITY_PROFILES.claude.capabilities.session_state.strength, 'available')

    const pi = ADAPTER_CAPABILITY_PROFILES.pi.capabilities
    assert.strictEqual(pi.pre_tool_blocking.strength, 'hard_block')
    assert.strictEqual(pi.post_tool_observation.strength, 'observe_only')
    assert.strictEqual(pi.prompt_injection.strength, 'available')
    assert.strictEqual(pi.model_callable_tools.strength, 'available')
    assert.strictEqual(pi.session_state.strength, 'available')
    assert.strictEqual(pi.completion_verification.strength, 'remediation')
    assert.strictEqual(pi.completion_verification.event, 'turn_end')
    assert.strictEqual(ADAPTER_CAPABILITY_PROFILES.pi.experimental, undefined)
  })

  it('rejects unknown capability names and enforcement strengths', () => {
    assert.throws(
      () => validateAdapterCapabilityProfile('test', {
        capabilities: {
          imaginary_capability: { strength: 'hard_block' }
        }
      }),
      /unknown capability "imaginary_capability"/
    )

    assert.throws(
      () => validateAdapterCapabilityProfile('test', {
        capabilities: {
          pre_tool_blocking: { strength: 'soft_block' }
        }
      }),
      /unknown enforcement strength "soft_block"/
    )
  })

  it('selects hard-block, observe-only, and remediation behaviors', () => {
    assert.ok(isHardBlock(behaviorForCapability('claude', 'pre_tool_blocking')))
    assert.ok(isObserveOnly(behaviorForCapability('claude', 'post_tool_observation')))
    assert.ok(isHardBlock(behaviorForCapability('claude', 'completion_verification')))
    assert.ok(isObserveOnly(behaviorForCapability('pi', 'post_tool_observation')))
    assert.ok(isRemediation(behaviorForCapability('pi', 'completion_verification')))
  })

  it('renders Pi completion-remediation diagnostic wording', () => {
    const output = renderAdapterCapabilityDiagnostics(ADAPTER_CAPABILITY_PROFILES)

    assert.match(output, /Pi adapter capabilities:/)
    assert.match(output, /completion verification: remediation after turn_end/)
    assert.match(output, /Pi cannot hard-block completion; prove_it prompts remediation from turn_end and preserves agent_end settlement/)
    assert.doesNotMatch(output, /experimental/i)
  })
})
