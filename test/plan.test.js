const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  detectLastNumberedHeading,
  detectPlanPhase,
  buildSignalBlock,
  buildPhaseBlock,
  findPlanFile,
  appendPlanBlock,
  PHASE_PLAN_MARKER
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
    assert.ok(block.includes('$ prove_it signal done'),
      'Signal block should have $ prefix on the command')
  })

  it('omits step number when stepNum < 2', () => {
    const block = buildSignalBlock(2, 1)
    assert.ok(block.includes('## Run `prove_it signal done`'))
    assert.ok(!block.includes('## 1.'))
  })

  it('does not include prove_it phase implement instruction', () => {
    const block = buildSignalBlock(2, 3)
    assert.ok(!block.includes('prove_it phase implement'),
      'Signal block should NOT contain phase implement (moved to buildPhaseBlock)')
  })
})

describe('PHASE_PLAN_MARKER', () => {
  it('matches both implement and refactor phase commands', () => {
    assert.ok('prove_it phase implement'.includes(PHASE_PLAN_MARKER),
      'Marker should match implement variant')
    assert.ok('prove_it phase refactor'.includes(PHASE_PLAN_MARKER),
      'Marker should match refactor variant')
  })
})

describe('buildPhaseBlock', () => {
  it('defaults to implement phase', () => {
    const block = buildPhaseBlock()
    assert.ok(block.includes('$ prove_it phase implement'),
      'Phase block should contain the phase implement command with $ prefix')
    assert.ok(block.includes('## Enter implementation phase'),
      'Phase block should have implementation heading')
  })

  it('uses implement phase when explicitly passed', () => {
    const block = buildPhaseBlock('implement')
    assert.ok(block.includes('$ prove_it phase implement'))
    assert.ok(block.includes('## Enter implementation phase'))
  })

  it('uses refactor phase when passed', () => {
    const block = buildPhaseBlock('refactor')
    assert.ok(block.includes('$ prove_it phase refactor'),
      'Phase block should contain the phase refactor command')
    assert.ok(block.includes('## Enter refactor phase'),
      'Phase block should have refactor heading')
    assert.ok(!block.includes('implement'),
      'Refactor block should not mention implement')
  })

  it('uses MUST wording for implement', () => {
    const block = buildPhaseBlock('implement')
    assert.ok(block.includes('you MUST run this command'),
      'Phase block should use mandatory language')
  })

  it('uses MUST wording for refactor', () => {
    const block = buildPhaseBlock('refactor')
    assert.ok(block.includes('you MUST run this command'),
      'Phase block should use mandatory language')
  })
})

describe('detectPlanPhase', () => {
  it('returns implement for a normal plan', () => {
    const content = '# Add user authentication\n\n## 1. Create user model\n\n## 2. Add login endpoint\n'
    assert.strictEqual(detectPlanPhase(content), 'implement')
  })

  it('detects refactor from title', () => {
    const content = '# Refactor authentication module\n\n## 1. Extract interface\n\n## 2. Move logic\n'
    assert.strictEqual(detectPlanPhase(content), 'refactor')
  })

  it('detects refactor from title case-insensitively', () => {
    const content = '# REFACTOR the auth layer\n\n## 1. Step one\n'
    assert.strictEqual(detectPlanPhase(content), 'refactor')
  })

  it('detects refactor from prominent heading', () => {
    const content = '# Clean up auth module\n\n## Refactoring approach\n\n## 1. Extract class\n'
    assert.strictEqual(detectPlanPhase(content), 'refactor')
  })

  it('detects refactor from phrase "no behavior change"', () => {
    const content = '# Restructure config loading\n\nThis is a no behavior change restructuring.\n\n## 1. Move files\n'
    assert.strictEqual(detectPlanPhase(content), 'refactor')
  })

  it('detects refactor from phrase "preserve existing behavior"', () => {
    const content = '# Update module structure\n\nGoal: preserve existing behavior while reorganizing.\n\n## 1. Rename\n'
    assert.strictEqual(detectPlanPhase(content), 'refactor')
  })

  it('detects refactor from phrase "refactor mode"', () => {
    const content = '# Clean up dispatcher\n\nRefactor mode — reorganize without changing behavior.\n\n## 1. Split\n'
    assert.strictEqual(detectPlanPhase(content), 'refactor')
  })

  it('ignores refactor mentions deep in the plan body', () => {
    const content = '# Add new feature\n\n## 1. Build it\n\nDo stuff.\n\n' +
      Array(30).fill('Line of detail.\n').join('') +
      '## 15. Later we might refactor this\n'
    assert.strictEqual(detectPlanPhase(content), 'implement')
  })

  it('returns implement for empty content', () => {
    assert.strictEqual(detectPlanPhase(''), 'implement')
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

  it('before-steps inserts before first numbered heading (## N.)', () => {
    const filePath = path.join(tmpDir, 'plan.md')
    fs.writeFileSync(filePath, '# My Plan\n\n## Context\n\nSome context.\n\n## 1. Build\n\nDo stuff.\n')
    appendPlanBlock(filePath, {
      marker: 'TEST_MARKER',
      block: '## Development approach\n\nTDD content.\n',
      position: 'before-steps'
    })
    const content = fs.readFileSync(filePath, 'utf8')
    assert.ok(content.indexOf('Development approach') < content.indexOf('## 1. Build'),
      'Block should appear before first numbered heading')
    assert.ok(content.indexOf('Some context.') < content.indexOf('Development approach'),
      'Block should appear after context')
  })

  it('before-steps inserts before ### N: style headings', () => {
    const filePath = path.join(tmpDir, 'plan.md')
    fs.writeFileSync(filePath, '# My Plan\n\n### 1: First task\n\n### 2: Second task\n')
    appendPlanBlock(filePath, {
      marker: 'TEST_MARKER',
      block: '## Dev approach\n\nContent.\n',
      position: 'before-steps'
    })
    const content = fs.readFileSync(filePath, 'utf8')
    assert.ok(content.indexOf('Dev approach') < content.indexOf('### 1: First task'),
      'Block should appear before ### N: heading')
  })

  it('before-steps falls back to before-verification when no numbered headings', () => {
    const filePath = path.join(tmpDir, 'plan.md')
    fs.writeFileSync(filePath, '# My Plan\n\n## Overview\n\nStuff.\n\n## Verification\n\n1. Test it.\n')
    appendPlanBlock(filePath, {
      marker: 'TEST_MARKER',
      block: '## Dev approach\n\nContent.\n',
      position: 'before-steps'
    })
    const content = fs.readFileSync(filePath, 'utf8')
    assert.ok(content.indexOf('Dev approach') < content.indexOf('Verification'),
      'Block should appear before Verification when no numbered headings')
  })

  it('before-steps falls back to end-of-file when no numbered headings and no verification', () => {
    const filePath = path.join(tmpDir, 'plan.md')
    fs.writeFileSync(filePath, '# My Plan\n\n## Overview\n\nStuff.\n')
    appendPlanBlock(filePath, {
      marker: 'TEST_MARKER',
      block: '## Dev approach\n\nContent.\n',
      position: 'before-steps'
    })
    const content = fs.readFileSync(filePath, 'utf8')
    assert.ok(content.endsWith('Content.\n'), 'Block should be appended at end')
  })
})
