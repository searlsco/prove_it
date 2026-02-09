'use strict'

const CURRENT_VERSION = 3

const CLAUDE_EVENTS = ['PreToolUse', 'Stop', 'SessionStart']
const GIT_EVENTS = ['pre-commit', 'pre-push']
const VALID_TASK_TYPES = ['script', 'agent']
const VALID_WHEN_KEYS = ['fileExists', 'envSet', 'envNotSet']

const KNOWN_TOP_LEVEL_KEYS = [
  'configVersion', 'enabled', 'sources', 'format', 'hooks'
]
const KNOWN_HOOK_KEYS = [
  'type', 'event', 'tasks', 'matcher', 'triggers', 'source'
]
const KNOWN_TASK_KEYS = [
  'name', 'type', 'command', 'prompt', 'when', 'timeout', 'mtime'
]

/**
 * Validate a prove_it config object.
 * @param {object} cfg
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateConfig (cfg) {
  const errors = []
  const warnings = []

  if (!cfg || typeof cfg !== 'object') {
    errors.push('Config must be a JSON object')
    return { errors, warnings }
  }

  // --- Version check (short-circuits on failure) ---
  if (cfg.configVersion === undefined) {
    errors.push(
      'Missing "configVersion". Add "configVersion": 3 to your config.'
    )
    return { errors, warnings }
  }
  if (cfg.configVersion !== CURRENT_VERSION) {
    const msg = cfg.configVersion === 2
      ? 'configVersion is 2, but version 3 is now required. v3 changes:\n' +
        '    - "checks" was renamed to "tasks" (inside each hook entry)\n' +
        '    - "mode" was removed (delete it if present)\n' +
        '    Update configVersion to 3 after making these changes.'
      : `configVersion is ${cfg.configVersion}, but version ${CURRENT_VERSION} is required.`
    errors.push(msg)
    return { errors, warnings }
  }

  // --- Legacy keys ---
  if ('mode' in cfg) {
    errors.push('"mode" was removed in v3. Delete it from your config.')
  }
  if ('checks' in cfg) {
    errors.push('Top-level "checks" is not valid. Did you mean "hooks" with "tasks" inside each entry?')
  }

  // --- Unknown top-level keys ---
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_TOP_LEVEL_KEYS.includes(key)) {
      warnings.push(`Unknown top-level key "${key}" (ignored)`)
    }
  }

  // --- Top-level field types ---
  if ('enabled' in cfg && typeof cfg.enabled !== 'boolean') {
    errors.push('"enabled" must be a boolean (true or false)')
  }

  if ('sources' in cfg && cfg.sources !== null) {
    if (!Array.isArray(cfg.sources)) {
      errors.push('"sources" must be an array of glob strings')
    } else {
      for (let i = 0; i < cfg.sources.length; i++) {
        if (typeof cfg.sources[i] !== 'string') {
          errors.push(`sources[${i}] must be a string`)
        }
      }
    }
  }

  if ('format' in cfg) {
    if (typeof cfg.format !== 'object' || cfg.format === null || Array.isArray(cfg.format)) {
      errors.push('"format" must be an object')
    } else if ('maxOutputChars' in cfg.format) {
      if (typeof cfg.format.maxOutputChars !== 'number' || cfg.format.maxOutputChars <= 0) {
        errors.push('format.maxOutputChars must be a positive number')
      }
    }
  }

  // --- hooks ---
  if (!('hooks' in cfg)) {
    errors.push('"hooks" is required')
    return { errors, warnings }
  }
  if (!Array.isArray(cfg.hooks)) {
    errors.push('"hooks" must be an array')
    return { errors, warnings }
  }

  for (let i = 0; i < cfg.hooks.length; i++) {
    validateHookEntry(cfg.hooks[i], i, errors, warnings)
  }

  return { errors, warnings }
}

function validateHookEntry (entry, idx, errors, warnings) {
  const prefix = `hooks[${idx}]`

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${prefix} must be an object`)
    return
  }

  // Unknown keys
  for (const key of Object.keys(entry)) {
    if (!KNOWN_HOOK_KEYS.includes(key)) {
      warnings.push(`${prefix} has unknown key "${key}" (ignored)`)
    }
  }

  // type
  if (!entry.type) {
    errors.push(`${prefix} is missing "type" (must be "claude" or "git")`)
  } else if (entry.type !== 'claude' && entry.type !== 'git') {
    errors.push(`${prefix} has invalid type "${entry.type}" (must be "claude" or "git")`)
  }

  // event
  if (!entry.event) {
    errors.push(`${prefix} is missing "event"`)
  } else if (entry.type === 'claude' && !CLAUDE_EVENTS.includes(entry.event)) {
    errors.push(`${prefix} has invalid claude event "${entry.event}" (must be one of: ${CLAUDE_EVENTS.join(', ')})`)
  } else if (entry.type === 'git' && !GIT_EVENTS.includes(entry.event)) {
    errors.push(`${prefix} has invalid git event "${entry.event}" (must be one of: ${GIT_EVENTS.join(', ')})`)
  }

  // Legacy checks key
  if ('checks' in entry) {
    errors.push(`${prefix} has "checks" instead of "tasks". Rename to "tasks" (v3 change).`)
  }

  // tasks
  if (!('tasks' in entry)) {
    if (!('checks' in entry)) {
      errors.push(`${prefix} is missing "tasks"`)
    }
  } else if (!Array.isArray(entry.tasks)) {
    errors.push(`${prefix}.tasks must be an array`)
  } else {
    for (let j = 0; j < entry.tasks.length; j++) {
      validateTask(entry.tasks[j], idx, j, errors, warnings)
    }
  }

  // matcher/triggers/source warnings for wrong event type
  if (entry.matcher && entry.event && entry.event !== 'PreToolUse') {
    warnings.push(`${prefix} has "matcher" but event is "${entry.event}" (matcher only applies to PreToolUse)`)
  }
  if (entry.triggers && entry.event && entry.event !== 'PreToolUse') {
    warnings.push(`${prefix} has "triggers" but event is "${entry.event}" (triggers only applies to PreToolUse)`)
  }
  if (entry.source && entry.event && entry.event !== 'SessionStart') {
    warnings.push(`${prefix} has "source" but event is "${entry.event}" (source only applies to SessionStart)`)
  }
}

function validateTask (task, hookIdx, taskIdx, errors, warnings) {
  const prefix = `hooks[${hookIdx}].tasks[${taskIdx}]`

  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    errors.push(`${prefix} must be an object`)
    return
  }

  // Unknown keys
  for (const key of Object.keys(task)) {
    if (!KNOWN_TASK_KEYS.includes(key)) {
      warnings.push(`${prefix} has unknown key "${key}" (ignored)`)
    }
  }

  // name
  if (!task.name || typeof task.name !== 'string') {
    errors.push(`${prefix} is missing "name" (must be a non-empty string)`)
  }

  // type
  if (!task.type) {
    errors.push(`${prefix} is missing "type" (must be "script" or "agent")`)
  } else if (!VALID_TASK_TYPES.includes(task.type)) {
    errors.push(`${prefix} has invalid type "${task.type}" (must be "script" or "agent")`)
  } else if (task.type === 'script') {
    if (!task.command || typeof task.command !== 'string') {
      errors.push(`${prefix} is type "script" but has no "command"`)
    }
  } else if (task.type === 'agent') {
    if (!task.prompt || typeof task.prompt !== 'string') {
      errors.push(`${prefix} is type "agent" but has no "prompt"`)
    }
  }

  // when
  if ('when' in task) {
    if (!task.when || typeof task.when !== 'object' || Array.isArray(task.when)) {
      errors.push(`${prefix}.when must be an object`)
    } else {
      for (const key of Object.keys(task.when)) {
        if (!VALID_WHEN_KEYS.includes(key)) {
          errors.push(`${prefix}.when has unknown key "${key}" (valid: ${VALID_WHEN_KEYS.join(', ')})`)
        } else if (typeof task.when[key] !== 'string') {
          errors.push(`${prefix}.when.${key} must be a string`)
        }
      }
    }
  }

  // timeout
  if ('timeout' in task) {
    if (typeof task.timeout !== 'number' || task.timeout <= 0) {
      errors.push(`${prefix}.timeout must be a positive number`)
    }
  }

  // mtime
  if ('mtime' in task) {
    if (typeof task.mtime !== 'boolean') {
      errors.push(`${prefix}.mtime must be a boolean`)
    }
  }
}

/**
 * Format validation errors into a human-readable message.
 * @param {{ errors: string[], warnings: string[] }} result
 * @returns {string}
 */
function formatErrors (result) {
  const lines = ['prove_it: invalid config', '']
  for (const err of result.errors) {
    // Indent multi-line errors properly
    const indented = err.split('\n').map((l, i) => i === 0 ? `  - ${l}` : `    ${l}`).join('\n')
    lines.push(indented)
  }
  lines.push('')
  lines.push('Fix these errors, or ask your Claude Code agent:')
  lines.push('  "Fix the prove_it config errors in .claude/prove_it.json"')
  return lines.join('\n')
}

module.exports = { validateConfig, formatErrors, CURRENT_VERSION }
