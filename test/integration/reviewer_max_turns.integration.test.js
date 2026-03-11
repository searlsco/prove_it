const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { runReviewer } = require('../../lib/shared')

describe('runReviewer with maxAgentTurns (shim-based)', () => {
  let tmpDir

  function setup () {
    tmpDir = path.join(os.tmpdir(), 'prove_it_max_turns_' + Date.now())
    fs.mkdirSync(tmpDir, { recursive: true })
  }

  function cleanup () {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  function writeShim (name, script) {
    const p = path.join(tmpDir, name)
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`)
    fs.chmodSync(p, 0o755)
    return p
  }

  it('appends --max-turns N --output-format json for claude binary', () => {
    setup()
    // Shim echoes its own args so we can verify the flags
    const claudePath = writeShim('claude',
      'echo "PASS: args=$*"')
    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 5
    }, 'test prompt')
    // The shim echoes raw text, not JSON. Since JSON parse fails,
    // extractReviewText falls back to raw text. We can verify the args.
    assert.ok(r.pass, `Expected PASS, got: ${JSON.stringify(r)}`)
    assert.ok(r.reason.includes('--max-turns'), 'Should include --max-turns flag')
    assert.ok(r.reason.includes('5'), 'Should include the turn limit')
    assert.ok(r.reason.includes('--output-format'), 'Should include --output-format flag')
    assert.ok(r.reason.includes('json'), 'Should include json format')
    cleanup()
  })

  it('does not append --max-turns for non-claude binaries', () => {
    setup()
    const customPath = writeShim('custom_reviewer',
      'echo "PASS: args=$*"')
    const r = runReviewer(tmpDir, {
      command: customPath,
      maxAgentTurns: 5
    }, 'test prompt')
    assert.ok(r.pass)
    assert.ok(!r.reason.includes('--max-turns'), 'Custom binary should not get --max-turns')
    cleanup()
  })

  it('does not append --max-turns when maxAgentTurns is null', () => {
    setup()
    const claudePath = writeShim('claude',
      'echo "PASS: args=$*"')
    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: null
    }, 'test prompt')
    assert.ok(r.pass)
    assert.ok(!r.reason.includes('--max-turns'), 'Should not include --max-turns when null')
    cleanup()
  })

  it('parses JSON success output and extracts result field', () => {
    setup()
    const json = JSON.stringify({ result: 'PASS: all tests cover the changes', subtype: 'success', session_id: 'sess-123' })
    const claudePath = writeShim('claude',
      `cat > /dev/null\necho '${json.replace(/'/g, "'\\''")}'`)
    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 10
    }, 'test prompt')
    assert.ok(r.pass, `Expected PASS, got: ${JSON.stringify(r)}`)
    assert.strictEqual(r.reason, 'all tests cover the changes')
    cleanup()
  })

  it('parses JSON FAIL output correctly', () => {
    setup()
    const json = JSON.stringify({ result: 'FAIL: missing tests for new function', subtype: 'success', session_id: 'sess-456' })
    const claudePath = writeShim('claude',
      `cat > /dev/null\necho '${json.replace(/'/g, "'\\''")}'`)
    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 10
    }, 'test prompt')
    assert.strictEqual(r.pass, false)
    assert.strictEqual(r.reason, 'missing tests for new function')
    cleanup()
  })

  it('handles error_max_turns by nudging with resume', () => {
    setup()
    // The initial claude call returns error_max_turns with a session_id.
    // The resume call (same binary) should return a verdict.
    // We use a stateful shim: first call returns max_turns error,
    // subsequent calls (the resume) return a PASS verdict.
    const stateFile = path.join(tmpDir, '.call_count')
    const maxTurnsJson = JSON.stringify({
      result: '',
      subtype: 'error_max_turns',
      session_id: 'sess-resume-test',
      num_turns: 3
    })
    const resumeJson = JSON.stringify({
      result: 'PASS: code looks good after partial review',
      subtype: 'success',
      session_id: 'sess-resume-test'
    })
    const claudePath = writeShim('claude', `cat > /dev/null
if [ -f "${stateFile}" ]; then
  echo '${resumeJson.replace(/'/g, "'\\''")}'
else
  touch "${stateFile}"
  echo '${maxTurnsJson.replace(/'/g, "'\\''")}'
fi`)

    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 3
    }, 'test prompt')
    assert.ok(r.pass, `Expected PASS from wrap-up resume, got: ${JSON.stringify(r)}`)
    assert.strictEqual(r.reason, 'code looks good after partial review')
    assert.ok(r.wrapUp, 'Expected wrap-up metadata')
    assert.strictEqual(r.wrapUp.succeeded, true)
    assert.strictEqual(r.wrapUp.numTurns, 3)

    // Verify the state file was created (proving the first call happened)
    assert.ok(fs.existsSync(stateFile), 'State file should exist proving two calls were made')
    cleanup()
  })

  it('returns wrap-up.succeeded=false when resume fails', () => {
    setup()
    const stateFile = path.join(tmpDir, '.call_count_fail')
    const maxTurnsJson = JSON.stringify({
      result: 'partial work',
      subtype: 'error_max_turns',
      session_id: 'sess-fail-wrap-up',
      num_turns: 5
    })
    const claudePath = writeShim('claude', `cat > /dev/null
if [ -f "${stateFile}" ]; then
  echo "resume crashed" >&2
  exit 1
else
  touch "${stateFile}"
  echo '${maxTurnsJson.replace(/'/g, "'\\''")}'
fi`)

    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 5
    }, 'test prompt')
    // Falls back to original result text
    assert.ok(r.wrapUp, 'Expected wrap-up metadata')
    assert.strictEqual(r.wrapUp.succeeded, false)
    assert.strictEqual(r.wrapUp.numTurns, 5)
    cleanup()
  })

  it('skips classifyVerdict when wrap-up fails and fallback text is unparseable', () => {
    setup()
    const stateFile = path.join(tmpDir, '.call_count_no_classify')
    // result is empty string — fallback will be the raw JSON stdout,
    // which is not a verdict. Without the gate, this would call the real
    // claude binary for classification and block for 30s.
    const maxTurnsJson = JSON.stringify({
      result: '',
      subtype: 'error_max_turns',
      session_id: 'sess-no-classify',
      num_turns: 5
    })
    const claudePath = writeShim('claude', `cat > /dev/null
if [ -f "${stateFile}" ]; then
  echo "resume crashed" >&2
  exit 1
else
  touch "${stateFile}"
  echo '${maxTurnsJson.replace(/'/g, "'\\''")}'
fi`)

    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 5,
      timeout: 3000
    }, 'test prompt')
    // Should return an error, not attempt to classify via haiku
    assert.ok(r.error, `Expected error when wrap-up fails with unparseable text, got: ${JSON.stringify(r)}`)
    assert.ok(r.wrapUp, 'Expected wrap-up metadata')
    assert.strictEqual(r.wrapUp.succeeded, false)
    assert.strictEqual(r.wrapUp.numTurns, 5)
    cleanup()
  })

  it('falls back to raw text when JSON is malformed', () => {
    setup()
    const claudePath = writeShim('claude',
      'cat > /dev/null\necho "PASS: raw output not json"')
    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 5
    }, 'test prompt')
    assert.ok(r.pass, `Expected PASS from raw fallback, got: ${JSON.stringify(r)}`)
    // The raw text includes the args echo and the PASS line — falls back gracefully
    cleanup()
  })

  it('combines --max-turns with --model correctly', () => {
    setup()
    const claudePath = writeShim('claude',
      'echo "PASS: args=$*"')
    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 7,
      model: 'haiku'
    }, 'test prompt')
    assert.ok(r.pass)
    assert.ok(r.reason.includes('--model') && r.reason.includes('haiku'))
    assert.ok(r.reason.includes('--max-turns') && r.reason.includes('7'))
    cleanup()
  })

  it('combines --max-turns with --allowedTools correctly', () => {
    setup()
    const claudePath = writeShim('claude',
      'echo "PASS: args=$*"')
    const r = runReviewer(tmpDir, {
      command: `${claudePath} -p`,
      maxAgentTurns: 5,
      allowedTools: 'Read,Grep,Glob',
      bypassPermissions: false
    }, 'test prompt')
    assert.ok(r.pass)
    assert.ok(r.reason.includes('--max-turns'))
    assert.ok(r.reason.includes('--allowedTools'))
    cleanup()
  })
})
