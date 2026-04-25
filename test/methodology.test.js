const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  methodology,
  cloneMethodology,
  renderCompletionAccountability,
  renderMethodologySummary,
  renderSignalDirective
} = require('../lib/methodology')

describe('shared methodology', () => {
  it('defines structured signal meanings for done, stuck, and idle', () => {
    assert.deepStrictEqual(Object.keys(methodology.signals).sort(), ['done', 'idle', 'stuck'])

    for (const signal of ['done', 'stuck', 'idle']) {
      assert.strictEqual(typeof methodology.signals[signal].meaning, 'string')
      assert.ok(methodology.signals[signal].meaning.length > 0)
      assert.strictEqual(typeof methodology.signals[signal].command, 'string')
      assert.ok(methodology.signals[signal].command.includes(`prove_it signal ${signal}`))
    }
  })

  it('represents completion-accountability rules as shared data', () => {
    const ids = methodology.completionAccountability.rules.map(rule => rule.id)

    assert.deepStrictEqual(ids, [
      'declare-on-coherent-task',
      'verification-activation',
      'completion-language-restrictions',
      'preserve-on-fail',
      'clear-on-pass'
    ])

    for (const rule of methodology.completionAccountability.rules) {
      assert.strictEqual(typeof rule.meaning, 'string')
      assert.ok(rule.meaning.length > 0)
    }
    assert.match(
      methodology.completionAccountability.rules.find(rule => rule.id === 'preserve-on-fail').meaning,
      /preserves the active completion claim/
    )
    assert.match(
      methodology.completionAccountability.rules.find(rule => rule.id === 'clear-on-pass').meaning,
      /clears the active completion claim/
    )
  })

  it('represents evidence-oriented proving as methodology data', () => {
    assert.strictEqual(methodology.evidenceProving.id, 'evidence-oriented-proving')
    assert.ok(methodology.evidenceProving.principles.some(principle => /evidence/i.test(principle)))
    assert.ok(methodology.evidenceProving.principles.some(principle => /honest/i.test(principle)))
  })

  it('keeps TDD in the default profile instead of core invariants', () => {
    assert.ok(!methodology.coreInvariants.some(invariant => /TDD/i.test(invariant)))
    assert.match(methodology.defaultProfile.name, /TDD/i)
  })

  it('renders completion guidance from the supplied methodology data', () => {
    const custom = cloneMethodology()
    custom.signals.done.command = 'prove_it signal shipped'
    custom.completionAccountability.rules.find(rule => rule.id === 'declare-on-coherent-task').guidance =
      '**Declare completion with the custom shared signal.**'
    custom.completionAccountability.validIncompleteReasons.push('A custom shared-data reason')

    const text = renderCompletionAccountability({ methodology: custom })

    assert.ok(text.includes('prove_it signal shipped'))
    assert.ok(text.includes('Declare completion with the custom shared signal'))
    assert.ok(text.includes('A custom shared-data reason'))
  })

  it('renders signal directives from shared signal data', () => {
    const custom = cloneMethodology()
    custom.signals.stuck.directive = 'Custom stuck directive from shared data.'

    assert.strictEqual(renderSignalDirective('stuck', { methodology: custom }), 'Custom stuck directive from shared data.')
    assert.strictEqual(renderSignalDirective('unknown', { methodology: custom }), 'When ready, run `prove_it signal unknown`.')
  })

  it('renders a concise methodology summary from shared evidence data', () => {
    const custom = cloneMethodology()
    custom.evidenceProving.conciseDirective = 'Custom evidence directive from shared data.'

    const text = renderMethodologySummary({ methodology: custom })

    assert.ok(text.includes('prove_it methodology'))
    assert.ok(text.includes('Custom evidence directive from shared data.'))
  })

  it('does not depend on adapter-specific APIs or config paths', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'methodology.js'), 'utf8')

    assert.ok(!source.includes('.claude/prove_it'))
    assert.ok(!source.includes('@mariozechner/pi'))
    assert.ok(!source.includes('@openai/codex'))
    assert.ok(!source.includes('require(\'../adapters'))
    assert.ok(!source.includes('require(\'./adapters'))
  })
})
