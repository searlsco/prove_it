const path = require('path')
const { loadJson } = require('../shared')
const { log } = require('./_helpers')

function showHelp () {
  log(`prove_it - Config-driven hook framework for Claude Code

Usage: prove_it <command>

Commands:
  install     Install prove_it globally (~/.claude/) and /prove skill
  uninstall   Remove prove_it from global config
  reinstall   Uninstall and reinstall global hooks
  upgrade     Update via Homebrew, reinstall hooks, reinit project
  init        Initialize prove_it in current repository
  deinit      Remove prove_it files from current repository
  reinit      Deinit and re-init current repository
  doctor      Check installation status and report issues
  signal      Declare a lifecycle signal (done, stuck, idle)
  cancel      Cancel running hook tasks for the current session
  disable     Silence prove_it hooks for the current session (run via ! prove_it disable)
  enable      Re-enable prove_it hooks for the current session
  catchup     Fast-forward reviewer baselines/state past stale repo state
  phase       Set session activity phase (unknown, plan, implement, refactor)
  monitor     Tail hook results in real time (run in a separate terminal)
  explain     Explain effective strict .prove_it configuration as JSON
  hook        Run a hook dispatcher (claude:<Event> or git:<event>)
  prefix      Print install directory (for resolving libexec scripts)
  record      Record a test run result for run caching
  help        Show this help message
  -v, --version  Show version number

Monitor options:
  prove_it monitor                     Tail current project (or guidance if not in one)
  prove_it monitor --all               Tail all sessions and project logs
  prove_it monitor --all --sessions    Show session IDs
  prove_it monitor --list              List all sessions
  prove_it monitor --status=PASS,FAIL  Show only these types
  prove_it monitor --no-status=SKIP    Hide these types
  prove_it monitor --task=fast-tests   Show only these tasks
  prove_it monitor --no-task=briefing  Hide these tasks
  prove_it monitor --project           Scope to current project directory
  prove_it monitor --project=/foo/bar  Scope to specific project directory
  prove_it monitor --verbose           Show full prompts, responses, and output
  prove_it monitor <id>                Tail a specific session (prefix match OK)

Signal options:
  prove_it signal done                   Declare coherent work complete
  prove_it signal stuck                  Declare stuck / cycling
  prove_it signal idle                   Declare idle / between tasks
  prove_it signal done -m "Ready for review"  Include a message

Phase options:
  prove_it phase unknown                 Reset to default phase
  prove_it phase plan                    Declare planning phase
  prove_it phase implement               Declare implementation phase
  prove_it phase refactor                Declare refactoring phase

Record options:
  --name <name>    Check name to record (must match hook config)
  --pass           Record a successful run (exits 0)
  --fail           Record a failed run (exits 1)
  --result <N>     Record pass (N=0) or fail (N!=0), exit with code N

Init options:
  --[no-]git-hooks                Configure Git 2.54 config hooks for active Git workflows (default: yes)
  --[no-]default-checks           Include code review, coverage review (default: yes)
  --[no-]automatic-git-hook-merge Legacy .git/hooks shim mode only (strict init ignores shim merging)
  --[no-]overwrite                Overwrite customized config with defaults
  --adapter <pi|claude>           Strict .prove_it init for an explicit adapter (repeatable)

  With --adapter, init writes strict .prove_it config, adapter-native owned artifacts,
  and prove_it-owned Git config hook entries for active Git workflows when Git 2.54+ is available.
  With no flags and a TTY, prove_it init asks interactively.
  With no flags and no TTY, all defaults apply (equivalent to all features on).

Examples:
  prove_it install                         # Set up global hooks
  prove_it init                            # Interactive setup
  prove_it init --no-git-hooks             # Skip git hooks
  prove_it init --no-default-checks        # Base config only (no agents)
  prove_it init --adapter pi               # Strict .prove_it setup for Pi
  prove_it init --adapter pi --adapter claude  # Strict multi-adapter setup
  prove_it doctor                          # Check installation status
  prove_it monitor                         # Watch hook results in real time
  prove_it explain                         # Inspect effective strict .prove_it config
  prove_it deinit                          # Remove prove_it from current repo
  prove_it uninstall                       # Remove global hooks
`)
}

function getVersion () {
  const pkg = loadJson(path.join(__dirname, '..', '..', 'package.json'))
  return pkg?.version || 'unknown'
}

module.exports = { showHelp, getVersion }
