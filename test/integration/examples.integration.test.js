const { describe, it } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawnSync } = require('child_process')

const fs = require('fs')

const EXAMPLE_DIR = path.join(__dirname, '..', '..', 'example')
const EXAMPLES = ['basic', 'advanced']
const STRICT_EXAMPLES = {
  'pi-strict': {
    profile: 'pi',
    adapters: { pi: { enabled: true }, claude: { enabled: false } }
  },
  'multi-adapter': {
    profile: 'strict',
    adapters: { pi: { enabled: true }, claude: { enabled: true } }
  },
  'claude-fast-follow': {
    profile: 'claude',
    adapters: { pi: { enabled: false }, claude: { enabled: true } }
  }
}

describe('strict example configs', () => {
  for (const [name, expected] of Object.entries(STRICT_EXAMPLES)) {
    it(`${name} declares the init profile and omits legacy Claude workflow config`, () => {
      const dir = path.join(EXAMPLE_DIR, name)
      const config = JSON.parse(fs.readFileSync(path.join(dir, '.prove_it', 'config.json'), 'utf8'))

      assert.deepStrictEqual(config, {
        schema_version: 1,
        profile_version: 'prove_it.strict.v1',
        profile: expected.profile,
        adapters: expected.adapters
      })
      assert.ok(!fs.existsSync(path.join(dir, '.claude', 'prove_it', 'config.json')))
      assert.ok(!fs.existsSync(path.join(dir, '.claude', 'prove_it', 'config.local.json')))
    })
  }
})

describe('example hook dispatch', () => {
  const supportDir = path.join(EXAMPLE_DIR, 'support')
  const shimPath = path.join(supportDir, 'prove_it')
  const testBinDir = path.join(__dirname, '..', 'bin')
  const fixturesDir = path.join(__dirname, '..', 'fixtures')
  const dispatchEnv = { ...process.env, NODE_ENV: 'test', PATH: `${fixturesDir}:${testBinDir}:${process.env.PATH}`, PROVE_IT_DISABLED: '', PROVE_IT_DIR: path.join(supportDir, '_no_global'), PROVE_IT_LEGACY_CLAUDE_ORACLE: '1', PROVE_IT_TEST_LEGACY_CLAUDE_ORACLE: '1' }

  for (const name of EXAMPLES) {
    describe(name, () => {
      const dir = path.join(EXAMPLE_DIR, name)

      it('SessionStart dispatches successfully', () => {
        const result = spawnSync(shimPath, ['hook', 'claude:SessionStart'], {
          cwd: dir,
          encoding: 'utf8',
          env: dispatchEnv,
          input: JSON.stringify({ session_id: 'test-session' })
        })
        assert.strictEqual(result.status, 0,
          `SessionStart failed in ${name}/:\n${result.stderr || result.stdout}`)
      })

      it('PreToolUse dispatches successfully', () => {
        const result = spawnSync(shimPath, ['hook', 'claude:PreToolUse'], {
          cwd: dir,
          encoding: 'utf8',
          env: dispatchEnv,
          input: JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Edit',
            tool_input: { file_path: 'README.md', old_string: 'a', new_string: 'b' }
          })
        })
        assert.strictEqual(result.status, 0,
          `PreToolUse failed in ${name}/:\n${result.stderr || result.stdout}`)
        const output = JSON.parse(result.stdout)
        assert.ok(output.hookSpecificOutput, 'should have hookSpecificOutput')
      })

      it('Stop dispatches successfully', () => {
        const result = spawnSync(shimPath, ['hook', 'claude:Stop'], {
          cwd: dir,
          encoding: 'utf8',
          env: dispatchEnv,
          input: JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'test-session'
          })
        })
        assert.strictEqual(result.status, 0,
          `Stop failed in ${name}/:\n${result.stderr || result.stdout}`)
        // Stop may produce no output when all tasks skip (e.g. when conditions not met
        // due to ancestor config merge). When output exists, validate it.
        if (result.stdout && result.stdout.trim()) {
          const output = JSON.parse(result.stdout)
          assert.ok(['approve', 'block'].includes(output.decision),
            `Stop decision should be approve or block, got: ${output.decision}`)
        }
      })
    })
  }
})
