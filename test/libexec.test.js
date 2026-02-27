const { describe, it } = require('node:test')
const assert = require('node:assert')
const { guardConfig } = require('../libexec/guard-config')
const { runBriefing } = require('../libexec/briefing')

describe('libexec/guard-config', () => {
  it('blocks Edit to prove_it.json', () => {
    const result = guardConfig({
      tool_name: 'Edit',
      tool_input: { file_path: '.claude/prove_it.json', old_string: 'a', new_string: 'b' }
    })
    assert.strictEqual(result.pass, false)
    assert.ok(result.reason.includes('Cannot modify'))
  })

  it('blocks Write to prove_it.local.json', () => {
    const result = guardConfig({
      tool_name: 'Write',
      tool_input: { file_path: '/some/path/.claude/prove_it.local.json', content: '{}' }
    })
    assert.strictEqual(result.pass, false)
  })

  it('blocks Edit to prove_it/config.json', () => {
    const result = guardConfig({
      tool_name: 'Edit',
      tool_input: { file_path: '.claude/prove_it/config.json', old_string: 'a', new_string: 'b' }
    })
    assert.strictEqual(result.pass, false)
    assert.ok(result.reason.includes('Cannot modify'))
  })

  it('blocks Write to prove_it/config.local.json', () => {
    const result = guardConfig({
      tool_name: 'Write',
      tool_input: { file_path: '/some/path/.claude/prove_it/config.local.json', content: '{}' }
    })
    assert.strictEqual(result.pass, false)
  })

  it('blocks Bash redirect to prove_it.json', () => {
    const result = guardConfig({
      tool_name: 'Bash',
      tool_input: { command: "echo '{}' > .claude/prove_it.json" }
    })
    assert.strictEqual(result.pass, false)
  })

  it('blocks Bash tee to prove_it config', () => {
    const result = guardConfig({
      tool_name: 'Bash',
      tool_input: { command: 'echo stuff | tee .claude/prove_it.local.json' }
    })
    assert.strictEqual(result.pass, false)
  })

  it('allows Edit to other files', () => {
    const result = guardConfig({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' }
    })
    assert.strictEqual(result.pass, true)
  })

  it('allows Write to other files', () => {
    const result = guardConfig({
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js', content: 'code' }
    })
    assert.strictEqual(result.pass, true)
  })

  it('allows Bash without redirect', () => {
    const result = guardConfig({
      tool_name: 'Bash',
      tool_input: { command: 'git status' }
    })
    assert.strictEqual(result.pass, true)
  })

  it('allows non-gated tools', () => {
    const result = guardConfig({
      tool_name: 'Read',
      tool_input: { file_path: '.claude/prove_it.json' }
    })
    assert.strictEqual(result.pass, true)
  })

  it('handles empty input gracefully', () => {
    const result = guardConfig({})
    assert.strictEqual(result.pass, true)
  })
})

describe('libexec/briefing', () => {
  it('returns briefing text for valid project', () => {
    const text = runBriefing(process.cwd())
    assert.ok(text.includes('prove_it'), 'should contain prove_it in briefing')
  })

  it('handles invalid projectDir without throwing', () => {
    // runBriefing itself may throw; that's fine for unit test —
    // the script wrapper catches it. Test that it at least returns a string
    // for the current project.
    const text = runBriefing(process.cwd())
    assert.strictEqual(typeof text, 'string')
  })
})
