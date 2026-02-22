/**
 * Render a human-readable orientation briefing for Claude Code sessions.
 * Called by the session:briefing builtin on SessionStart.
 *
 * Pure function: takes a merged config, returns a string.
 */

const EVENT_ORDER = ['SessionStart', 'PreToolUse', 'Stop', 'pre-commit', 'pre-push']

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

function whenDescription (when) {
  if (!when) return null
  const parts = []

  // Prerequisites
  if (when.fileExists) parts.push(`requires ${when.fileExists}`)
  if (when.envSet) parts.push(`requires $${when.envSet}`)
  if (when.envNotSet) parts.push(`requires $${when.envNotSet} unset`)
  if (when.variablesPresent) parts.push(`requires {{${when.variablesPresent.join('}}, {{')}}}`)

  if (when.signal) parts.push(`on "${when.signal}" signal`)

  // Triggers
  if (when.linesWritten) parts.push(`after ${when.linesWritten}+ lines written`)
  if (when.linesChanged) parts.push(`after ${when.linesChanged}+ net lines changed`)
  if (when.sourceFilesEdited) parts.push('when source files are edited')
  if (when.sourcesModifiedSinceLastRun) parts.push('when sources change since last run')
  if (when.toolsUsed) parts.push(`when ${when.toolsUsed.join(', ')} used`)

  return parts.length > 0 ? parts.join(', ') : null
}

function taskLine (task) {
  if (task.type === 'script') {
    return `${task.name} — runs \`${task.command || '(no command)'}\``
  }
  if (task.type === 'agent') {
    const whenDesc = whenDescription(task.when)
    return whenDesc
      ? `${task.name} — AI reviewer (${whenDesc})`
      : `${task.name} — AI reviewer`
  }
  if (task.type === 'env') {
    return `${task.name} — sets environment variables`
  }
  return `${task.name}`
}

function renderBriefing (cfg, runs) {
  if (!runs) runs = {}
  const lines = []

  // Header
  lines.push('prove_it is a supervisory framework running alongside this session.')
  lines.push('It enforces quality gates by running automated checks at key lifecycle points.')
  lines.push('')

  // Group tasks by event
  const hooks = cfg.hooks || []
  const sorted = [...hooks].sort((a, b) => eventSortKey(a) - eventSortKey(b))

  let hasAgentTasks = false

  for (const entry of sorted) {
    const tasks = (entry.tasks || []).filter(t => t.name !== 'session-briefing')
    if (tasks.length === 0) continue

    const label = eventLabel(entry)
    lines.push(`${label}:`)
    for (const task of tasks) {
      lines.push(`  - ${taskLine(task)}`)
      if (task.type === 'agent') hasAgentTasks = true
    }
    lines.push('')
  }

  // Signaling instructions — only if signal-gated tasks exist
  const signalTypes = new Set()
  const signalGatedTasks = []
  for (const entry of sorted) {
    for (const task of (entry.tasks || [])) {
      if (task.when?.signal) {
        signalTypes.add(task.when.signal)
        signalGatedTasks.push(task)
      }
    }
  }
  if (signalTypes.size > 0) {
    const types = Array.from(signalTypes).sort()
    lines.push('Signaling:')
    lines.push('  Use `prove_it signal <type>` to declare your readiness state.')
    lines.push(`  Configured signals: ${types.join(', ')}`)
    lines.push('  Signal-gated tasks:')
    for (const task of signalGatedTasks) {
      const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
      const lastAt = runs[runKey]?.at
      lines.push(`    ${task.name} — last ran ${timeAgo(lastAt)}`)
    }
    lines.push('  Use `prove_it signal clear` to clear the active signal.')
    lines.push('  Be judicious — signal when a coherent unit of work is complete, not after every change.')
    lines.push('  If a reviewer finds significant issues, re-signal after fixing them.')
    lines.push('')
  }

  // How reviews work — only if agent tasks exist
  if (hasAgentTasks) {
    lines.push('How reviews work:')
    lines.push('  - When an AI reviewer FAILs, the current action is blocked until the issue is addressed.')
    lines.push('  - A backchannel directory is created where you can appeal the decision.')
    lines.push('  - Write your reasoning in the backchannel README.md — the reviewer reads it on the next run.')
    lines.push('  - Reviewers assume good faith and consider broader context you provide.')
    lines.push('  - A supervisory process audits appeals for honesty — do not attempt to manipulate reviewers.')
  }

  return lines.join('\n').trimEnd()
}

module.exports = { renderBriefing, eventLabel, whenDescription, taskLine, timeAgo }
