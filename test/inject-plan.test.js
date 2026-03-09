const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

describe('libexec/inject-plan', () => {
  let tmpDir
  let origHome
  const scriptPath = path.join(__dirname, '..', 'libexec', 'inject-plan')

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_inject_plan_'))
    origHome = process.env.HOME
    process.env.HOME = tmpDir
    fs.mkdirSync(path.join(tmpDir, '.claude', 'plans'), { recursive: true })
  })

  afterEach(() => {
    process.env.HOME = origHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('injects block after title when position is after-title', () => {
    const planPath = path.join(tmpDir, '.claude', 'plans', 'plan1.md')
    const planText = '# My Plan\n\n## 1. Build feature\n\nDo stuff.\n'
    fs.writeFileSync(planPath, planText)

    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({
        tool_input: { plan: planText },
        params: {
          position: 'after-title',
          marker: 'CUSTOM_MARKER',
          block: '## Custom Section\n\nCustom content here.\n'
        }
      }),
      encoding: 'utf8',
      env: { ...process.env }
    })

    assert.strictEqual(result.status, 0)
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(content.includes('Custom Section'), 'Should contain injected block')
    assert.ok(content.indexOf('Custom Section') < content.indexOf('Build feature'),
      'Injected block should appear before first step')
  })

  it('injects block before verification section', () => {
    const planPath = path.join(tmpDir, '.claude', 'plans', 'plan1.md')
    const planText = '# My Plan\n\n## 1. Build\n\n## Verification\n\n1. Test it.\n'
    fs.writeFileSync(planPath, planText)

    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({
        tool_input: { plan: planText },
        params: {
          position: 'before-verification',
          marker: 'CUSTOM_MARKER',
          block: '## 2. Signal\n\nDo the thing.\n'
        }
      }),
      encoding: 'utf8',
      env: { ...process.env }
    })

    assert.strictEqual(result.status, 0)
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(content.indexOf('Signal') < content.indexOf('Verification'),
      'Injected block should appear before Verification')
  })

  it('is idempotent — skips when marker already present', () => {
    const planPath = path.join(tmpDir, '.claude', 'plans', 'plan1.md')
    const planText = '# My Plan\n\nALREADY_HERE\n\n## 1. Build\n'
    fs.writeFileSync(planPath, planText)

    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({
        tool_input: { plan: planText },
        params: {
          position: 'after-title',
          marker: 'ALREADY_HERE',
          block: '## Should Not Appear\n\nNope.\n'
        }
      }),
      encoding: 'utf8',
      env: { ...process.env }
    })

    assert.strictEqual(result.status, 0)
    const content = fs.readFileSync(planPath, 'utf8')
    assert.ok(!content.includes('Should Not Appear'),
      'Should not inject when marker already present')
  })

  it('exits 0 with no output when plan file not found', () => {
    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({
        tool_input: { plan: 'nonexistent plan text' },
        params: {
          position: 'after-title',
          marker: 'X',
          block: '## X\n'
        }
      }),
      encoding: 'utf8',
      env: { ...process.env }
    })

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stdout, '')
  })

  it('exits 0 when plan text is empty', () => {
    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({
        tool_input: { plan: '' },
        params: {
          position: 'after-title',
          marker: 'X',
          block: '## X\n'
        }
      }),
      encoding: 'utf8',
      env: { ...process.env }
    })

    assert.strictEqual(result.status, 0)
  })

  it('exits 0 when params are missing', () => {
    const result = spawnSync('node', [scriptPath], {
      input: JSON.stringify({
        tool_input: { plan: 'some plan' }
      }),
      encoding: 'utf8',
      env: { ...process.env }
    })

    assert.strictEqual(result.status, 0)
  })
})
