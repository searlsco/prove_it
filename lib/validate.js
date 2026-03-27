'use strict'

// TaskCompleted is intentionally omitted—handled at infrastructure level only (see dispatcher/claude.js)
const CLAUDE_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionStart']
const GIT_EVENTS = ['pre-commit', 'pre-push']
const VALID_HOOK_TYPES = ['claude', 'git']
const VALID_TASK_TYPES = ['script', 'agent', 'env']
const VALID_WHEN_KEYS = ['fileExists', 'envSet', 'envNotSet', 'variablesPresent', 'linesChanged', 'linesWritten', 'sourcesModifiedSinceLastRun', 'toolsUsed', 'sourceFilesEditedThisTurn', 'signal', 'phase']

const KNOWN_TOP_LEVEL_KEYS = [
  'enabled', 'sources', 'tests', 'testCommands', 'format', 'taskEnv', 'taskAllowedTools', 'taskBypassPermissions', 'hooks', 'runs', 'initSeed', 'fileEditingTools', 'model', 'maxAgentTurns', 'ignoredPaths'
]
const KNOWN_TASK_KEYS = [
  'name', 'type', 'command', 'prompt', 'promptType', 'when', 'timeout', 'model', 'maxAgentTurns', 'ruleFile', 'enabled', 'resetOnFail', 'quiet', 'async', 'parallel', 'params', 'briefing', 'matcher', 'source', 'triggers'
]

