const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const EXAMPLE_DIR = path.join(__dirname, '..', 'example')
const EXAMPLES = ['basic', 'advanced']

describe('example projects', () => {
  for (const name of EXAMPLES) {
    describe(name, () => {
      const dir = path.join(EXAMPLE_DIR, name)

      it('has a valid config', () => {
        const cfgPath = path.join(dir, '.claude', 'prove_it', 'config.json')
        assert.ok(fs.existsSync(cfgPath), `${cfgPath} should exist`)
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        assert.ok(Array.isArray(cfg.hooks), 'hooks should be an array')
        assert.ok(cfg.hooks.length > 0, 'hooks should not be empty')

        for (const hook of cfg.hooks) {
          assert.ok(['claude', 'git'].includes(hook.type), `hook type "${hook.type}" should be claude or git`)
          assert.ok(hook.event, 'hook should have an event')
          assert.ok(Array.isArray(hook.tasks), 'hook should have tasks array')
          for (const check of hook.tasks) {
            assert.ok(check.name, 'check should have a name')
            assert.ok(['script', 'agent'].includes(check.type), `check type "${check.type}" should be script or agent`)
          }
        }
      })

      it('has executable script/test', () => {
        const scriptPath = path.join(dir, 'script', 'test')
        assert.ok(fs.existsSync(scriptPath), 'script/test should exist')
        const stat = fs.statSync(scriptPath)
        assert.ok(stat.mode & fs.constants.S_IXUSR, 'script/test should be executable')
      })

      it('has executable script/test_fast', () => {
        const scriptPath = path.join(dir, 'script', 'test_fast')
        assert.ok(fs.existsSync(scriptPath), 'script/test_fast should exist')
        const stat = fs.statSync(scriptPath)
        assert.ok(stat.mode & fs.constants.S_IXUSR, 'script/test_fast should be executable')
      })

      it('script/test passes', () => {
        const result = spawnSync(path.join(dir, 'script', 'test'), {
          cwd: dir,
          encoding: 'utf8',
          timeout: 10000
        })
        assert.strictEqual(result.status, 0,
          `script/test failed:\n${result.stderr || result.stdout}`)
      })

      it('has a README.md', () => {
        assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'README.md should exist')
      })

      it('references scripts that exist in config', () => {
        const cfgPath = path.join(dir, '.claude', 'prove_it', 'config.json')
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        const allChecks = cfg.hooks.flatMap(h => h.tasks || [])
        const scriptChecks = allChecks.filter(c => c.type === 'script' && !c.command.startsWith('prove_it '))

        for (const check of scriptChecks) {
          const scriptPath = path.join(dir, check.command)
          assert.ok(fs.existsSync(scriptPath),
            `Script "${check.command}" referenced by check "${check.name}" should exist`)
          const stat = fs.statSync(scriptPath)
          assert.ok(stat.mode & fs.constants.S_IXUSR,
            `Script "${check.command}" should be executable`)
        }
      })
    })
  }

  describe('support infrastructure', () => {
    const supportDir = path.join(EXAMPLE_DIR, 'support')
    const shimPath = path.join(supportDir, 'prove_it')
    it('example/support/prove_it exists and is executable', () => {
      assert.ok(fs.existsSync(shimPath), 'example/support/prove_it should exist')
      const stat = fs.statSync(shimPath)
      assert.ok(stat.mode & fs.constants.S_IXUSR, 'shim should be executable')
    })

    it('test/bin/prove_it exists and is executable', () => {
      const devShim = path.join(__dirname, 'bin', 'prove_it')
      assert.ok(fs.existsSync(devShim), 'test/bin/prove_it should exist')
      const stat = fs.statSync(devShim)
      assert.ok(stat.mode & fs.constants.S_IXUSR, 'shim should be executable')
    })

    it('settings.json matches what prove_it install would generate', () => {
      // Source of truth: the hook groups that cmdInstall registers.
      // If install adds/changes events or matchers, this test fails.
      const expected = {
        SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }] }],
        PreToolUse: [{ matcher: 'Edit|Write|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }] }]
      }

      const settingsPath = path.join(supportDir, 'settings.json')
      const actual = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks

      // Compare structure: same events, same matchers, same hook shape.
      // Command prefix differs (../support/prove_it vs prove_it) — normalize it.
      const normalize = (hooks) => JSON.parse(
        JSON.stringify(hooks).replace(/\.\.\/support\/prove_it /g, 'prove_it ')
      )
      assert.deepStrictEqual(normalize(actual), expected,
        'example settings.json structure must match prove_it install output.\n' +
        'If you changed cmdInstall, update example/support/settings.json too.')
    })

    for (const name of EXAMPLES) {
      it(`${name}/.claude/settings.json is a symlink to support/settings.json`, () => {
        const settingsPath = path.join(EXAMPLE_DIR, name, '.claude', 'settings.json')
        assert.ok(fs.existsSync(settingsPath), `${name} settings.json should exist`)
        const stat = fs.lstatSync(settingsPath)
        assert.ok(stat.isSymbolicLink(), `${name} settings.json should be a symlink`)
        const target = fs.readlinkSync(settingsPath)
        assert.strictEqual(target, '../../support/settings.json')
      })
    }
  })

  describe('advanced-specific', () => {
    it('has executable lint script', () => {
      const lintPath = path.join(EXAMPLE_DIR, 'advanced', 'script', 'lint.sh')
      assert.ok(fs.existsSync(lintPath), 'script/lint.sh should exist')
      const stat = fs.statSync(lintPath)
      assert.ok(stat.mode & fs.constants.S_IXUSR, 'script/lint.sh should be executable')
    })

    it('lint script passes', () => {
      const result = spawnSync(path.join(EXAMPLE_DIR, 'advanced', 'script', 'lint.sh'), {
        cwd: path.join(EXAMPLE_DIR, 'advanced'),
        encoding: 'utf8',
        timeout: 5000
      })
      assert.strictEqual(result.status, 0,
        `lint.sh failed:\n${result.stderr || result.stdout}`)
    })

    it('has custom agent prompts', () => {
      const cfgPath = path.join(EXAMPLE_DIR, 'advanced', '.claude', 'prove_it', 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      const allChecks = cfg.hooks.flatMap(h => h.tasks || [])
      const agentChecks = allChecks.filter(c => c.type === 'agent')
      assert.ok(agentChecks.length > 0, 'Should have agent checks')
      for (const check of agentChecks) {
        assert.ok(check.prompt.includes('calculator') || check.prompt.includes('Calculator'),
          `Agent check "${check.name}" should have domain-specific prompt mentioning calculator`)
      }
    })
  })
})
