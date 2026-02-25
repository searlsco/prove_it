const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { askConflict, resetState, isHelpShown } = require('../lib/conflict')

// Create a readline interface that feeds answers from an array
function mockRl (answers) {
  const answersCopy = [...answers]
  return {
    question (prompt, cb) {
      const answer = answersCopy.shift()
      if (answer === undefined) throw new Error('No more answers')
      cb(answer)
    },
    close () {}
  }
}

// Collect log output
function captureLog () {
  const lines = []
  return {
    log (...args) { lines.push(args.join(' ')) },
    lines
  }
}

// Mock spawnSync that returns configurable results
function mockSpawnSync (results) {
  const calls = []
  return {
    fn (cmd, args, opts) {
      calls.push({ cmd, args, opts })
      const key = cmd + (args?.[0] ? ':' + args[0] : '')
      const result = results[key] || results[cmd] || { status: 0, stdout: '', stderr: '' }
      return typeof result === 'function' ? result(cmd, args, opts) : result
    },
    calls
  }
}

describe('askConflict', () => {
  let tmpDir
  let existingPath

  beforeEach(() => {
    resetState()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-test-'))
    existingPath = path.join(tmpDir, 'test.md')
    fs.writeFileSync(existingPath, 'existing content\n')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const baseOpts = () => ({
    label: 'test.md',
    existingPath,
    existing: 'existing content\n',
    proposed: 'proposed content\n',
    defaultYes: true
  })

  describe('basic answers', () => {
    it('y resolves to yes with proposed content', async () => {
      const rl = mockRl(['y'])
      const { log } = captureLog()
      const result = await askConflict(rl, { ...baseOpts(), _log: log })
      assert.strictEqual(result.answer, 'yes')
      assert.strictEqual(result.content, 'proposed content\n')
    })

    it('Y resolves to yes', async () => {
      const rl = mockRl(['Y'])
      const { log } = captureLog()
      const result = await askConflict(rl, { ...baseOpts(), _log: log })
      assert.strictEqual(result.answer, 'yes')
    })

    it('empty input with defaultYes=true resolves to yes', async () => {
      const rl = mockRl([''])
      const { log } = captureLog()
      const result = await askConflict(rl, { ...baseOpts(), defaultYes: true, _log: log })
      assert.strictEqual(result.answer, 'yes')
    })

    it('empty input with defaultYes=false resolves to no', async () => {
      const rl = mockRl([''])
      const { log } = captureLog()
      const result = await askConflict(rl, { ...baseOpts(), defaultYes: false, _log: log })
      assert.strictEqual(result.answer, 'no')
    })

    it('n resolves to no', async () => {
      const rl = mockRl(['n'])
      const { log } = captureLog()
      const result = await askConflict(rl, { ...baseOpts(), _log: log })
      assert.strictEqual(result.answer, 'no')
    })

    it('q resolves to quit', async () => {
      const rl = mockRl(['q'])
      const { log } = captureLog()
      const result = await askConflict(rl, { ...baseOpts(), _log: log })
      assert.strictEqual(result.answer, 'quit')
    })
  })

  describe('help display', () => {
    it('shows help table on first call', async () => {
      const capture = captureLog()
      const rl = mockRl(['y'])
      await askConflict(rl, { ...baseOpts(), _log: capture.log })
      assert.ok(isHelpShown())
      assert.ok(capture.lines.some(l => l.includes('File conflict options:')))
    })

    it('does not repeat help table on second call', async () => {
      const capture1 = captureLog()
      const rl1 = mockRl(['y'])
      await askConflict(rl1, { ...baseOpts(), _log: capture1.log })

      const capture2 = captureLog()
      const rl2 = mockRl(['y'])
      await askConflict(rl2, { ...baseOpts(), _log: capture2.log })
      assert.ok(!capture2.lines.some(l => l.includes('File conflict options:')))
    })

    it('? shows help and re-prompts', async () => {
      const capture = captureLog()
      const rl = mockRl(['?', 'y'])
      const result = await askConflict(rl, { ...baseOpts(), _log: capture.log })
      assert.strictEqual(result.answer, 'yes')
      // help shown twice: auto on first call, and again for ?
      const helpCount = capture.lines.filter(l => l.includes('yes, overwrite')).length
      assert.strictEqual(helpCount, 2)
    })

    it('h shows help and re-prompts', async () => {
      const capture = captureLog()
      const rl = mockRl(['h', 'n'])
      const result = await askConflict(rl, { ...baseOpts(), _log: capture.log })
      assert.strictEqual(result.answer, 'no')
    })

    it('/ shows help and re-prompts', async () => {
      const capture = captureLog()
      const rl = mockRl(['/', 'n'])
      const result = await askConflict(rl, { ...baseOpts(), _log: capture.log })
      assert.strictEqual(result.answer, 'no')
    })

    it('unknown key shows help and re-prompts', async () => {
      const capture = captureLog()
      const rl = mockRl(['x', 'y'])
      const result = await askConflict(rl, { ...baseOpts(), _log: capture.log })
      assert.strictEqual(result.answer, 'yes')
    })
  })

  describe('diff (d)', () => {
    it('shows diff then re-prompts', async () => {
      const capture = captureLog()
      const spawn = mockSpawnSync({
        diff: { status: 1, stdout: '--- a\n+++ b\n-old\n+new\n', stderr: '' }
      })
      const rl = mockRl(['d', 'y'])
      const result = await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log,
        _spawnSync: spawn.fn
      })
      assert.strictEqual(result.answer, 'yes')
      assert.strictEqual(spawn.calls.length, 1)
      assert.strictEqual(spawn.calls[0].cmd, 'diff')
      assert.ok(capture.lines.some(l => l.includes('-old')))
    })

    it('shows (no differences) when diff output is empty', async () => {
      const capture = captureLog()
      const spawn = mockSpawnSync({
        diff: { status: 0, stdout: '', stderr: '' }
      })
      const rl = mockRl(['d', 'n'])
      await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log,
        _spawnSync: spawn.fn
      })
      assert.ok(capture.lines.some(l => l.includes('(no differences)')))
    })
  })

  describe('agent merge (a)', () => {
    it('successful merge returns merged content when accepted', async () => {
      const capture = captureLog()
      const mergedContent = 'merged content\n'
      const spawn = mockSpawnSync({
        claude: { status: 0, stdout: mergedContent, stderr: '' },
        diff: { status: 1, stdout: '--- a\n+++ b\n-existing\n+merged\n', stderr: '' }
      })
      const rl = mockRl(['a', 'y'])
      const result = await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log,
        _spawnSync: spawn.fn
      })
      assert.strictEqual(result.answer, 'yes')
      assert.strictEqual(result.content, mergedContent.trim(),
        'content should be the agent-merged result, not the original proposed')
      assert.ok(capture.lines.some(l => l.includes('Agent merge result')))
      assert.ok(spawn.calls.some(c => c.cmd === 'claude'))
    })

    it('MERGE_FAILED falls through to manual merge and resolves no', async () => {
      const capture = captureLog()
      const spawn = mockSpawnSync({
        claude: { status: 0, stdout: 'MERGE_FAILED', stderr: '' }
      })
      const rl = mockRl(['a'])
      const result = await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log,
        _spawnSync: spawn.fn
      })
      assert.strictEqual(result.answer, 'no')
      assert.ok(capture.lines.some(l => l.includes('Agent merge failed')))
      assert.ok(capture.lines.some(l => l.includes('Manual merge:')))
    })

    it('non-zero exit falls through to manual merge', async () => {
      const capture = captureLog()
      const spawn = mockSpawnSync({
        claude: { status: 1, stdout: '', stderr: 'error' }
      })
      const rl = mockRl(['a'])
      const result = await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log,
        _spawnSync: spawn.fn
      })
      assert.strictEqual(result.answer, 'no')
      assert.ok(capture.lines.some(l => l.includes('Agent merge failed')))
    })

    it('rejected merge still carries original proposed content', async () => {
      const capture = captureLog()
      const spawn = mockSpawnSync({
        claude: { status: 0, stdout: 'merged stuff', stderr: '' },
        diff: { status: 1, stdout: 'diff\n', stderr: '' }
      })
      const rl = mockRl(['a', 'n'])
      const result = await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log,
        _spawnSync: spawn.fn
      })
      assert.strictEqual(result.answer, 'no')
      // content reflects the merged version (agent changed currentProposed)
      assert.strictEqual(result.content, 'merged stuff')
    })
  })

  describe('manual merge (m)', () => {
    it('writes tmp file and resolves no', async () => {
      const capture = captureLog()
      const rl = mockRl(['m'])
      const result = await askConflict(rl, { ...baseOpts(), _log: capture.log })
      assert.strictEqual(result.answer, 'no')
      assert.ok(capture.lines.some(l => l.includes('Manual merge:')))
      assert.ok(capture.lines.some(l => l.includes('Yours:')))
      assert.ok(capture.lines.some(l => l.includes('Shipped:')))
    })
  })

  describe('prompt hint', () => {
    it('shows [Yndamq?] when defaultYes=true', async () => {
      let promptText = ''
      const rl = mockRl(['y'])
      const origQuestion = rl.question.bind(rl)
      rl.question = (prompt, cb) => { promptText = prompt; origQuestion(prompt, cb) }
      await askConflict(rl, { ...baseOpts(), defaultYes: true, _log: () => {} })
      assert.ok(promptText.includes('Conflict:'), 'prompt should start with Conflict:')
      assert.ok(promptText.includes('[Yndamq?]'))
    })

    it('shows [yNdamq?] when defaultYes=false', async () => {
      let promptText = ''
      const rl = mockRl(['n'])
      const origQuestion = rl.question.bind(rl)
      rl.question = (prompt, cb) => { promptText = prompt; origQuestion(prompt, cb) }
      resetState()
      await askConflict(rl, { ...baseOpts(), defaultYes: false, _log: () => {} })
      assert.ok(promptText.includes('[yNdamq?]'))
    })
  })

  describe('multi-step sequences', () => {
    it('d then a (success) then y resolves yes with merged content', async () => {
      const capture = captureLog()
      const spawn = mockSpawnSync({
        diff: { status: 1, stdout: 'diff output\n', stderr: '' },
        claude: { status: 0, stdout: 'merged result', stderr: '' }
      })
      const rl = mockRl(['d', 'a', 'y'])
      const result = await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log,
        _spawnSync: spawn.fn
      })
      assert.strictEqual(result.answer, 'yes')
      assert.strictEqual(result.content, 'merged result')
    })

    it('d then n resolves no', async () => {
      const capture = captureLog()
      const spawn = mockSpawnSync({
        diff: { status: 1, stdout: 'diff output\n', stderr: '' }
      })
      const rl = mockRl(['d', 'n'])
      const result = await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log,
        _spawnSync: spawn.fn
      })
      assert.strictEqual(result.answer, 'no')
    })

    it('? then q resolves quit', async () => {
      const capture = captureLog()
      const rl = mockRl(['?', 'q'])
      const result = await askConflict(rl, {
        ...baseOpts(),
        _log: capture.log
      })
      assert.strictEqual(result.answer, 'quit')
    })
  })
})
