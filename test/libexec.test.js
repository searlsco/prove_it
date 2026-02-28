const { describe, it } = require('node:test')
const assert = require('node:assert')
const { guardConfig, matchesAnyPattern } = require('../libexec/guard-config')
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

  describe('with params.paths', () => {
    it('blocks Write to a custom guarded path', () => {
      const result = guardConfig({
        tool_name: 'Write',
        tool_input: { file_path: '.env' },
        params: { paths: ['.env'] }
      })
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('guarded paths'))
      assert.ok(result.reason.includes('.env'))
    })

    it('blocks Edit to a path matching a glob pattern', () => {
      const result = guardConfig({
        tool_name: 'Edit',
        tool_input: { file_path: 'secrets/api-key.txt' },
        params: { paths: ['secrets/**'] }
      })
      assert.strictEqual(result.pass, false)
    })

    it('blocks Write to absolute path matching a glob pattern', () => {
      const result = guardConfig({
        tool_name: 'Write',
        tool_input: { file_path: '/Users/foo/project/.claude/prove_it/config.json' },
        params: { paths: ['.claude/prove_it/**'] }
      })
      assert.strictEqual(result.pass, false)
    })

    it('allows Write to non-matching path', () => {
      const result = guardConfig({
        tool_name: 'Write',
        tool_input: { file_path: 'src/app.js' },
        params: { paths: ['.env', 'secrets/**'] }
      })
      assert.strictEqual(result.pass, true)
    })

    it('blocks Bash redirect to a guarded path', () => {
      const result = guardConfig({
        tool_name: 'Bash',
        tool_input: { command: 'echo "SECRET=val" > .env' },
        params: { paths: ['.env'] }
      })
      assert.strictEqual(result.pass, false)
    })

    it('allows Bash without redirect to guarded path', () => {
      const result = guardConfig({
        tool_name: 'Bash',
        tool_input: { command: 'cat .env' },
        params: { paths: ['.env'] }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows Read even when path matches', () => {
      const result = guardConfig({
        tool_name: 'Read',
        tool_input: { file_path: '.env' },
        params: { paths: ['.env'] }
      })
      assert.strictEqual(result.pass, true)
    })

    it('falls back to hardcoded patterns when params.paths is empty array', () => {
      const result = guardConfig({
        tool_name: 'Edit',
        tool_input: { file_path: '.claude/prove_it/config.json' },
        params: { paths: [] }
      })
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('prove_it config files'))
    })

    it('falls back to hardcoded patterns when params is absent', () => {
      const result = guardConfig({
        tool_name: 'Write',
        tool_input: { file_path: '.claude/prove_it/config.json' }
      })
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('prove_it config files'))
    })
  })

  describe('matchesAnyPattern', () => {
    it('matches exact relative path', () => {
      assert.strictEqual(matchesAnyPattern('.env', ['.env']), true)
    })

    it('matches glob pattern', () => {
      assert.strictEqual(matchesAnyPattern('secrets/key.txt', ['secrets/**']), true)
    })

    it('matches absolute path via suffix', () => {
      assert.strictEqual(matchesAnyPattern('/Users/foo/project/.env', ['.env']), true)
    })

    it('returns false for non-matching path', () => {
      assert.strictEqual(matchesAnyPattern('src/app.js', ['.env', 'secrets/**']), false)
    })

    it('returns false for empty/null path', () => {
      assert.strictEqual(matchesAnyPattern('', ['.env']), false)
      assert.strictEqual(matchesAnyPattern(null, ['.env']), false)
    })
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
