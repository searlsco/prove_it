'use strict'

const CLAUDE_EVENTS = ['PreToolUse', 'Stop', 'SessionStart']
const GIT_EVENTS = ['pre-commit', 'pre-push']
const VALID_TASK_TYPES = ['script', 'agent', 'env']
const VALID_WHEN_KEYS = ['fileExists', 'envSet', 'envNotSet', 'variablesPresent', 'linesChanged', 'linesWritten', 'sourcesModifiedSinceLastRun', 'toolsUsed', 'sourceFilesEdited']

const KNOWN_TOP_LEVEL_KEYS = [
  'enabled', 'sources', 'format', 'taskEnv', 'hooks', 'runs', 'initSeed', 'fileEditingTools', 'model', 'ignoredPaths'
]
const KNOWN_HOOK_KEYS = [
  'type', 'event', 'tasks', 'matcher', 'triggers', 'source'
]
const KNOWN_TASK_KEYS = [
  'name', 'type', 'command', 'prompt', 'promptType', 'when', 'timeout', 'mtime', 'model', 'ruleFile', 'enabled', 'resetOnFail', 'quiet', 'async'
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
      if (task.promptType !== 'string' && task.promptType !== 'reference') {
        errors.push(`${prefix}.promptType must be "string" or "reference"`)
      } else if (task.promptType === 'reference') {
        const { BUILTIN_PROMPTS } = require('./checks/builtins')
        if (task.prompt && typeof task.prompt === 'string' && !BUILTIN_PROMPTS[task.prompt]) {
          errors.push(`${prefix}.prompt references unknown builtin "${task.prompt}" (available: ${Object.keys(BUILTIN_PROMPTS).join(', ')})`)
        }
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
    if (!task.when || typeof task.when !== 'object' || Array.isArray(task.when)) {
      errors.push(`${prefix}.when must be an object`)
    } else {
      for (const key of Object.keys(task.when)) {
        if (!VALID_WHEN_KEYS.includes(key)) {
          errors.push(`${prefix}.when has unknown key "${key}" (valid: ${VALID_WHEN_KEYS.join(', ')})`)
        } else if (key === 'variablesPresent') {
          const { KNOWN_VARS } = require('./template')
          if (!Array.isArray(task.when.variablesPresent)) {
            errors.push(`${prefix}.when.variablesPresent must be an array of strings`)
          } else {
            for (let k = 0; k < task.when.variablesPresent.length; k++) {
              const v = task.when.variablesPresent[k]
              if (typeof v !== 'string') {
                errors.push(`${prefix}.when.variablesPresent[${k}] must be a string`)
              } else if (!KNOWN_VARS.includes(v)) {
                errors.push(`${prefix}.when.variablesPresent[${k}] has unknown variable "${v}" (valid: ${KNOWN_VARS.join(', ')})`)
              }
            }
          }
        } else if (key === 'linesChanged') {
          if (typeof task.when[key] !== 'number' || task.when[key] <= 0) {
            errors.push(`${prefix}.when.${key} must be a positive number`)
          }
        } else if (key === 'linesWritten') {
          if (typeof task.when[key] !== 'number' || task.when[key] <= 0) {
            errors.push(`${prefix}.when.${key} must be a positive number`)
          }
          if (hookType === 'git') {
            warnings.push(`${prefix} has "linesWritten" but hook type is "git" (this condition requires a Claude Code session for accumulation and will always be 0 in git hooks)`)
          }
        } else if (key === 'sourcesModifiedSinceLastRun') {
          if (typeof task.when[key] !== 'boolean') {
            errors.push(`${prefix}.when.${key} must be a boolean`)
          }
        } else if (key === 'toolsUsed') {
          if (!Array.isArray(task.when[key])) {
            errors.push(`${prefix}.when.${key} must be an array of strings`)
          } else {
            for (let k = 0; k < task.when[key].length; k++) {
              if (typeof task.when[key][k] !== 'string') {
                errors.push(`${prefix}.when.${key}[${k}] must be a string`)
              }
            }
          }
          if (hookType === 'git') {
            warnings.push(`${prefix} has "toolsUsed" but hook type is "git" (this condition requires a Claude Code session and will never fire in git hooks)`)
          }
        } else if (key === 'sourceFilesEdited') {
          if (typeof task.when[key] !== 'boolean') {
            errors.push(`${prefix}.when.${key} must be a boolean`)
          }
          if (hookType === 'git') {
            warnings.push(`${prefix} has "sourceFilesEdited" but hook type is "git" (this condition requires a Claude Code session and will never fire in git hooks)`)
          }
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
