const { describe, it } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawnSync } = require('child_process')

const EXAMPLE_DIR = path.join(__dirname, '..', '..', 'example')
const EXAMPLES = ['basic', 'advanced']

describe('example hook dispatch', () => {
  const supportDir = path.join(EXAMPLE_DIR, 'support')
  const shimPath = path.join(supportDir, 'prove_it')
  const testBinDir = path.join(__dirname, '..', 'bin')
  const fixturesDir = path.join(__dirname, '..', 'fixtures')
  const dispatchEnv = { ...process.env, PATH: `${fixturesDir}:${testBinDir}:${process.env.PATH}`, PROVE_IT_DISABLED: '' }

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
        const output = JSON.parse(result.stdout)
        assert.ok(['approve', 'block'].includes(output.decision),
          `Stop decision should be approve or block, got: ${output.decision}`)
      })
    })
  }
})
