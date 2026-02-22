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
  done: 'When you complete a coherent unit of work, run `prove_it signal done` to trigger verification. Include this as a step in your plans.',
  stuck: 'When blocked or stuck, run `prove_it signal stuck` to request intervention.'
}

function signalDirective (type) {
  return SIGNAL_DIRECTIVES[type] || `When ready, run \`prove_it signal ${type}\`.`
}

function taskLine (task) {
  if (task.type === 'script') {
    return `${task.name}—runs \`${task.command || '(no command)'}\``
  }
  if (task.type === 'agent') {
    const whenDesc = whenDescription(task.when)
    return whenDesc
      ? `${task.name}—AI reviewer (${whenDesc})`
      : `${task.name}—AI reviewer`
  }
  if (task.type === 'env') {
    return `${task.name}—sets environment variables`
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

  // Signaling instructions—only if signal-gated tasks exist
  const signalTypes = new Set()
  const signalGatedTasks = []
  for (const entry of sorted) {
    for (const task of (entry.tasks || [])) {
      const clauses = Array.isArray(task.when) ? task.when : (task.when ? [task.when] : [])
      for (const clause of clauses) {
        if (clause.signal) {
          signalTypes.add(clause.signal)
          signalGatedTasks.push(task)
          break // one match per task is enough
        }
      }
    }
  }
  if (signalTypes.size > 0) {
    const types = Array.from(signalTypes).sort()
    lines.push('Signaling:')
    lines.push('  Signal-gated tasks:')
    for (const task of signalGatedTasks) {
      const runKey = (task.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
      const lastAt = runs[runKey]?.at
      lines.push(`    ${task.name}—last ran ${timeAgo(lastAt)}`)
    }
    for (const type of types) {
      lines.push(`  - ${signalDirective(type)}`)
    }
    lines.push('  - To clear the active signal, run `prove_it signal clear`.')
    lines.push('  - If a reviewer finds significant issues, re-signal after fixing them.')
    lines.push('')
  }

  // How reviews work—only if agent tasks exist
  if (hasAgentTasks) {
    lines.push('How reviews work:')
    lines.push('  - When an AI reviewer FAILs, the current action is blocked until the issue is addressed.')
    lines.push('  - A backchannel directory is created where you can appeal the decision.')
    lines.push('  - Write your reasoning in the backchannel README.md—the reviewer reads it on the next run.')
    lines.push('  - Reviewers assume good faith and consider broader context you provide.')
    lines.push('  - A supervisory process audits appeals for honesty—do not attempt to manipulate reviewers.')
  }

  return lines.join('\n').trimEnd()
}

module.exports = { renderBriefing, eventLabel, whenDescription, taskLine, timeAgo, signalDirective }
