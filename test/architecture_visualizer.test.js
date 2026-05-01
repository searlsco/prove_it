const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { createArchitectureModel } = require('../tools/visualizer/architecture_model')
const { capabilityPhrase, renderArchitectureMarkdown } = require('../tools/visualizer/render_markdown')

const ROOT = path.join(__dirname, '..')

describe('architecture visualizer', () => {
  it('builds a source-driven model for the clean runtime adapter architecture', () => {
    const model = createArchitectureModel()

    assert.strictEqual(model.title, 'prove_it architecture visualizer')
    assert.deepStrictEqual(model.primaryAudience, [
      'contributors',
      'adapter authors',
      'technical stakeholders'
    ])
    assert.deepStrictEqual(model.flow.map(step => step.id), [
      'harnesses',
      'adapters',
      'normalized_events',
      'workflow_engine',
      'effects',
      'rendering'
    ])
    assert.ok(model.sharedResponsibilities.includes('harness-neutral Workflow Effects'))
    assert.ok(model.adapterResponsibilities.includes('protocol-specific effect rendering'))
    assert.deepStrictEqual(model.unsupportedAdapters.map(adapter => adapter.id), ['codex'])
  })

  it('represents adapter capability differences from capability declarations', () => {
    const model = createArchitectureModel()
    const claude = model.adapters.find(adapter => adapter.id === 'claude')
    const pi = model.adapters.find(adapter => adapter.id === 'pi')

    assert.strictEqual(capabilityPhrase(findCapability(claude, 'pre_tool_blocking')), 'hard block via PreToolUse')
    assert.strictEqual(capabilityPhrase(findCapability(claude, 'post_tool_observation')), 'observe-only via PostToolUse')
    assert.strictEqual(capabilityPhrase(findCapability(claude, 'prompt_injection')), 'available via SessionStart')
    assert.strictEqual(capabilityPhrase(findCapability(claude, 'model_callable_tools')), 'unsupported')
    assert.strictEqual(capabilityPhrase(findCapability(claude, 'session_state')), 'available')
    assert.strictEqual(capabilityPhrase(findCapability(claude, 'completion_verification')), 'hard block via Stop')

    assert.strictEqual(capabilityPhrase(findCapability(pi, 'pre_tool_blocking')), 'hard block via tool_call')
    assert.strictEqual(capabilityPhrase(findCapability(pi, 'post_tool_observation')), 'observe-only via tool_result')
    assert.strictEqual(capabilityPhrase(findCapability(pi, 'prompt_injection')), 'available via before_agent_start')
    assert.strictEqual(capabilityPhrase(findCapability(pi, 'model_callable_tools')), 'available')
    assert.strictEqual(capabilityPhrase(findCapability(pi, 'session_state')), 'available')
    assert.strictEqual(capabilityPhrase(findCapability(pi, 'completion_verification')), 'remediation after turn_end')
  })

  it('renders a documentation-friendly architecture markdown artifact', () => {
    const output = renderArchitectureMarkdown(createArchitectureModel())

    assert.match(output, /```mermaid\nflowchart LR/)
    assert.match(output, /Claude Code harness.*Claude Adapter/)
    assert.match(output, /Pi harness.*Pi Adapter/)
    assert.match(output, /Normalize lifecycle event/)
    assert.match(output, /Workflow Engine/)
    assert.match(output, /Adapter capability matrix/)
    assert.match(output, /completion verification \| hard block via Stop \| remediation after turn_end/)
    assert.match(output, /Codex.*not implemented/)
    assert.doesNotMatch(output, /experimental/i)
  })

  it('keeps the generated architecture document up to date', () => {
    const expected = `${renderArchitectureMarkdown(createArchitectureModel())}\n`
    const actual = fs.readFileSync(path.join(ROOT, 'docs', 'architecture.md'), 'utf8')

    assert.strictEqual(actual, expected)
  })
})

function findCapability (adapter, capabilityId) {
  return adapter.capabilities.find(capability => capability.id === capabilityId)
}
