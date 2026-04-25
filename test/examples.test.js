const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const crypto = require('crypto')
const { validateConfig } = require('../lib/redesign/config')

const ROOT = path.join(__dirname, '..')
const EXAMPLE_DIR = path.join(ROOT, 'example')
const EXAMPLES = ['basic', 'advanced']
const STRICT_EXAMPLES = ['pi-strict', 'claude-fast-follow', 'multi-adapter']

function readJson (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function sha256 (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function assertNoGeneratedSessionArtifacts (dir) {
  const forbidden = []
  function walk (current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(dir, absolute).split(path.sep).join('/')
      if (/sessions\//.test(relative) || /backchannel\//.test(relative)) forbidden.push(relative)
      if (entry.isDirectory()) walk(absolute)
    }
  }
  walk(dir)
  assert.deepStrictEqual(forbidden, [], 'examples must not include generated sessions/backchannel artifacts')
}

describe('example projects', () => {
  for (const name of EXAMPLES) {
    describe(name, () => {
      const dir = path.join(EXAMPLE_DIR, name)

      it('has a valid config', () => {
        const cfgPath = path.join(dir, '.claude', 'prove_it', 'config.json')
        assert.ok(fs.existsSync(cfgPath), `${cfgPath} should exist`)
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        assert.ok(cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks), 'hooks should be an object')

        for (const hookType of Object.keys(cfg.hooks)) {
          assert.ok(['claude', 'git'].includes(hookType), `hook type "${hookType}" should be claude or git`)
          const events = cfg.hooks[hookType]
          assert.ok(events && typeof events === 'object', `hooks.${hookType} should be an object`)
          for (const event of Object.keys(events)) {
            const tasks = events[event]
            assert.ok(Array.isArray(tasks), `hooks.${hookType}.${event} should be a task array`)
            for (const check of tasks) {
              assert.ok(check.name, 'check should have a name')
              assert.ok(['script', 'agent'].includes(check.type), `check type "${check.type}" should be script or agent`)
            }
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
        const allChecks = Object.values(cfg.hooks).flatMap(events =>
          Object.values(events).flat()
        )
        const scriptChecks = allChecks.filter(c => c.type === 'script' && !c.command.includes('prove_it prefix'))

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

  describe('strict adapter examples', () => {
    for (const name of STRICT_EXAMPLES) {
      describe(name, () => {
        const dir = path.join(EXAMPLE_DIR, name)

        it('has valid strict shared .prove_it config and ownership manifest', () => {
          const cfgPath = path.join(dir, '.prove_it', 'config.json')
          const manifestPath = path.join(dir, '.prove_it', 'ownership.json')
          assert.ok(fs.existsSync(cfgPath), `${name} should have .prove_it/config.json`)
          assert.ok(fs.existsSync(manifestPath), `${name} should have .prove_it/ownership.json`)

          const cfg = readJson(cfgPath)
          assert.doesNotThrow(() => validateConfig(cfg, '.prove_it/config.json'))
          assert.ok(cfg.profile_version, 'strict examples should declare profile_version')
          assert.ok(!fs.existsSync(path.join(dir, '.claude', 'prove_it', 'config.json')), 'strict examples must not include legacy .claude/prove_it config')

          const manifest = readJson(manifestPath)
          assert.strictEqual(manifest.owner, 'prove_it')
          for (const artifact of manifest.artifacts) {
            const artifactPath = path.join(dir, ...artifact.path.split('/'))
            assert.ok(fs.existsSync(artifactPath), `${artifact.path} should exist`)
            assert.strictEqual(artifact.sha256, sha256(artifactPath), `${artifact.path} manifest hash should match`)
          }
        })

        it('documents adapter-native activation without generated runtime artifacts', () => {
          const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
          assert.match(readme, /prove_it init --adapter/)
          assert.match(readme, /clean runtime does not read legacy `\.claude\/prove_it` config/)
          assertNoGeneratedSessionArtifacts(dir)
        })
      })
    }

    it('pi-first example uses the Pi package and Pi adapter only', () => {
      const dir = path.join(EXAMPLE_DIR, 'pi-strict')
      const cfg = readJson(path.join(dir, '.prove_it', 'config.json'))
      const settings = readJson(path.join(dir, '.pi', 'settings.json'))
      assert.strictEqual(cfg.adapters.pi.enabled, true)
      assert.strictEqual(cfg.adapters.claude.enabled, false)
      assert.ok(settings.packages.includes('npm:@davemo/pi-prove-it'))
    })

    it('claude fast-follow example uses Claude-native settings without overstating strict workflow enforcement', () => {
      const dir = path.join(EXAMPLE_DIR, 'claude-fast-follow')
      const cfg = readJson(path.join(dir, '.prove_it', 'config.json'))
      const settings = readJson(path.join(dir, '.claude', 'settings.json'))
      const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
      assert.strictEqual(cfg.adapters.pi.enabled, false)
      assert.strictEqual(cfg.adapters.claude.enabled, true)
      assert.ok(settings.hooks.PreToolUse, 'Claude native PreToolUse hook should be configured')
      assert.ok(settings.hooks.Stop, 'Claude native Stop hook should be configured')
      assert.match(readme, /Claude strict clean-runtime migration is partial\/fast-follow/)
      assert.match(readme, /does not yet generally consume strict `\.prove_it\/config\.json` as its workflow source/)
      assert.match(readme, /old\/current Claude path/)
      assert.doesNotMatch(readme, /shared `\.prove_it` config is/i)
    })

    it('multi-adapter example enables Pi and Claude without implying end-to-end strict Claude workflow enforcement', () => {
      const dir = path.join(EXAMPLE_DIR, 'multi-adapter')
      const cfg = readJson(path.join(dir, '.prove_it', 'config.json'))
      const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
      assert.strictEqual(cfg.adapters.pi.enabled, true)
      assert.strictEqual(cfg.adapters.claude.enabled, true)
      assert.match(readme, /Pi is the fully wired clean-runtime adapter path today/)
      assert.match(readme, /Claude strict clean-runtime migration is partial\/fast-follow/)
      assert.match(readme, /Human review is downstream\/external/)
      assert.doesNotMatch(readme, /cross-harness reviewer/i)
      assert.doesNotMatch(readme, /workflow definition lives in `\.prove_it\/config\.json`/i)
    })
  })

  describe('adapter documentation', () => {
    it('publishes an honest capability comparison matrix and policy notes', () => {
      const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
      const adaptersDoc = fs.readFileSync(path.join(ROOT, 'docs', 'adapters.md'), 'utf8')
      const combined = `${readme}\n${adaptersDoc}`

      assert.match(combined, /methodology\/workflow engine/)
      assert.match(combined, /Pi is first-class/)
      assert.match(combined, /Pi is the fully wired clean-runtime adapter path today/)
      assert.match(combined, /@davemo\/pi-prove-it/)
      assert.match(combined, /remediation-after-turn-end|remediation after `turn_end`/)
      assert.match(combined, /Claude fast-follow/)
      assert.match(combined, /Claude strict clean-runtime migration is partial\/fast-follow/)
      assert.match(combined, /Claude dispatch does not yet generally consume strict `\.prove_it\/config\.json` as its workflow source/)
      assert.match(combined, /Current Claude hard PreToolUse\/Stop behavior exists in the old\/current Claude path/)
      assert.match(combined, /clean runtime does not read legacy `\.claude\/prove_it` config/)
      assert.match(combined, /Human review is downstream\/external/)
      assert.match(combined, /Codex.*deferred/i)
      assert.match(adaptersDoc, /\| Capability \| Pi \| Claude \|/)
      assert.match(adaptersDoc, /hard block/)
      assert.match(adaptersDoc, /remediation/)
    })
  })

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
        PreToolUse: [{ hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'prove_it hook claude:PostToolUse' }] }],
        PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'prove_it hook claude:PostToolUseFailure' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }] }],
        TaskCompleted: [{ hooks: [{ type: 'command', command: 'prove_it hook claude:TaskCompleted' }] }]
      }

      const settingsPath = path.join(supportDir, 'settings.json')
      const actual = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks

      // Compare structure: same events, same matchers, same hook shape.
      // Command prefix differs (../support/prove_it vs prove_it)—normalize it.
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
      const allChecks = Object.values(cfg.hooks).flatMap(events =>
        Object.values(events).flat()
      )
      const agentChecks = allChecks.filter(c => c.type === 'agent')
      assert.ok(agentChecks.length > 0, 'Should have agent checks')
      for (const check of agentChecks) {
        assert.ok(check.prompt.includes('calculator') || check.prompt.includes('Calculator'),
          `Agent check "${check.name}" should have domain-specific prompt mentioning calculator`)
      }
    })
  })
})
