const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  extractTargetPaths,
  targetPathMatchesProtected,
  toProjectRelativePath
} = require('../lib/redesign/target_paths')
const { normalizeLifecycleEvent, normalizePiToolCall } = require('../lib/redesign/events')
const { DEFAULT_PROTECTED_PATHS, runPreToolWorkflow } = require('../lib/redesign/engine')

describe('shared target path extraction and matching', () => {
  it('extracts Pi and generic path shapes from top-level and input payloads', () => {
    assert.deepStrictEqual(extractTargetPaths({
      path: 'top-level.txt',
      input: {
        path: 'input-path.txt',
        targetPath: 'input-target.txt',
        paths: ['a.txt', 'b.txt']
      }
    }), [
      'top-level.txt',
      'input-path.txt',
      'input-target.txt',
      'a.txt',
      'b.txt'
    ])
  })

  it('extracts generic edit-array payloads used by multi-file edit tools', () => {
    assert.deepStrictEqual(extractTargetPaths({
      toolName: 'multi_edit',
      input: {
        edits: [
          { path: 'src/app.js', oldText: 'a', newText: 'b' },
          { filePath: 'src/util.js', oldText: 'c', newText: 'd' },
          'docs/readme.md'
        ],
        operations: [
          { target_path: 'src/operation.js' }
        ]
      }
    }), [
      'src/app.js',
      'src/util.js',
      'docs/readme.md',
      'src/operation.js'
    ])
  })

  it('extracts Claude file_path and notebook_path payloads for adapter parity', () => {
    assert.deepStrictEqual(extractTargetPaths({
      tool_name: 'NotebookEdit',
      tool_input: {
        file_path: 'src/claude.js',
        notebook_path: 'notebooks/demo.ipynb'
      }
    }), [
      'src/claude.js',
      'notebooks/demo.ipynb'
    ])
  })

  it('extracts Bash write targets from redirects and tee commands', () => {
    assert.deepStrictEqual(extractTargetPaths({
      tool_name: 'Bash',
      tool_input: {
        command: 'mkdir -p .prove_it && echo {} > .prove_it/config.json && echo local | tee -a .prove_it/config.local.json'
      }
    }), [
      '.prove_it/config.json',
      '.prove_it/config.local.json'
    ])
  })

  it('matches protected .prove_it config paths through relative, absolute, and canonicalized forms', () => {
    const realRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_target_real_'))
    const linkRepo = path.join(os.tmpdir(), `prove_it_target_link_${process.pid}_${Date.now()}`)
    fs.mkdirSync(path.join(realRepo, '.prove_it'), { recursive: true })
    fs.writeFileSync(path.join(realRepo, '.prove_it', 'config.json'), '{}')
    fs.symlinkSync(realRepo, linkRepo, 'dir')

    try {
      assert.strictEqual(
        targetPathMatchesProtected('.prove_it/config.json', '.prove_it/config.json', realRepo),
        true,
        'relative protected path should match'
      )
      assert.strictEqual(
        targetPathMatchesProtected(path.join(realRepo, '.prove_it', 'config.json'), '.prove_it/config.json', realRepo),
        true,
        'absolute protected path should match'
      )
      assert.strictEqual(
        targetPathMatchesProtected(path.join(linkRepo, '.prove_it', 'config.json'), '.prove_it/config.json', realRepo),
        true,
        'symlinked target path should match real root'
      )
      assert.strictEqual(
        targetPathMatchesProtected(path.join(realRepo, '.prove_it', 'config.json'), '.prove_it/config.json', linkRepo),
        true,
        'real target path should match symlinked root'
      )
      assert.strictEqual(
        toProjectRelativePath(path.join(linkRepo, '.prove_it', 'config.json'), realRepo),
        '.prove_it/config.json'
      )
    } finally {
      fs.rmSync(linkRepo, { recursive: true, force: true })
      fs.rmSync(realRepo, { recursive: true, force: true })
    }
  })

  it('does not make legacy .claude/prove_it paths clean-runtime protected defaults', () => {
    assert.deepStrictEqual(DEFAULT_PROTECTED_PATHS, [
      '.prove_it/config.json',
      '.prove_it/config.local.json'
    ])
    assert.strictEqual(
      targetPathMatchesProtected('.claude/prove_it/config.json', '.prove_it/config.json', process.cwd()),
      false
    )
  })

  it('blocks Pi-shaped config edits through the shared helper-backed config guard', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_target_pi_'))
    const config = {
      tasks: {
        protect: { type: 'config_guard' }
      },
      agent_workflows: { pre_tool: ['protect'] }
    }

    try {
      const event = normalizePiToolCall({
        toolName: 'edit',
        input: { path: path.join(repo, '.prove_it', 'config.local.json') }
      }, { cwd: repo })

      assert.deepStrictEqual(runPreToolWorkflow(config, event), {
        effect: 'block',
        reason: 'prove_it: Cannot modify protected prove_it config path .prove_it/config.local.json'
      })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('blocks Claude-shaped config edits once routed through the normalized workflow event', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_target_claude_'))
    const config = {
      tasks: {
        protect: { type: 'config_guard' }
      },
      agent_workflows: { pre_tool: ['protect'] }
    }

    try {
      const event = normalizeLifecycleEvent({
        adapterId: 'claude',
        rawEventName: 'PreToolUse',
        rawEvent: {
          tool_name: 'NotebookEdit',
          tool_input: { notebook_path: '.prove_it/config.json' }
        },
        cwd: repo,
        rootDir: repo
      })

      assert.deepStrictEqual(runPreToolWorkflow(config, event), {
        effect: 'block',
        reason: 'prove_it: Cannot modify protected prove_it config path .prove_it/config.json'
      })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
