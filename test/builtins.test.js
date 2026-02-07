const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const builtins = require('../lib/checks/builtins')

describe('builtins', () => {
  describe('config-protection', () => {
    const configProtection = builtins['config-protection']

    it('blocks Edit to prove_it.json', () => {
      const result = configProtection({}, {
        toolName: 'Edit',
        toolInput: { file_path: '.claude/prove_it.json', old_string: 'a', new_string: 'b' }
      })
      assert.strictEqual(result.pass, false)
      assert.ok(result.reason.includes('Cannot modify'))
    })

    it('blocks Write to prove_it.local.json', () => {
      const result = configProtection({}, {
        toolName: 'Write',
        toolInput: { file_path: '/some/path/.claude/prove_it.local.json', content: '{}' }
      })
      assert.strictEqual(result.pass, false)
    })

    it('blocks Bash redirect to prove_it.json', () => {
      const result = configProtection({}, {
        toolName: 'Bash',
        toolInput: { command: "echo '{}' > .claude/prove_it.json" }
      })
      assert.strictEqual(result.pass, false)
    })

    it('blocks Bash tee to prove_it config', () => {
      const result = configProtection({}, {
        toolName: 'Bash',
        toolInput: { command: 'echo stuff | tee .claude/prove_it.local.json' }
      })
      assert.strictEqual(result.pass, false)
    })

    it('allows Edit to other files', () => {
      const result = configProtection({}, {
        toolName: 'Edit',
        toolInput: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows Write to other files', () => {
      const result = configProtection({}, {
        toolName: 'Write',
        toolInput: { file_path: 'src/app.js', content: 'code' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows Bash without redirect', () => {
      const result = configProtection({}, {
        toolName: 'Bash',
        toolInput: { command: 'git status' }
      })
      assert.strictEqual(result.pass, true)
    })

    it('allows non-gated tools', () => {
      const result = configProtection({}, {
        toolName: 'Read',
        toolInput: { file_path: '.claude/prove_it.json' }
      })
      assert.strictEqual(result.pass, true)
    })
  })

  describe('beads-reminder', () => {
    const beadsReminder = builtins['beads-reminder']

    it('always passes', () => {
      const result = beadsReminder({}, {})
      assert.strictEqual(result.pass, true)
    })

    it('outputs reminder text', () => {
      const result = beadsReminder({}, {})
      assert.ok(result.reason.includes('prove_it active'))
      assert.ok(result.output.includes('verify'))
    })
  })

  describe('soft-stop-reminder', () => {
    const softStopReminder = builtins['soft-stop-reminder']

    it('always passes', () => {
      const result = softStopReminder({}, {})
      assert.strictEqual(result.pass, true)
    })

    it('outputs reminder text', () => {
      const result = softStopReminder({}, {})
      assert.ok(result.reason.includes('prove_it'))
      assert.ok(result.output.includes('UNVERIFIED'))
    })
  })

  describe('beads-gate', () => {
    const beadsGate = builtins['beads-gate']

    it('skips non-gated tools', () => {
      const result = beadsGate({}, {
        toolName: 'Read',
        toolInput: { file_path: 'src/app.js' },
        rootDir: '/tmp/fake',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.skipped, true)
    })

    it('skips Bash without write patterns', () => {
      const result = beadsGate({}, {
        toolName: 'Bash',
        toolInput: { command: 'git status' },
        rootDir: '/tmp/fake',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.skipped, true)
    })

    it('recognizes Edit as gated tool', () => {
      const result = beadsGate({}, {
        toolName: 'Edit',
        toolInput: { file_path: 'src/app.js' },
        rootDir: '/tmp/nonexistent-beads-repo',
        sources: null
      })
      // Not a beads repo (no .beads dir) → passes with skipped
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('not a beads repo'))
    })

    it('recognizes Write as gated tool', () => {
      const result = beadsGate({}, {
        toolName: 'Write',
        toolInput: { file_path: 'src/app.js' },
        rootDir: '/tmp/nonexistent-beads-repo',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('not a beads repo'))
    })

    it('recognizes Bash write patterns (sed -i)', () => {
      const result = beadsGate({}, {
        toolName: 'Bash',
        toolInput: { command: "sed -i '' 's/foo/bar/' file.js" },
        rootDir: '/tmp/nonexistent-beads-repo',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('not a beads repo'))
    })

    it('recognizes Bash write patterns (echo >)', () => {
      const result = beadsGate({}, {
        toolName: 'Bash',
        toolInput: { command: 'echo hello > file.txt' },
        rootDir: '/tmp/nonexistent-beads-repo',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('not a beads repo'))
    })

    it('skips files outside repo', () => {
      const result = beadsGate({}, {
        toolName: 'Edit',
        toolInput: { file_path: '/outside/src/app.js' },
        rootDir: '/some/repo',
        sources: ['src/**/*.js']
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('outside repo'))
    })

    it('skips non-source files when sources configured', () => {
      const result = beadsGate({}, {
        toolName: 'Edit',
        toolInput: { file_path: 'docs/README.md' },
        rootDir: '/some/repo',
        sources: ['src/**/*.js']
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('non-source file'))
    })

    describe('with beads repo', () => {
      let tmpDir, fakeBin, origPath

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_beads_gate_'))
        // Create .beads/config.yaml to make it look like a beads repo
        fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, '.beads', 'config.yaml'), 'version: 1\n')
        // Create a fake bd on PATH
        fakeBin = path.join(tmpDir, 'fakebin')
        fs.mkdirSync(fakeBin, { recursive: true })
        origPath = process.env.PATH
      })

      afterEach(() => {
        process.env.PATH = origPath
        fs.rmSync(tmpDir, { recursive: true, force: true })
      })

      it('denies Edit when no in_progress bead', () => {
        // Create a fake bd that outputs nothing (no in_progress beads)
        const bdScript = path.join(fakeBin, 'bd')
        fs.writeFileSync(bdScript, '#!/bin/bash\necho "No issues found"\nexit 0\n')
        fs.chmodSync(bdScript, 0o755)
        process.env.PATH = `${fakeBin}:${origPath}`

        const result = beadsGate({}, {
          toolName: 'Edit',
          toolInput: { file_path: 'src/app.js' },
          rootDir: tmpDir,
          sources: null
        })
        assert.strictEqual(result.pass, false)
        assert.ok(result.reason.includes('No bead is tracking'))
      })

      it('passes when in_progress bead exists', () => {
        // Create a fake bd that outputs an in_progress bead
        const bdScript = path.join(fakeBin, 'bd')
        fs.writeFileSync(bdScript, '#!/bin/bash\necho "beads-abc  In Progress  Fix the bug"\nexit 0\n')
        fs.chmodSync(bdScript, 0o755)
        process.env.PATH = `${fakeBin}:${origPath}`

        const result = beadsGate({}, {
          toolName: 'Edit',
          toolInput: { file_path: 'src/app.js' },
          rootDir: tmpDir,
          sources: null
        })
        assert.strictEqual(result.pass, true)
        assert.ok(result.reason.includes('bead in progress'))
      })

      it('passes (fail-open) when bd command not found', () => {
        // PATH with no bd
        process.env.PATH = fakeBin
        const result = beadsGate({}, {
          toolName: 'Edit',
          toolInput: { file_path: 'src/app.js' },
          rootDir: tmpDir,
          sources: null
        })
        assert.strictEqual(result.pass, true)
      })
    })
  })

  describe('session-baseline', () => {
    const sessionBaseline = builtins['session-baseline']

    it('passes with no session', () => {
      const result = sessionBaseline({}, { projectDir: '.', sessionId: null })
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.skipped, true)
    })
  })

  describe('exports all expected builtins', () => {
    const expectedNames = [
      'session-baseline',
      'beads-reminder',
      'config-protection',
      'beads-gate',
      'soft-stop-reminder'
    ]

    for (const name of expectedNames) {
      it(`exports ${name}`, () => {
        assert.strictEqual(typeof builtins[name], 'function', `Missing builtin: ${name}`)
      })
    }
  })
})
