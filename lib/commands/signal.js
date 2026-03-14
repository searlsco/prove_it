const { log } = require('./_helpers')

function cmdSignal () {
  // Signals are intercepted by the hook dispatcher (PreToolUse + Bash),
  // which has the session ID from Claude Code's hook input. When running
  // inside Claude Code (CLAUDECODE=1), the dispatcher already recorded the
  // signal before allowing the Bash call through--exit 0 so the caller
  // doesn't see a spurious failure.
  if (process.env.CLAUDECODE) {
    const type = process.argv[3] || 'unknown'
    log(`prove_it: signal "${type}" acknowledged`)
    process.exit(0)
  }
  console.error('prove_it signal must be run by Claude, not directly.')
  console.error('Ask Claude to run: prove_it signal <done|stuck|idle>')
  process.exit(1)
}

module.exports = { cmdSignal }
