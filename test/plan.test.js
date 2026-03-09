const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  detectLastNumberedHeading,
  buildSignalBlock,
  findPlanFile,
  appendPlanBlock
} = require('../lib/plan')

describe('detectLastNumberedHeading', () => {
  it('detects ## N. pattern', () => {
    const result = detectLastNumberedHeading('## 1. Setup\n\n## 2. Implementation\n')
    assert.deepStrictEqual(result, { level: 2, number: 2 })
  })

  it('detects ### N: pattern', () => {
    const result = detectLastNumberedHeading('### 1: First\n### 2: Second\n### 3: Third\n')
    assert.deepStrictEqual(result, { level: 3, number: 3 })
  })

  it('detects ## Step N: pattern', () => {
    const result = detectLastNumberedHeading('## Step 1: Setup\n## Step 2: Build\n')
    assert.deepStrictEqual(result, { level: 2, number: 2 })
  })

  it('returns null for content without numbered headings', () => {
    assert.strictEqual(detectLastNumberedHeading('## Setup\n\nSome text\n'), null)
  })
})

describe('buildSignalBlock', () => {
  it('builds block at level 2 with step number', () => {
    const block = buildSignalBlock(2, 3)
    assert.ok(block.includes('## 3. Run `prove_it signal done`'))
    assert.ok(block.includes('prove_it signal done'))
  })

  it('omits step number when stepNum < 2', () => {
    const block = buildSignalBlock(2, 1)
    assert.ok(block.includes('## Run `prove_it signal done`'))
    assert.ok(!block.includes('## 1.'))
  })
})

describe('findPlanFile', () => {
  let tmpDir
  let origHome

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_plan_'))
    origHome = process.env.HOME
    process.env.HOME = tmpDir
    fs.mkdirSync(path.join(tmpDir, '.claude', 'plans'), { recursive: true })
  })

  afterEach(() => {
    process.env.HOME = origHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds plan file containing the given text', () => {
    const planPath = path.join(tmpDir, '.claude', 'plans', 'plan1.md')
    fs.writeFileSync(planPath, '# My Plan\n\n## 1. Build feature\n')
    const result = findPlanFile('Build feature')
    assert.strictEqual(result, planPath)
  })

  it('returns null when no plan matches', () => {
    const planPath = path.join(tmpDir, '.claude', 'plans', 'plan1.md')
    fs.writeFileSync(planPath, '# Unrelated plan\n')
    assert.strictEqual(findPlanFile('nonexistent text'), null)
  })

  it('returns null when plans dir does not exist', () => {
    fs.rmSync(path.join(tmpDir, '.claude', 'plans'), { recursive: true })
    assert.strictEqual(findPlanFile('anything'), null)
  })
})

describe('appendPlanBlock', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_plan_'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('inserts after title', () => {
    const filePath = path.join(tmpDir, 'plan.md')
    fs.writeFileSync(filePath, '# My Plan\n\n## 1. First step\n\nDo stuff.\n')
    appendPlanBlock(filePath, {
      marker: 'TEST_MARKER',
      block: '## Test block\n\nContent here.\n',
      position: 'after-title'
    })
    const content = fs.readFileSync(filePath, 'utf8')
    assert.ok(content.indexOf('Test block') < content.indexOf('First step'),
      'Block should appear before first step')
  })

  it('inserts before verification', () => {
    const filePath = path.join(tmpDir, 'plan.md')
    fs.writeFileSync(filePath, '# My Plan\n\n## 1. Build\n\n## Verification\n\n1. Test it.\n')
    appendPlanBlock(filePath, {
      marker: 'TEST_MARKER',
      block: '## 2. Signal\n\nDo the thing.\n',
      position: 'before-verification'
    })
    const content = fs.readFileSync(filePath, 'utf8')
    assert.ok(content.indexOf('Signal') < content.indexOf('Verification'),
      'Block should appear before Verification')
  })

  it('is idempotent (skips when marker already present)', () => {
    const filePath = path.join(tmpDir, 'plan.md')
    fs.writeFileSync(filePath, '# My Plan\n\nTEST_MARKER\n\n## 1. Build\n')
    appendPlanBlock(filePath, {
      marker: 'TEST_MARKER',
      block: '## New block\n',
      position: 'after-title'
    })
    const content = fs.readFileSync(filePath, 'utf8')
    assert.ok(!content.includes('New block'), 'Should not insert when marker already present')
  })

  it('appends to end when no verification section and position is before-verification', () => {
    const filePath = path.join(tmpDir, 'plan.md')
    fs.writeFileSync(filePath, '# My Plan\n\n## 1. Build\n\nStuff.\n')
    appendPlanBlock(filePath, {
      marker: 'TEST_MARKER',
      block: '## 2. Signal\n\nDo the thing.\n',
      position: 'before-verification'
    })
    const content = fs.readFileSync(filePath, 'utf8')
    assert.ok(content.endsWith('Do the thing.\n'), 'Block should be appended at end')
  })
})
