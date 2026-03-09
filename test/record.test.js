const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { saveRunData, loadRunData } = require('../lib/testing')

describe('record command', () => {
  let tmpDir
  let localCfgPath

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_record_'))
    fs.mkdirSync(path.join(tmpDir, '.claude', 'prove_it'), { recursive: true })
    localCfgPath = path.join(tmpDir, '.claude', 'prove_it', 'config.local.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records a pass', () => {
    saveRunData(localCfgPath, 'foo', { at: Date.now(), result: 'pass' })

    const runs = loadRunData(localCfgPath)
    assert.strictEqual(runs.foo.result, 'pass')
    assert.ok(typeof runs.foo.at === 'number')
  })

  it('records a fail', () => {
    saveRunData(localCfgPath, 'foo', { at: Date.now(), result: 'fail' })

    const runs = loadRunData(localCfgPath)
    assert.strictEqual(runs.foo.result, 'fail')
  })

  it('sanitizes name with same regex as cli.js', () => {
    const runKey = 'my check!@#'.replace(/[^a-zA-Z0-9_-]/g, '_')
    saveRunData(localCfgPath, runKey, { at: Date.now(), result: 'pass' })

    const runs = loadRunData(localCfgPath)
    assert.ok(runs.my_check___, 'name should be sanitized')
  })

  describe('--result semantics', () => {
    it('result code 0 means pass', () => {
      const resultCode = 0
      const result = resultCode === 0 ? 'pass' : 'fail'
      saveRunData(localCfgPath, 'foo', { at: Date.now(), result })

      assert.strictEqual(loadRunData(localCfgPath).foo.result, 'pass')
    })

    it('result code 1 means fail', () => {
      const resultCode = 1
      const result = resultCode === 0 ? 'pass' : 'fail'
      saveRunData(localCfgPath, 'foo', { at: Date.now(), result })

      assert.strictEqual(loadRunData(localCfgPath).foo.result, 'fail')
    })

    it('result code 42 means fail', () => {
      const resultCode = 42
      const result = resultCode === 0 ? 'pass' : 'fail'
      saveRunData(localCfgPath, 'foo', { at: Date.now(), result })

      assert.strictEqual(loadRunData(localCfgPath).foo.result, 'fail')
    })
  })

  it('preserves existing local config data', () => {
    fs.writeFileSync(localCfgPath, JSON.stringify({ runs: { existing: { at: 1, pass: true } } }))

    saveRunData(localCfgPath, 'new-check', { at: Date.now(), result: 'pass' })

    const data = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'))
    assert.strictEqual(data.runs.existing.pass, true, 'existing run data preserved')
    assert.strictEqual(data.runs['new-check'].result, 'pass', 'new run data added')
  })
})
