const { describe, it } = require('node:test')
const assert = require('node:assert')
const builtins = require('../lib/checks/builtins')

describe('builtins', () => {
  describe('config:lock', () => {
    const configLock = builtins['config:lock']

    it('blocks Edit to prove_it.json', () => {
      const result = configLock({}, {
        toolName: 'Edit',
        toolInput: { file_path: '.claude/prove_it.json', old_string: 'a', new_string: 'b' }
      })
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('Cannot modify'))
    })

    it('blocks Write to prove_it.local.json', () => {
      const result = configLock({}, {
        toolName: 'Write',
        toolInput: { file_path: '/some/path/.claude/prove_it.local.json', content: '{}' }
      })
      assert.strictEqual(result.pass, false)
    })

    it('blocks Edit to prove_it/config.json', () => {
      const result = configLock({}, {
        toolName: 'Edit',
        toolInput: { file_path: '.claude/prove_it/config.json', old_string: 'a', new_string: 'b' }
      })
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('Cannot modify'))
    })

    it('blocks Write to prove_it/config.local.json', () => {
      const result = configLock({}, {
        toolName: 'Write',
        toolInput: { file_path: '/some/path/.claude/prove_it/config.local.json', content: '{}' }
      })
      assert.strictEqual(result.pass, false)
    })

    it('blocks Bash redirect to prove_it.json', () => {
      const result = configLock({}, {
        toolName: 'Bash',
        toolInput: { command: "echo '{}' > .claude/prove_it.json" }
      })
      assert.strictEqual(result.pass, false)
    })

    it('blocks Bash tee to prove_it config', () => {
      const result = configLock({}, {
        toolName: 'Bash',
        toolInput: { command: 'echo stuff | tee .claude/prove_it.local.json' }
      })
      assert.strictEqual(result.pass, false)
    })

    it('allows Edit to other files', () => {
      const result = configLock({}, {
        toolName: 'Edit',
        toolInput: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows Write to other files', () => {
      const result = configLock({}, {
        toolName: 'Write',
        toolInput: { file_path: 'src/app.js', content: 'code' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows Bash without redirect', () => {
      const result = configLock({}, {
        toolName: 'Bash',
        toolInput: { command: 'git status' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows non-gated tools', () => {
      const result = configLock({}, {
        toolName: 'Read',
        toolInput: { file_path: '.claude/prove_it.json' }
      })
      assert.strictEqual(result.pass, true)
    })
  })

  describe('session:briefing', () => {
    const sessionBriefing = builtins['session:briefing']

    it('returns pass with briefing text', () => {
      const result = sessionBriefing({}, {
        projectDir: process.cwd(),
        rootDir: process.cwd()
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('prove_it'), 'should contain prove_it in briefing')
    })

    it('always passes even with invalid projectDir', () => {
      const result = sessionBriefing({}, {
        projectDir: '/nonexistent/path',
        rootDir: '/nonexistent/path'
      })
      assert.strictEqual(result.pass, true)
    })
  })
})
