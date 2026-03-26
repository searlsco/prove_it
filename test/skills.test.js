const { describe, it } = require('node:test')
const assert = require('node:assert')
const { extractTemplateVars, generateStandaloneBody, restoreTemplateVars, generateStandaloneSkill } = require('../lib/skills')
const { VAR_DESCRIPTIONS } = require('../lib/template')

describe('skills', () => {
  describe('extractTemplateVars', () => {
    it('returns ordered bare vars', () => {
      const body = '{{git_status}}\n{{files_changed_since_last_run}}'
      assert.deepStrictEqual(extractTemplateVars(body), ['git_status', 'files_changed_since_last_run'])
    })

    it('skips conditional markers', () => {
      const body = '{{#signal_message}}\nMsg: {{signal_message}}\n{{/signal_message}}'
      assert.deepStrictEqual(extractTemplateVars(body), ['signal_message'])
    })

    it('returns empty array for null', () => {
      assert.deepStrictEqual(extractTemplateVars(null), [])
    })

    it('returns empty array for body with no vars', () => {
      assert.deepStrictEqual(extractTemplateVars('just plain text'), [])
    })

    it('preserves duplicates in order', () => {
      const body = '{{git_status}} then {{git_status}}'
      assert.deepStrictEqual(extractTemplateVars(body), ['git_status', 'git_status'])
    })
  })

  describe('generateStandaloneBody', () => {
    it('replaces vars with descriptions', () => {
      const body = 'Status:\n{{git_status}}'
      const result = generateStandaloneBody(body)
      assert.strictEqual(result, `Status:\n{{${VAR_DESCRIPTIONS.git_status}}}`)
    })

    it('strips conditional markers', () => {
      const body = '{{#signal_message}}\nMsg: {{signal_message}}\n{{/signal_message}}\nEnd'
      const result = generateStandaloneBody(body)
      assert.strictEqual(result, `Msg: {{${VAR_DESCRIPTIONS.signal_message}}}\nEnd`)
    })

    it('handles multiple vars', () => {
      const body = '{{changes_since_last_run}}\n{{git_status}}'
      const result = generateStandaloneBody(body)
      assert.strictEqual(result, `{{${VAR_DESCRIPTIONS.changes_since_last_run}}}\n{{${VAR_DESCRIPTIONS.git_status}}}`)
    })

    it('leaves unknown vars unchanged', () => {
      const body = '{{unknown_thing}}'
      assert.strictEqual(generateStandaloneBody(body), '{{unknown_thing}}')
    })

    it('returns null for null input', () => {
      assert.strictEqual(generateStandaloneBody(null), null)
    })

    it('returns body unchanged when no vars present', () => {
      const body = 'No variables here.'
      assert.strictEqual(generateStandaloneBody(body), 'No variables here.')
    })
  })

  describe('restoreTemplateVars', () => {
    it('positional roundtrip recovers var names', () => {
      const internal = '{{changes_since_last_run}}\n{{git_status}}'
      const standalone = generateStandaloneBody(internal)
      const restored = restoreTemplateVars(standalone, internal)
      assert.strictEqual(restored, internal)
    })

    it('recovers vars even when user changed descriptions', () => {
      const internal = '{{changes_since_last_run}}\n{{git_status}}'
      const edited = '{{my custom description}}\n{{another thing}}'
      const restored = restoreTemplateVars(edited, internal)
      assert.strictEqual(restored, '{{changes_since_last_run}}\n{{git_status}}')
    })

    it('handles fewer standalone tokens than internal vars', () => {
      const internal = '{{changes_since_last_run}}\n{{git_status}}\n{{recent_commits}}'
      const standalone = '{{only one token}}'
      const restored = restoreTemplateVars(standalone, internal)
      assert.strictEqual(restored, '{{changes_since_last_run}}')
    })

    it('passes through extra tokens beyond var count', () => {
      const internal = '{{git_status}}'
      const standalone = '{{first}}\n{{extra token with spaces}}'
      const restored = restoreTemplateVars(standalone, internal)
      assert.strictEqual(restored, '{{git_status}}\n{{extra token with spaces}}')
    })

    it('returns standalone unchanged when internal has no vars', () => {
      const standalone = 'No {{vars with spaces}} here'
      const internal = 'plain text'
      const restored = restoreTemplateVars(standalone, internal)
      assert.strictEqual(restored, standalone)
    })

    it('returns null/undefined for null/undefined input', () => {
      assert.strictEqual(restoreTemplateVars(null, 'body'), null)
      assert.strictEqual(restoreTemplateVars(undefined, 'body'), undefined)
    })

    it('skips conditional markers in old-format installed files', () => {
      // Old installed files have raw {{#var}} and {{/var}} markers.
      // restoreTemplateVars must skip them to avoid shifting positions.
      const internal = [
        '{{changes_since_last_run}}',
        '{{#signal_message}}',
        'Signal: {{signal_message}}',
        '{{/signal_message}}',
        '{{git_status}}'
      ].join('\n')
      // Old installed = same as internal (raw format)
      const restored = restoreTemplateVars(internal, internal)
      // Conditional markers must survive unchanged
      assert.ok(restored.includes('{{#signal_message}}'), 'opening marker should pass through')
      assert.ok(restored.includes('{{/signal_message}}'), 'closing marker should pass through')
      // The bare vars should be correctly positioned
      const vars = extractTemplateVars(restored)
      assert.deepStrictEqual(vars, ['changes_since_last_run', 'signal_message', 'git_status'])
    })

    it('full roundtrip with conditionals', () => {
      const internal = [
        '{{changes_since_last_run}}',
        '{{files_changed_since_last_run}}',
        '{{#signal_message}}',
        'Signal: {{signal_message}}',
        '{{/signal_message}}',
        '{{git_status}}'
      ].join('\n')

      const standalone = generateStandaloneBody(internal)
      const restored = restoreTemplateVars(standalone, internal)

      // The conditionals are stripped, so the restored body has vars
      // positionally mapped from the internal body's bare vars
      const vars = extractTemplateVars(restored)
      const expectedVars = extractTemplateVars(internal)
      assert.deepStrictEqual(vars, expectedVars)
    })

    it('restores conditional markers with correct nesting for adjacent blocks', () => {
      const internal = [
        '{{changes_since_last_run}}',
        '{{#session_diff}}',
        'Diff:',
        '{{session_diff}}',
        '{{/session_diff}}',
        '{{#signal_message}}',
        'Signal: {{signal_message}}',
        '{{/signal_message}}',
        '{{git_status}}'
      ].join('\n')

      const standalone = generateStandaloneBody(internal)
      assert.ok(!standalone.includes('{{#'), 'standalone should not have opening markers')
      assert.ok(!standalone.includes('{{/'), 'standalone should not have closing markers')

      const restored = restoreTemplateVars(standalone, internal)

      // Verify structural correctness: extract conditional blocks via regex
      // (same approach expandTemplate uses) and verify each one
      const blocks = []
      restored.replace(/\{\{#(\w+)\}\}\n([\s\S]*?)\n\{\{\/(\w+)\}\}/g, (m, open, content, close) => {
        blocks.push({ open, close, content })
      })
      assert.strictEqual(blocks.length, 2, 'should have exactly 2 conditional blocks')
      // First block: session_diff
      assert.strictEqual(blocks[0].open, 'session_diff')
      assert.strictEqual(blocks[0].close, 'session_diff', 'opening and closing tags must match')
      assert.ok(blocks[0].content.includes('{{session_diff}}'), 'block should contain its var')
      // Second block: signal_message
      assert.strictEqual(blocks[1].open, 'signal_message')
      assert.strictEqual(blocks[1].close, 'signal_message', 'opening and closing tags must match')
      assert.ok(blocks[1].content.includes('{{signal_message}}'), 'block should contain its var')

      // Non-conditional vars should NOT get markers
      assert.ok(!restored.includes('{{#changes_since_last_run}}'))
      assert.ok(!restored.includes('{{#git_status}}'))

      // Verify no block contains another block's markers (no nesting corruption)
      assert.ok(!blocks[0].content.includes('{{#signal_message}}'), 'session_diff block should not contain signal_message marker')
      assert.ok(!blocks[1].content.includes('{{/session_diff}}'), 'signal_message block should not contain session_diff closing marker')
    })
  })

  describe('generateStandaloneSkill', () => {
    it('preserves frontmatter and transforms body', () => {
      const full = '---\nname: test\n---\nStatus:\n{{git_status}}'
      const result = generateStandaloneSkill(full)
      assert.ok(result.startsWith('---\nname: test\n---\n'))
      assert.ok(result.includes(`{{${VAR_DESCRIPTIONS.git_status}}}`))
      assert.ok(!result.includes('{{git_status}}'))
    })

    it('handles content with no frontmatter', () => {
      const body = '{{git_status}}'
      const result = generateStandaloneSkill(body)
      assert.strictEqual(result, `{{${VAR_DESCRIPTIONS.git_status}}}`)
    })

    it('returns null for null input', () => {
      assert.strictEqual(generateStandaloneSkill(null), null)
    })

    it('handles frontmatter without closing delimiter', () => {
      const content = '---\nname: broken\nno closing'
      const result = generateStandaloneSkill(content)
      assert.strictEqual(result, content)
    })
  })
})
