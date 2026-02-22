/**
 * Render a human-readable orientation briefing for Claude Code sessions.
 * Called by the session:briefing builtin on SessionStart.
 *
 * Pure function: takes a merged config, returns a string.
 */

const EVENT_ORDER = ['SessionStart', 'PreToolUse', 'Stop', 'pre-commit', 'pre-push']

const OBLIGATIONS_HEADER = `# prove_it — Verification Framework

## YOUR OBLIGATIONS (read this first)

prove_it is a supervisory framework running alongside this session. It runs automated checks on your work. You have one key responsibility:

**You MUST run \`prove_it signal done\` once at the end of each coding task** — not after every edit, not after every file, but after you have finished implementing any coherent body of work (a full feature, a complete bug fix, a finished refactor). This triggers AI reviewers and the full test suite. Do not signal prematurely or repeatedly — signal when the work is *actually done*.

### Completion rule

Do not say "done", "finished", "complete", "ready to ship", or similar language unless you have already run \`prove_it signal done\` in this session and all checks have passed. If a reviewer fails, fix the issues and re-signal.

### Accountability rule

After implementing code changes, if you do NOT run \`prove_it signal done\`, you MUST explicitly state why and what remains. Valid reasons:

- Blocked on user input or a decision
- This is an intermediate step in a larger plan (signal is coming later)
- Tests are currently failing and you're still debugging
- The work is incomplete — here is what's left: [list]

Silence is not acceptable. Either signal or explain.`

const SIMPLE_HEADER = `# prove_it — Verification Framework

prove_it is a supervisory framework running alongside this session. It enforces quality gates by running automated checks at key lifecycle points.`

