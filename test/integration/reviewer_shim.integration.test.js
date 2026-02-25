const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { runReviewer, classifyVerdict } = require('../../lib/shared')

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures')

describe('runReviewer with fixture shims', () => {
  const tmpDir = path.join(require('os').tmpdir(), 'prove_it_reviewer_shim_' + Date.now())
  const fraudePath = path.join(FIXTURES_DIR, 'fraude')
  function setup () { fs.mkdirSync(tmpDir, { recursive: true }) }
  function cleanup () { delete process.env.FRAUDE_RESPONSE; fs.rmSync(tmpDir, { recursive: true, force: true }) }

  // ---------- Story: model support ----------
  // claude → codex → custom → null
  it('appends --model for claude/codex, omits for custom/null', () => {
    setup()
    // Claude: --model haiku
    const claudePath = path.join(tmpDir, 'claude')
    fs.writeFileSync(claudePath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
    fs.chmodSync(claudePath, 0o755)
    const r1 = runReviewer(tmpDir, { command: `${claudePath} -p`, model: 'haiku' }, 'test')
    assert.ok(r1.pass && r1.reason.includes('--model') && r1.reason.includes('haiku'))

    // Codex: --model gpt-5.3-codex
    const codexPath = path.join(tmpDir, 'codex')
    fs.writeFileSync(codexPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
    fs.chmodSync(codexPath, 0o755)
    const r2 = runReviewer(tmpDir, { command: `${codexPath} exec -`, model: 'gpt-5.3-codex' }, 'test')
    assert.ok(r2.pass && r2.reason.includes('gpt-5.3-codex'))

    // Custom: no --model
    const customPath = path.join(tmpDir, 'custom_reviewer')
    fs.writeFileSync(customPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
    fs.chmodSync(customPath, 0o755)
    const r3 = runReviewer(tmpDir, { command: customPath, model: 'haiku' }, 'test')
    assert.ok(!r3.reason.includes('--model'))

    // Null model: no --model
    process.env.FRAUDE_RESPONSE = 'PASS: no model'
    const r4 = runReviewer(tmpDir, { command: `${fraudePath} -p`, model: null }, 'test')
    assert.ok(r4.pass)

    cleanup()
  })

  // ---------- Story: allowedTools support ----------
  it('appends --allowedTools for claude/codex, omits for custom/null', () => {
    setup()

    // Claude: --allowedTools
    const claudePath = path.join(tmpDir, 'claude')
    fs.writeFileSync(claudePath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
    fs.chmodSync(claudePath, 0o755)
    const r1 = runReviewer(tmpDir, { command: `${claudePath} -p`, allowedTools: 'Write(/tmp/notepad.md)' }, 'test')
    assert.ok(r1.pass && r1.reason.includes('--allowedTools'))

    // Codex: --allowedTools
    const codexPath = path.join(tmpDir, 'codex')
    fs.writeFileSync(codexPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
    fs.chmodSync(codexPath, 0o755)
    const r2 = runReviewer(tmpDir, { command: `${codexPath} exec -`, allowedTools: 'Write(/tmp/notepad.md)' }, 'test')
    assert.ok(r2.pass && r2.reason.includes('--allowedTools'))

    // Custom: no --allowedTools
    const customPath = path.join(tmpDir, 'custom_reviewer')
    fs.writeFileSync(customPath, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
    fs.chmodSync(customPath, 0o755)
    const r3 = runReviewer(tmpDir, { command: customPath, allowedTools: 'Write(/tmp/notepad.md)' }, 'test')
    assert.ok(!r3.reason.includes('--allowedTools'))

    // Null allowedTools: no --allowedTools
    const r4 = runReviewer(tmpDir, { command: `${claudePath} -p`, allowedTools: null }, 'test')
    assert.ok(!r4.reason.includes('--allowedTools'))

    cleanup()
  })

  // ---------- Story: environment isolation ----------
  it('sets LC_ALL=C and clears CLAUDECODE', () => {
    setup()

    // LC_ALL=C
    const lcPath = path.join(tmpDir, 'lc_check.sh')
    fs.writeFileSync(lcPath, [
      '#!/usr/bin/env bash', 'cat > /dev/null',
      'if [ "$LC_ALL" = "C" ]; then echo "PASS: LC_ALL=C"; else echo "FAIL: LC_ALL not C"; fi'
    ].join('\n'))
    fs.chmodSync(lcPath, 0o755)
    assert.strictEqual(runReviewer(tmpDir, { command: lcPath }, 'test').pass, true)

    // CLAUDECODE cleared
    const ccPath = path.join(tmpDir, 'cc_check.sh')
    fs.writeFileSync(ccPath, [
      '#!/usr/bin/env bash', 'cat > /dev/null',
      'if [ -n "$CLAUDECODE" ]; then echo "FAIL: CLAUDECODE set"; else echo "PASS: cleared"; fi'
    ].join('\n'))
    fs.chmodSync(ccPath, 0o755)
    const orig = process.env.CLAUDECODE
    process.env.CLAUDECODE = '1'
    assert.strictEqual(runReviewer(tmpDir, { command: ccPath }, 'test').pass, true)
    if (orig === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = orig

    cleanup()
  })

  // ---------- Story: configEnv ----------
  it('makes configEnv available, protects PROVE_IT_DISABLED/CLAUDECODE, handles null', () => {
    setup()

    // Custom var available
    const p1 = path.join(tmpDir, 'env1.sh')
    fs.writeFileSync(p1, [
      '#!/usr/bin/env bash', 'cat > /dev/null',
      'if [ "$TURBOCOMMIT_DISABLED" = "1" ]; then echo "PASS"; else echo "FAIL"; fi'
    ].join('\n'))
    fs.chmodSync(p1, 0o755)
    assert.strictEqual(runReviewer(tmpDir, { command: p1, configEnv: { TURBOCOMMIT_DISABLED: '1' } }, 'test').pass, true)

    // PROVE_IT_DISABLED cannot be overridden (it's always 1 in reviewer subprocess)
    const p2 = path.join(tmpDir, 'env2.sh')
    fs.writeFileSync(p2, [
      '#!/usr/bin/env bash', 'cat > /dev/null',
      'if [ "$PROVE_IT_DISABLED" = "1" ]; then echo "PASS"; else echo "FAIL"; fi'
    ].join('\n'))
    fs.chmodSync(p2, 0o755)
    assert.strictEqual(runReviewer(tmpDir, { command: p2, configEnv: { PROVE_IT_DISABLED: '0' } }, 'test').pass, true)

    // CLAUDECODE cannot be set via configEnv
    const p3 = path.join(tmpDir, 'env3.sh')
    fs.writeFileSync(p3, [
      '#!/usr/bin/env bash', 'cat > /dev/null',
      'if [ -z "$CLAUDECODE" ]; then echo "PASS"; else echo "FAIL"; fi'
    ].join('\n'))
    fs.chmodSync(p3, 0o755)
    assert.strictEqual(runReviewer(tmpDir, { command: p3, configEnv: { CLAUDECODE: 'yes' } }, 'test').pass, true)

    // Null configEnv works fine
    process.env.FRAUDE_RESPONSE = 'PASS: null configEnv'
    assert.strictEqual(runReviewer(tmpDir, { command: `${fraudePath} -p`, configEnv: null }, 'test').pass, true)

    cleanup()
  })

  it('basic PASS/FAIL, missing binary, timeout, and codex auto-switch', () => {
    setup()

    // PASS
    process.env.FRAUDE_RESPONSE = 'PASS'
    assert.strictEqual(runReviewer(tmpDir, { command: `${fraudePath} -p` }, 'test').pass, true)

    // FAIL
    process.env.FRAUDE_RESPONSE = 'FAIL: no tests for new function'
    const fail = runReviewer(tmpDir, { command: `${fraudePath} -p` }, 'test')
    assert.strictEqual(fail.pass, false)
    assert.strictEqual(fail.reason, 'no tests for new function')

    // Missing binary
    const missing = runReviewer(tmpDir, { command: 'nonexistent_binary_xyz' }, 'test')
    assert.strictEqual(missing.available, false)

    // Timeout from config
    const shimPath = path.join(tmpDir, 'slow.sh')
    fs.writeFileSync(shimPath, '#!/usr/bin/env bash\ncat > /dev/null\necho "PASS"\n')
    fs.chmodSync(shimPath, 0o755)
    assert.strictEqual(runReviewer(tmpDir, { command: shimPath, timeout: 30000 }, 'test').pass, true)

    // Codex auto-switch for gpt- models
    const shimDir = path.join(tmpDir, 'bin')
    fs.mkdirSync(shimDir, { recursive: true })
    const codexShim = path.join(shimDir, 'codex')
    fs.writeFileSync(codexShim, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
    fs.chmodSync(codexShim, 0o755)
    const claudeShim = path.join(shimDir, 'claude')
    fs.writeFileSync(claudeShim, '#!/usr/bin/env bash\necho "PASS: args=$*"\n')
    fs.chmodSync(claudeShim, 0o755)

    const origPath = process.env.PATH
    process.env.PATH = `${shimDir}:${origPath}`

    const gpt = runReviewer(tmpDir, { model: 'gpt-5.3-codex' }, 'test')
    assert.ok(gpt.reason.includes('gpt-5.3-codex'))
    const haiku = runReviewer(tmpDir, { model: 'haiku' }, 'test')
    assert.ok(haiku.reason.includes('haiku'))

    // Explicit command not overridden by gpt model
    process.env.FRAUDE_RESPONSE = 'PASS: custom command'
    const explicit = runReviewer(tmpDir, { command: `${fraudePath} -p`, model: 'gpt-5.3-codex' }, 'test')
    assert.strictEqual(explicit.reason, 'custom command')

    process.env.PATH = origPath
    cleanup()
  })
})

describe('classifyVerdict with mock claude', () => {
  const tmpDir = path.join(require('os').tmpdir(), 'prove_it_classify_' + Date.now())
  let origPath

  function shimClaude (script) {
    fs.mkdirSync(tmpDir, { recursive: true })
    const p = path.join(tmpDir, 'claude')
    fs.writeFileSync(p, `#!/usr/bin/env bash\ncat > /dev/null\n${script}\n`)
    fs.chmodSync(p, 0o755)
    origPath = process.env.PATH
    process.env.PATH = `${tmpDir}:${origPath}`
  }

  function teardown () {
    process.env.PATH = origPath
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  it('returns { verdict: "PASS" } when classifier outputs PASS', () => {
    shimClaude('echo PASS')
    const result = classifyVerdict('The code looks great, all tests pass.')
    assert.deepStrictEqual(result, { verdict: 'PASS' })
    teardown()
  })

  it('returns { verdict: "FAIL" } when classifier outputs FAIL', () => {
    shimClaude('echo FAIL')
    const result = classifyVerdict('There are several issues with the implementation.')
    assert.deepStrictEqual(result, { verdict: 'FAIL' })
    teardown()
  })

  it('returns { verdict: "SKIP" } when classifier outputs SKIP', () => {
    shimClaude('echo SKIP')
    const result = classifyVerdict('Changes are unrelated to coverage.')
    assert.deepStrictEqual(result, { verdict: 'SKIP' })
    teardown()
  })

  it('returns error when classifier outputs a non-verdict sentence', () => {
    shimClaude('echo "I cannot determine the verdict from this output."')
    const result = classifyVerdict('Some gibberish output')
    assert.ok(result.error)
    assert.ok(result.error.includes('verdict unclear'))
    teardown()
  })

  it('returns error when classifier exits non-zero', () => {
    shimClaude('exit 1')
    const result = classifyVerdict('Some reviewer output')
    assert.ok(result.error)
    assert.ok(result.error.includes('classifier exited 1'))
    teardown()
  })

  it('truncates long input to 2000 chars', () => {
    // Shim dumps stdin length so we can verify truncation
    shimClaude('echo PASS')
    const longOutput = 'x'.repeat(5000)
    const result = classifyVerdict(longOutput)
    assert.deepStrictEqual(result, { verdict: 'PASS' })
    teardown()
  })
})
