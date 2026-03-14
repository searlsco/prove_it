const { log } = require('./_helpers')

function cmdPhase () {
  // Phases are intercepted by the hook dispatcher (PreToolUse + Bash),
  // which has the session ID from Claude Code's hook input. When running
  // inside Claude Code (CLAUDECODE=1), the dispatcher already recorded the
  // phase before allowing the Bash call through--exit 0 so the caller
  // doesn't see a spurious failure.
  if (process.env.CLAUDECODE) {
    const phase = process.argv[3] || 'unknown'
    log(`prove_it: phase "${phase}" acknowledged`)
    process.exit(0)
  }
  console.error('prove_it phase must be run by Claude, not directly.')
  console.error('Ask Claude to run: prove_it phase <unknown|plan|implement|refactor>')
  process.exit(1)
}

module.exports = { cmdPhase }
