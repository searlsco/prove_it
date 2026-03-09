const { describe, it } = require('node:test')
const assert = require('node:assert')

const { runUpgradeSteps } = require('../lib/upgrade')

describe('cmdUpgrade', () => {
  function makeRunner (results) {
    const calls = []
    const run = (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      const key = `${cmd} ${args[0]}`
      return results[key] !== false
    }
    return { run, calls }
  }

  it('calls brew upgrade, prove_it install in order (no project)', () => {
    const { run, calls } = makeRunner({})
    const logs = []

    const result = runUpgradeSteps({
      run,
      cwd: '/no-project',
      homeDir: '/home',
      findProject: () => null,
      log: (msg) => logs.push(msg)
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0].cmd, 'brew')
    assert.deepStrictEqual(calls[0].args, ['upgrade', 'searlsco/tap/prove_it'])
    assert.strictEqual(calls[1].cmd, 'prove_it')
    assert.deepStrictEqual(calls[1].args, ['install'])
    assert.ok(logs.some(m => m.includes('Upgrade complete')))
  })

  it('calls prove_it init when project config is found', () => {
    const { run, calls } = makeRunner({})
    const logs = []

    const result = runUpgradeSteps({
      run,
      cwd: '/project',
      homeDir: '/home',
      findProject: () => '/project',
      log: (msg) => logs.push(msg)
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(calls.length, 3)
    assert.strictEqual(calls[2].cmd, 'prove_it')
    assert.deepStrictEqual(calls[2].args, ['init'])
    assert.deepStrictEqual(calls[2].opts, { cwd: '/project' })
    assert.ok(logs.some(m => m.includes('Reinitializing project')))
  })

  it('finds project config in ancestor directory', () => {
    const { run, calls } = makeRunner({})

    const result = runUpgradeSteps({
      run,
      cwd: '/project/src/lib',
      homeDir: '/home',
      findProject: () => '/project',
      log: () => {}
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(calls.length, 3)
    assert.deepStrictEqual(calls[2].opts, { cwd: '/project' })
  })

  it('stops and returns error on brew upgrade failure', () => {
    const { run, calls } = makeRunner({ 'brew upgrade': false })

    const result = runUpgradeSteps({
      run,
      cwd: '/work',
      homeDir: '/home',
      findProject: () => null,
      log: () => {}
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.error, 'brew upgrade failed')
    assert.strictEqual(calls.length, 1, 'should only call brew upgrade')
  })

  it('stops and returns error on prove_it install failure', () => {
    const { run, calls } = makeRunner({ 'prove_it install': false })

    const result = runUpgradeSteps({
      run,
      cwd: '/work',
      homeDir: '/home',
      findProject: () => null,
      log: () => {}
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.error, 'prove_it install failed')
    assert.strictEqual(calls.length, 2, 'should call brew upgrade and prove_it install')
  })

  it('skips prove_it init when no project config exists', () => {
    const { run, calls } = makeRunner({})
    const logs = []

    const result = runUpgradeSteps({
      run,
      cwd: '/no-config',
      homeDir: '/home',
      findProject: () => null,
      log: (msg) => logs.push(msg)
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(calls.length, 2, 'should not call prove_it init')
    assert.ok(!logs.some(m => m.includes('Reinitializing')))
  })

  it('skips prove_it init when project dir equals home dir', () => {
    const { run, calls } = makeRunner({})

    const result = runUpgradeSteps({
      run,
      cwd: '/home',
      homeDir: '/home',
      findProject: () => '/home',
      log: () => {}
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(calls.length, 2, 'should not call prove_it init for home dir')
  })
})
