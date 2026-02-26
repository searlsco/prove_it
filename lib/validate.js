'use strict'

// TaskCompleted is intentionally omitted—handled at infrastructure level only (see dispatcher/claude.js)
const CLAUDE_EVENTS = ['PreToolUse', 'Stop', 'SessionStart']
const GIT_EVENTS = ['pre-commit', 'pre-push']
const VALID_TASK_TYPES = ['script', 'agent', 'env']
const VALID_WHEN_KEYS = ['fileExists', 'envSet', 'envNotSet', 'variablesPresent', 'linesChanged', 'linesWritten', 'sourcesModifiedSinceLastRun', 'toolsUsed', 'sourceFilesEditedThisTurn', 'signal']

const KNOWN_TOP_LEVEL_KEYS = [
  'enabled', 'sources', 'format', 'taskEnv', 'hooks', 'runs', 'initSeed', 'fileEditingTools', 'model', 'ignoredPaths'
]
const KNOWN_HOOK_KEYS = [
  'type', 'event', 'tasks', 'matcher', 'triggers', 'source'
]
const KNOWN_TASK_KEYS = [
  'name', 'type', 'command', 'prompt', 'promptType', 'when', 'timeout', 'model', 'ruleFile', 'enabled', 'resetOnFail', 'quiet', 'async'
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

  // --- Legacy keys ---
  if ('mode' in cfg) {
    errors.push('"mode" is not supported. Delete it from your config.')
  }
  if ('checks' in cfg) {
    errors.push('Top-level "checks" is not valid. Did you mean "hooks" with "tasks" inside each entry?')
  }

  // --- Unknown top-level keys ---
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_TOP_LEVEL_KEYS.includes(key)) {
      errors.push(`Unknown key "${key}". Supported keys: ${KNOWN_TOP_LEVEL_KEYS.join(', ')}`)
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

  if ('fileEditingTools' in cfg) {
    if (!Array.isArray(cfg.fileEditingTools)) {
      errors.push('"fileEditingTools" must be an array of strings')
    } else {
      for (let i = 0; i < cfg.fileEditingTools.length; i++) {
        if (typeof cfg.fileEditingTools[i] !== 'string') {
          errors.push(`fileEditingTools[${i}] must be a string`)
        }
      }
    }
  }

  if ('model' in cfg) {
    if (typeof cfg.model !== 'string' || !cfg.model.trim()) {
      errors.push('"model" must be a non-empty string')
    } else {
      const hasAgentTask = Array.isArray(cfg.hooks) && cfg.hooks.some(h =>
        Array.isArray(h.tasks) && h.tasks.some(t => t.type === 'agent')
      )
      if (!hasAgentTask) {
        warnings.push('"model" is set but no agent tasks were found (model only applies to agent tasks)')
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

  // --- taskEnv ---
  if ('taskEnv' in cfg) {
    if (typeof cfg.taskEnv !== 'object' || cfg.taskEnv === null || Array.isArray(cfg.taskEnv)) {
      errors.push('"taskEnv" must be an object mapping variable names to string values')
    } else {
      for (const key of Object.keys(cfg.taskEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          errors.push(`taskEnv key "${key}" is not a valid environment variable name`)
        }
        if (typeof cfg.taskEnv[key] !== 'string') {
          errors.push(`taskEnv["${key}"] must be a string`)
        }
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
      errors.push(`${prefix} has unknown key "${key}". Supported keys: ${KNOWN_HOOK_KEYS.join(', ')}`)
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
    errors.push(`${prefix} has "checks" instead of "tasks". Rename "checks" to "tasks".`)
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
      validateTask(entry.tasks[j], idx, j, errors, warnings, entry.event, entry.type)
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

function validateTask (task, hookIdx, taskIdx, errors, warnings, hookEvent, hookType) {
  const prefix = `hooks[${hookIdx}].tasks[${taskIdx}]`

  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    errors.push(`${prefix} must be an object`)
    return
  }

  // Unknown keys
  for (const key of Object.keys(task)) {
    if (!KNOWN_TASK_KEYS.includes(key)) {
      errors.push(`${prefix} has unknown key "${key}". Supported keys: ${KNOWN_TASK_KEYS.join(', ')}`)
    }
  }

  // name
  if (!task.name || typeof task.name !== 'string') {
    errors.push(`${prefix} is missing "name" (must be a non-empty string)`)
  }

  // type
  if (!task.type) {
    errors.push(`${prefix} is missing "type" (must be "script", "agent", or "env")`)
  } else if (!VALID_TASK_TYPES.includes(task.type)) {
    errors.push(`${prefix} has invalid type "${task.type}" (must be "script", "agent", or "env")`)
  } else if (task.type === 'script') {
    if (!task.command || typeof task.command !== 'string') {
      errors.push(`${prefix} is type "script" but has no "command"`)
    }
  } else if (task.type === 'agent') {
    if (!task.prompt || typeof task.prompt !== 'string') {
      errors.push(`${prefix} is type "agent" but has no "prompt"`)
    }
    if ('promptType' in task) {
      if (task.promptType !== 'string' && task.promptType !== 'skill') {
        errors.push(`${prefix}.promptType must be "string" or "skill"`)
      }
    }
  } else if (task.type === 'env') {
    if (!task.command || typeof task.command !== 'string') {
      errors.push(`${prefix} is type "env" but has no "command"`)
    }
    if (hookEvent && hookEvent !== 'SessionStart') {
      errors.push(`${prefix} is type "env" but hook event is "${hookEvent}" (env tasks are only valid in SessionStart hooks)`)
    }
  }

  // when
  if ('when' in task) {
    if (Array.isArray(task.when)) {
      if (task.when.length === 0) {
        errors.push(`${prefix}.when array must not be empty`)
      } else {
        for (let w = 0; w < task.when.length; w++) {
          validateWhenClause(task.when[w], `${prefix}.when[${w}]`, errors, warnings, hookEvent, hookType)
        }
      }
    } else if (!task.when || typeof task.when !== 'object') {
      errors.push(`${prefix}.when must be an object or array of objects`)
    } else {
      validateWhenClause(task.when, `${prefix}.when`, errors, warnings, hookEvent, hookType)
    }
  }

  // timeout
  if ('timeout' in task) {
    if (typeof task.timeout !== 'number' || task.timeout <= 0) {
      errors.push(`${prefix}.timeout must be a positive number`)
    }
  }

  // enabled
  if ('enabled' in task) {
    if (typeof task.enabled !== 'boolean') {
      errors.push(`${prefix}.enabled must be a boolean`)
    }
  }

  // resetOnFail
  if ('resetOnFail' in task) {
    if (typeof task.resetOnFail !== 'boolean') {
      errors.push(`${prefix}.resetOnFail must be a boolean`)
    }
  }

  // quiet
  if ('quiet' in task) {
    if (typeof task.quiet !== 'boolean') {
      errors.push(`${prefix}.quiet must be a boolean`)
    }
  }

  // async
  if ('async' in task) {
    if (typeof task.async !== 'boolean') {
      errors.push(`${prefix}.async must be a boolean`)
    } else if (task.async === true && hookEvent === 'SessionStart') {
      warnings.push(`${prefix} has "async: true" but hook event is "SessionStart" (SessionStart never blocks, so async has no effect)`)
    }
  }

  // model
  if ('model' in task) {
    if (typeof task.model !== 'string' || !task.model.trim()) {
      errors.push(`${prefix}.model must be a non-empty string`)
    } else if (task.type && task.type !== 'agent') {
      warnings.push(`${prefix} has "model" but type is "${task.type}" (model only applies to agent tasks)`)
    }
  }

  // ruleFile
  if ('ruleFile' in task) {
    if (typeof task.ruleFile !== 'string' || !task.ruleFile.trim()) {
      errors.push(`${prefix}.ruleFile must be a non-empty string`)
    } else if (task.type && task.type !== 'agent') {
      warnings.push(`${prefix} has "ruleFile" but type is "${task.type}" (ruleFile only applies to agent tasks)`)
    }
  }
}

function validateWhenClause (clause, prefix, errors, warnings, hookEvent, hookType) {
  if (!clause || typeof clause !== 'object' || Array.isArray(clause)) {
    errors.push(`${prefix} must be an object`)
    return
  }

  for (const key of Object.keys(clause)) {
    if (!VALID_WHEN_KEYS.includes(key)) {
      errors.push(`${prefix} has unknown key "${key}". Supported keys: ${VALID_WHEN_KEYS.join(', ')}`)
    }
  }

  if ('fileExists' in clause && typeof clause.fileExists !== 'string') {
    errors.push(`${prefix}.fileExists must be a string`)
  }
  if ('envSet' in clause && typeof clause.envSet !== 'string') {
    errors.push(`${prefix}.envSet must be a string`)
  }
  if ('envNotSet' in clause && typeof clause.envNotSet !== 'string') {
    errors.push(`${prefix}.envNotSet must be a string`)
  }
  if ('signal' in clause) {
    const { VALID_SIGNALS } = require('./session')
    if (typeof clause.signal !== 'string' || !VALID_SIGNALS.includes(clause.signal)) {
      errors.push(`${prefix}.signal must be one of: ${VALID_SIGNALS.join(', ')}`)
    }
    if (hookType === 'git') {
      warnings.push(`${prefix} has "signal" but hook type is "git" (signal only applies to claude Stop hooks)`)
    } else if (hookEvent && hookEvent !== 'Stop') {
      warnings.push(`${prefix} has "signal" but hook event is "${hookEvent}" (signal only applies to Stop hooks)`)
    }
  }
  if ('linesChanged' in clause) {
    if (typeof clause.linesChanged !== 'number' || clause.linesChanged <= 0) {
      errors.push(`${prefix}.linesChanged must be a positive number`)
    }
  }
  if ('linesWritten' in clause) {
    if (typeof clause.linesWritten !== 'number' || clause.linesWritten <= 0) {
      errors.push(`${prefix}.linesWritten must be a positive number`)
    }
    if (hookType === 'git') {
      warnings.push(`${prefix} has "linesWritten" but hook type is "git" (linesWritten is session-based and only applies to claude hooks)`)
    }
  }
  if ('sourcesModifiedSinceLastRun' in clause && typeof clause.sourcesModifiedSinceLastRun !== 'boolean') {
    errors.push(`${prefix}.sourcesModifiedSinceLastRun must be a boolean`)
  }
  if ('sourceFilesEditedThisTurn' in clause) {
    if (typeof clause.sourceFilesEditedThisTurn !== 'boolean') {
      errors.push(`${prefix}.sourceFilesEditedThisTurn must be a boolean`)
    }
    if (hookType === 'git') {
      warnings.push(`${prefix} has "sourceFilesEditedThisTurn" but hook type is "git" (sourceFilesEditedThisTurn only applies to claude hooks)`)
    }
  }
  if ('toolsUsed' in clause) {
    if (!Array.isArray(clause.toolsUsed)) {
      errors.push(`${prefix}.toolsUsed must be an array of strings`)
    } else {
      for (let i = 0; i < clause.toolsUsed.length; i++) {
        if (typeof clause.toolsUsed[i] !== 'string') {
          errors.push(`${prefix}.toolsUsed[${i}] must be a string`)
        }
      }
    }
    if (hookType === 'git') {
      warnings.push(`${prefix} has "toolsUsed" but hook type is "git" (toolsUsed only applies to claude hooks)`)
    }
  }
  if ('variablesPresent' in clause) {
    if (!Array.isArray(clause.variablesPresent)) {
      errors.push(`${prefix}.variablesPresent must be an array of strings`)
    } else {
      const { KNOWN_VARS } = require('./template')
      for (let i = 0; i < clause.variablesPresent.length; i++) {
        if (typeof clause.variablesPresent[i] !== 'string') {
          errors.push(`${prefix}.variablesPresent[${i}] must be a string`)
        } else if (!KNOWN_VARS.includes(clause.variablesPresent[i])) {
          errors.push(`${prefix}.variablesPresent references unknown variable "${clause.variablesPresent[i]}" (available: ${KNOWN_VARS.join(', ')})`)
        }
      }
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
  lines.push('Things are moving fast pre-1.0. To reset your setup:')
  lines.push('  prove_it reinstall && prove_it reinit')
  return lines.join('\n')
}

module.exports = { validateConfig, formatErrors }
