const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
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

  describe('beads:require_wip', () => {
    const beadsRequireWip = builtins['beads:require_wip']

    it('skips non-gated tools', () => {
      const result = beadsRequireWip({}, {
        toolName: 'Read',
        toolInput: { file_path: 'src/app.js' },
        rootDir: '/tmp/fake',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.skipped, true)
    })

    it('skips Bash without write patterns', () => {
      const result = beadsRequireWip({}, {
        toolName: 'Bash',
        toolInput: { command: 'git status' },
        rootDir: '/tmp/fake',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.strictEqual(result.skipped, true)
    })

    it('recognizes Edit as gated tool', () => {
      const result = beadsRequireWip({}, {
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
      const result = beadsRequireWip({}, {
        toolName: 'Write',
        toolInput: { file_path: 'src/app.js' },
        rootDir: '/tmp/nonexistent-beads-repo',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('not a beads repo'))
    })

    it('recognizes Bash write patterns (sed -i)', () => {
      const result = beadsRequireWip({}, {
        toolName: 'Bash',
        toolInput: { command: "sed -i '' 's/foo/bar/' file.js" },
        rootDir: '/tmp/nonexistent-beads-repo',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('not a beads repo'))
    })

    it('recognizes Bash write patterns (echo >)', () => {
      const result = beadsRequireWip({}, {
        toolName: 'Bash',
        toolInput: { command: 'echo hello > file.txt' },
        rootDir: '/tmp/nonexistent-beads-repo',
        sources: null
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('not a beads repo'))
    })

    it('skips files outside repo', () => {
      const result = beadsRequireWip({}, {
        toolName: 'Edit',
        toolInput: { file_path: '/outside/src/app.js' },
        rootDir: '/some/repo',
        sources: ['src/**/*.js']
      })
      assert.strictEqual(result.pass, true)
      assert.ok(result.reason.includes('outside repo'))
    })

    it('skips non-source files when sources configured', () => {
      const result = beadsRequireWip({}, {
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
        fs.writeFileSync(bdScript, '#!/usr/bin/env bash\necho "No issues found"\nexit 0\n')
        fs.chmodSync(bdScript, 0o755)
        process.env.PATH = `${fakeBin}:${origPath}`

        const result = beadsRequireWip({}, {
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
        fs.writeFileSync(bdScript, '#!/usr/bin/env bash\necho "beads-abc  In Progress  Fix the bug"\nexit 0\n')
        fs.chmodSync(bdScript, 0o755)
        process.env.PATH = `${fakeBin}:${origPath}`

        const result = beadsRequireWip({}, {
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
        const result = beadsRequireWip({}, {
          toolName: 'Edit',
          toolInput: { file_path: 'src/app.js' },
          rootDir: tmpDir,
          sources: null
        })
        assert.strictEqual(result.pass, true)
      })
    })
  })

  describe('BUILTIN_PROMPTS', () => {
    const { BUILTIN_PROMPTS } = builtins

    it('has review:commit_quality prompt', () => {
      assert.strictEqual(typeof BUILTIN_PROMPTS['review:commit_quality'], 'string')
      assert.ok(BUILTIN_PROMPTS['review:commit_quality'].length > 0)
      assert.ok(BUILTIN_PROMPTS['review:commit_quality'].includes('{{staged_diff}}'),
        'commit_quality prompt should contain {{staged_diff}}')
      assert.ok(BUILTIN_PROMPTS['review:commit_quality'].includes('{{recent_commits}}'),
        'commit_quality prompt should contain {{recent_commits}}')
      assert.ok(BUILTIN_PROMPTS['review:commit_quality'].includes('{{git_status}}'),
        'commit_quality prompt should contain {{git_status}}')
    })

    it('has review:test_coverage prompt', () => {
      assert.strictEqual(typeof BUILTIN_PROMPTS['review:test_coverage'], 'string')
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].length > 0)
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].includes('{{session_diff}}'),
        'test_coverage prompt should contain {{session_diff}}')
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].includes('{{recent_commits}}'),
        'test_coverage prompt should contain {{recent_commits}}')
      assert.ok(BUILTIN_PROMPTS['review:test_coverage'].includes('{{git_status}}'),
        'test_coverage prompt should contain {{git_status}}')
    })
  })

  describe('exports all expected builtins', () => {
    const expectedFunctions = [
      'config:lock',
      'beads:require_wip'
    ]

    for (const name of expectedFunctions) {
      it(`exports ${name} as function`, () => {
        assert.strictEqual(typeof builtins[name], 'function', `Missing builtin: ${name}`)
      })
    }

    it('does not export review builtins as functions', () => {
      assert.notStrictEqual(typeof builtins['review:commit_quality'], 'function')
      assert.notStrictEqual(typeof builtins['review:test_coverage'], 'function')
    })

    it('exports BUILTIN_PROMPTS object', () => {
      assert.strictEqual(typeof builtins.BUILTIN_PROMPTS, 'object')
      assert.ok(builtins.BUILTIN_PROMPTS !== null)
    })
  })
})
