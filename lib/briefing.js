/**
 * Render a human-readable orientation briefing for Claude Code sessions.
 * Called by the session:briefing builtin on SessionStart.
 *
 * Pure function: takes a merged config, returns a string.
 */

const { renderCompletionAccountability, renderSignalDirective } = require('./methodology')

const EVENT_ORDER = ['SessionStart', 'PreToolUse', 'Stop', 'pre-commit', 'pre-push']

function obligationsHeader (methodology) {
  return `# prove_it — Verification Framework

## YOUR OBLIGATIONS (read this first)

prove_it is a supervisory framework running alongside this session. It runs automated checks on your work. You have one key responsibility:

${renderCompletionAccountability({ methodology })}`
}

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

function eventLabel (hookType, event, tasks) {
  if (hookType === 'git') {
    switch (event) {
      case 'pre-commit': return 'On git commit'
      case 'pre-push': return 'On git push'
      default: return `On ${event}`
    }
  }
  switch (event) {
    case 'SessionStart': return 'On session start'
    case 'PreToolUse': {
      // Collect unique matchers from tasks to show what tools are gated
      const matchers = new Set()
      for (const task of tasks) {
        if (task.matcher) {
          for (const m of task.matcher.split('|')) matchers.add(m)
        }
      }
      const tools = matchers.size > 0 ? Array.from(matchers).join(', ') : 'any tool'
      return `Before tool use (${tools})`
    }
    case 'Stop': return 'After each turn'
    default: return event
  }
}

function eventSortKey (event) {
  const idx = EVENT_ORDER.indexOf(event)
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
  if (clause.testFilesEdited) parts.push('when test files are edited')
  if (clause.sourcesModifiedSinceLastRun) parts.push('when sources change since last run')
  if (clause.toolsUsed) parts.push(`when ${clause.toolsUsed.join(', ')} used`)

  return parts.length > 0 ? parts.join(', ') : null
}

function whenDescription (when) {
  if (!when) return null
  const clauses = Array.isArray(when) ? when : [when]
  return clauses.map(c => whenClauseDescription(c)).filter(Boolean).join(' OR ') || null
}

function signalDirective (type, options = {}) {
  return renderSignalDirective(type, options)
}

function taskLine (task) {
  const suffix = task.parallel ? ' (parallel)' : ''
  if (task.type === 'script') {
    return `**${task.name}**—runs \`${task.command || '(no command)'}\`${suffix}`
  }
  if (task.type === 'agent') {
    const whenDesc = whenDescription(task.when)
    return whenDesc
      ? `**${task.name}**—AI reviewer (${whenDesc})${suffix}`
      : `**${task.name}**—AI reviewer${suffix}`
  }
  if (task.type === 'env') {
    return `**${task.name}**—sets environment variables`
  }
  return `**${task.name}**${suffix}`
}

/**
 * Flatten hooks object into a sorted array of { hookType, event, tasks } entries.
 */
function flattenHooks (hooks) {
  if (!hooks || typeof hooks !== 'object') return []
  const entries = []
  for (const hookType of Object.keys(hooks)) {
    const events = hooks[hookType]
    if (!events || typeof events !== 'object') continue
    for (const event of Object.keys(events)) {
      const tasks = events[event]
      if (Array.isArray(tasks) && tasks.length > 0) {
        entries.push({ hookType, event, tasks })
      }
    }
  }
  return entries.sort((a, b) => eventSortKey(a.event) - eventSortKey(b.event))
}

function renderBriefing (cfg, runs, options = {}) {
  if (!runs) runs = {}
  const methodology = options.methodology
  const lines = []

  // Pre-scan: gather structural info before rendering
  const hooks = cfg.hooks || {}
  const sorted = flattenHooks(hooks)

  let hasAgentTasks = false
  let hasDoneSignal = false
  const signalTypes = new Set()
  const signalGatedTasks = []

  for (const entry of sorted) {
    for (const task of entry.tasks) {
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
    lines.push(obligationsHeader(methodology))
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
    const tasks = entry.tasks.filter(t => t.name !== 'session-briefing')
    if (tasks.length === 0) continue

    const label = eventLabel(entry.hookType, entry.event, tasks)
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
      lines.push(`  - ${signalDirective(type, { methodology })}`)
    }
    lines.push('  - If a reviewer finds significant issues, re-signal after fixing them.')
    lines.push('')
  }

  // Handling review failures
  if (hasAgentTasks) {
    lines.push('### Handling review failures')
    lines.push('')
    lines.push('When an AI reviewer FAILs, the current action is blocked until the issue is addressed. A backchannel directory is created where you can appeal:')
    lines.push('')
    lines.push('1. The FAIL message includes the exact path to the backchannel README')
    lines.push('2. Write your reasoning for why the failure should be reconsidered')
    lines.push('3. The reviewer reads the backchannel on its next run and assumes good faith')
    lines.push('')
    lines.push('A supervisory process audits appeals for honesty — do not attempt to manipulate reviewers.')
  }

  return lines.join('\n').trimEnd()
}

module.exports = { renderBriefing, eventLabel, whenDescription, taskLine, timeAgo, signalDirective }