function timeAgo (ms) {
  if (ms == null) return 'never'
  const elapsed = Date.now() - ms
  if (elapsed < 0) return 'just now'
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function eventLabel (entry) {
  if (entry.type === 'git') {
    switch (entry.event) {
      case 'pre-commit': return 'On git commit'
      case 'pre-push': return 'On git push'
      default: return `On ${entry.event}`
    }
  }
  switch (entry.event) {
    case 'SessionStart': return 'On session start'
    case 'PreToolUse': {
      const tools = entry.matcher ? entry.matcher.split('|').join(', ') : 'any tool'
      return `Before tool use (${tools})`
    }
    case 'Stop': return 'After each turn'
    default: return entry.event
  }
}

function eventSortKey (entry) {
  const idx = EVENT_ORDER.indexOf(entry.event)
  return idx >= 0 ? idx : EVENT_ORDER.length
}

function whenClauseDescription (clause) {
  if (!clause) return null
  const parts = []

  if (clause.fileExists) parts.push(`requires ${clause.fileExists}`)
  if (clause.envSet) parts.push(`requires $${clause.envSet}`)
  if (clause.envNotSet) parts.push(`requires $${clause.envNotSet} unset`)
  if (clause.variablesPresent) parts.push(`requires {{${clause.variablesPresent.join('}}, {{')}}}`)
  if (clause.signal) parts.push(`on "${clause.signal}" signal`)
  if (clause.linesWritten) parts.push(`after ${clause.linesWritten}+ lines written`)
  if (clause.linesChanged) parts.push(`after ${clause.linesChanged}+ net lines changed`)
  if (clause.sourceFilesEdited) parts.push('when source files are edited')
  if (clause.sourcesModifiedSinceLastRun) parts.push('when sources change since last run')
  if (clause.toolsUsed) parts.push(`when ${clause.toolsUsed.join(', ')} used`)

  return parts.length > 0 ? parts.join(', ') : null
}

function whenDescription (when) {
  if (!when) return null
  const clauses = Array.isArray(when) ? when : [when]
  return clauses.map(c => whenClauseDescription(c)).filter(Boolean).join(' OR ') || null
}

const SIGNAL_DIRECTIVES = {
  done: 'Run `prove_it signal done` once after completing a coherent body of work — not after every edit or file.',
  stuck: 'When blocked or stuck, run `prove_it signal stuck` to request intervention.'
}

function signalDirective (type) {
  return SIGNAL_DIRECTIVES[type] || `When ready, run \`prove_it signal ${type}\`.`
}

function taskLine (task) {
  if (task.type === 'script') {
    return `**${task.name}**—runs \`${task.command || '(no command)'}\``
  }
  if (task.type === 'agent') {
    const whenDesc = whenDescription(task.when)
    return whenDesc
      ? `**${task.name}**—AI reviewer (${whenDesc})`
      : `**${task.name}**—AI reviewer`
  }
  if (task.type === 'env') {
    return `**${task.name}**—sets environment variables`
  }
  return `**${task.name}**`
}

function renderBriefing (cfg, runs) {
  if (!runs) runs = {}
  const lines = []

  // Pre-scan: gather structural info before rendering
  const hooks = cfg.hooks || []
  const sorted = [...hooks].sort((a, b) => eventSortKey(a) - eventSortKey(b))

  let hasAgentTasks = false
  let hasDoneSignal = false
  const signalTypes = new Set()
  const signalGatedTasks = []

  for (const entry of sorted) {
    for (const task of (entry.tasks || [])) {
      if (task.name === 'session-briefing') continue
      if (task.type === 'agent') hasAgentTasks = true
      const clauses = Array.isArray(task.when) ? task.when : (task.when ? [task.when] : [])
      for (const clause of clauses) {
        if (clause.signal) {
          signalTypes.add(clause.signal)
          if (clause.signal === 'done') hasDoneSignal = true
          signalGatedTasks.push(task)
          break
        }
      }
    }
  }

  // Zone 1: Obligations or simple header
  if (hasDoneSignal) {
    lines.push(OBLIGATIONS_HEADER)
  } else {
    lines.push(SIMPLE_HEADER)
  }

  // Separator
  lines.push('')
  lines.push('---')
  lines.push('')

  // Zone 2: Reference
  lines.push('## How prove_it works (reference)')
  lines.push('')

  // Automated checks
  lines.push('### Automated checks')
  lines.push('')

  for (const entry of sorted) {
    const tasks = (entry.tasks || []).filter(t => t.name !== 'session-briefing')
    if (tasks.length === 0) continue

    const label = eventLabel(entry)
    lines.push(`${label}:`)
    for (const task of tasks) {
      lines.push(`  - ${taskLine(task)}`)
    }
    lines.push('')
  }

  // Signal-gated tasks
  if (signalTypes.size > 0) {
    lines.push('### Signal-gated tasks')
    lines.push('')
    for (const task of signalGatedTasks) {
      const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
      const lastAt = runs[runKey]?.at
      lines.push(`  - **${task.name}**—last ran ${timeAgo(lastAt)}`)
    }
    // Non-done signal directives (done is covered in obligations)
    const types = Array.from(signalTypes).sort()
    for (const type of types) {
      if (type === 'done') continue
      lines.push(`  - ${signalDirective(type)}`)
    }
    lines.push('  - To clear the active signal, run `prove_it signal clear`.')
    lines.push('  - If a reviewer finds significant issues, re-signal after fixing them.')
    lines.push('')
  }

  // Handling review failures
  if (hasAgentTasks) {
    lines.push('### Handling review failures')
    lines.push('')
    lines.push('When an AI reviewer FAILs, the current action is blocked until the issue is addressed. A backchannel directory is created where you can appeal:')
    lines.push('')
    lines.push('1. Find the backchannel at `.prove_it/backchannel/<reviewer-name>/README.md`')
    lines.push('2. Write your reasoning for why the failure should be reconsidered')
    lines.push('3. The reviewer reads the backchannel on its next run and assumes good faith')
    lines.push('')
    lines.push('A supervisory process audits appeals for honesty — do not attempt to manipulate reviewers.')
  }

  return lines.join('\n').trimEnd()
}

module.exports = { renderBriefing, eventLabel, whenDescription, taskLine, timeAgo, signalDirective }