function allTasks (hooks) {
  if (!hooks || typeof hooks !== 'object') return []
  const tasks = []
  for (const type of Object.keys(hooks)) {
    const events = hooks[type]
    if (!events || typeof events !== 'object') continue
    for (const event of Object.keys(events)) {
      const arr = events[event]
      if (Array.isArray(arr)) tasks.push(...arr)
    }
  }
  return tasks
}

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

  if ('sources' in cfg) {
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

  if ('tests' in cfg) {
    if (!Array.isArray(cfg.tests)) {
      errors.push('"tests" must be an array of glob strings')
    } else {
      for (let i = 0; i < cfg.tests.length; i++) {
        if (typeof cfg.tests[i] !== 'string') {
          errors.push(`tests[${i}] must be a string`)
        }
      }
    }
  }

  if ('testCommands' in cfg) {
    if (!Array.isArray(cfg.testCommands)) {
      errors.push('"testCommands" must be an array of strings')
    } else {
      for (let i = 0; i < cfg.testCommands.length; i++) {
        if (typeof cfg.testCommands[i] !== 'string') {
          errors.push(`testCommands[${i}] must be a string`)
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
      const hasAgentTask = allTasks(cfg.hooks).some(t => t.type === 'agent')
      if (!hasAgentTask) {
        warnings.push('"model" is set but no agent tasks were found (model only applies to agent tasks)')
      }
    }
  }

  if ('maxAgentTurns' in cfg) {
    if (typeof cfg.maxAgentTurns !== 'number' || !Number.isInteger(cfg.maxAgentTurns) || cfg.maxAgentTurns <= 0) {
      errors.push('"maxAgentTurns" must be a positive integer')
    } else {
      const hasAgentTask = allTasks(cfg.hooks).some(t => t.type === 'agent')
      if (!hasAgentTask) {
        warnings.push('"maxAgentTurns" is set but no agent tasks were found (maxAgentTurns only applies to agent tasks)')
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

  // --- taskAllowedTools / taskBypassPermissions ---
  if ('taskAllowedTools' in cfg) {
    if (!Array.isArray(cfg.taskAllowedTools)) {
      errors.push('"taskAllowedTools" must be an array of strings')
    } else {
      for (let i = 0; i < cfg.taskAllowedTools.length; i++) {
        if (typeof cfg.taskAllowedTools[i] !== 'string') {
          errors.push(`taskAllowedTools[${i}] must be a string`)
        }
      }
    }
  }
  if ('taskBypassPermissions' in cfg && typeof cfg.taskBypassPermissions !== 'boolean') {
    errors.push('"taskBypassPermissions" must be a boolean')
  }

  // --- hooks ---
  if (!('hooks' in cfg)) {
    errors.push('"hooks" is required')
    return { errors, warnings }
  }

  if (Array.isArray(cfg.hooks)) {
    errors.push('"hooks" must be an object, not an array.\n\nThe hooks schema changed: hooks is now a two-level object keyed by\ntype (claude, git) and then event name, with tasks as the value.\n\nTo reset to defaults:\n  prove_it reinstall && prove_it reinit\n\nIf you have custom tasks you want to preserve, give this prompt to\nyour agent:\n\n  My prove_it config at .claude/prove_it/config.json uses the old\n  array-based hooks schema. Please migrate it to the new object-keyed\n  schema where hooks is structured as\n  { claude: { EventName: [tasks] }, git: { event: [tasks] } }\n  and matchers/source/triggers move from the hook entry to the task\n  level. Preserve all my custom tasks and their settings.')
    return { errors, warnings }
  }

  if (typeof cfg.hooks !== 'object' || cfg.hooks === null) {
    errors.push('"hooks" must be an object')
    return { errors, warnings }
  }

  // Validate hook type keys
  for (const hookType of Object.keys(cfg.hooks)) {
    if (!VALID_HOOK_TYPES.includes(hookType)) {
      errors.push(`hooks has unknown type "${hookType}" (must be "claude" or "git")`)
      continue
    }

    const events = cfg.hooks[hookType]
    if (!events || typeof events !== 'object' || Array.isArray(events)) {
      errors.push(`hooks.${hookType} must be an object mapping event names to task arrays`)
      continue
    }

    const validEvents = hookType === 'claude' ? CLAUDE_EVENTS : GIT_EVENTS
    for (const event of Object.keys(events)) {
      if (!validEvents.includes(event)) {
        errors.push(`hooks.${hookType} has invalid event "${event}" (must be one of: ${validEvents.join(', ')})`)
        continue
      }

      const tasks = events[event]
      if (!Array.isArray(tasks)) {
        errors.push(`hooks.${hookType}.${event} must be an array of tasks`)
        continue
      }

      for (let j = 0; j < tasks.length; j++) {
        validateTask(tasks[j], hookType, event, j, errors, warnings)
      }
    }
  }

  return { errors, warnings }
}

function validateTask (task, hookType, hookEvent, taskIdx, errors, warnings) {
  const prefix = `hooks.${hookType}.${hookEvent}[${taskIdx}]`

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

  // matcher/triggers/source warnings for wrong event type
  const matcherEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']
  if (task.matcher && hookEvent && !matcherEvents.includes(hookEvent)) {
    warnings.push(`${prefix} has "matcher" but event is "${hookEvent}" (matcher only applies to PreToolUse, PostToolUse, PostToolUseFailure)`)
  }
  if (task.triggers && hookEvent && hookEvent !== 'PreToolUse') {
    warnings.push(`${prefix} has "triggers" but event is "${hookEvent}" (triggers only applies to PreToolUse)`)
  }
  if (task.source && hookEvent && hookEvent !== 'SessionStart') {
    warnings.push(`${prefix} has "source" but event is "${hookEvent}" (source only applies to SessionStart)`)
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

  // parallel
  if ('parallel' in task) {
    if (typeof task.parallel !== 'boolean') {
      errors.push(`${prefix}.parallel must be a boolean`)
    } else if (task.parallel === true) {
      if (hookEvent === 'SessionStart') {
        warnings.push(`${prefix} has "parallel: true" but hook event is "SessionStart" (SessionStart never blocks, so parallel has no effect)`)
      }
      if (hookEvent === 'PreToolUse') {
        warnings.push(`${prefix} has "parallel: true" but hook event is "PreToolUse" (parallel adds overhead for quick checks)`)
      }
      if (task.async === true) {
        errors.push(`${prefix} has both "async: true" and "parallel: true" (they are mutually exclusive—async is fire-and-forget, parallel is fork-and-await)`)
      }
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

  // maxAgentTurns
  if ('maxAgentTurns' in task) {
    if (typeof task.maxAgentTurns !== 'number' || !Number.isInteger(task.maxAgentTurns) || task.maxAgentTurns <= 0) {
      errors.push(`${prefix}.maxAgentTurns must be a positive integer`)
    } else if (task.type && task.type !== 'agent') {
      warnings.push(`${prefix} has "maxAgentTurns" but type is "${task.type}" (maxAgentTurns only applies to agent tasks)`)
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

  // briefing
  if ('briefing' in task) {
    if (typeof task.briefing !== 'string') {
      errors.push(`${prefix}.briefing must be a string`)
    }
  }

  // params
  if ('params' in task) {
    if (typeof task.params !== 'object' || task.params === null || Array.isArray(task.params)) {
      errors.push(`${prefix}.params must be a plain object`)
    } else if (task.type && task.type !== 'script') {
      warnings.push(`${prefix} has "params" but type is "${task.type}" (params only applies to script tasks)`)
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
  if ('phase' in clause) {
    const { VALID_PHASES } = require('./session')
    if (typeof clause.phase !== 'string' || !VALID_PHASES.includes(clause.phase)) {
      errors.push(`${prefix}.phase must be one of: ${VALID_PHASES.join(', ')}`)
    }
    if (hookType === 'git') {
      warnings.push(`${prefix} has "phase" but hook type is "git" (phase only applies to claude hooks)`)
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
