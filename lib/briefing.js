/**
 * Render a human-readable orientation briefing for Claude Code sessions.
 * Called by the session:briefing builtin on SessionStart.
 *
 * Pure function: takes a merged config, returns a string.
 */

const EVENT_ORDER = ['SessionStart', 'PreToolUse', 'Stop', 'pre-commit', 'pre-push']

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

function renderBriefing (cfg) {
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

module.exports = { renderBriefing, eventLabel, whenDescription, taskLine }
