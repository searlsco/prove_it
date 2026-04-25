const fs = require('fs')
const path = require('path')

const CONFIG_DIR = '.prove_it'
const CONFIG_FILE = 'config.json'
const SCHEMA_VERSION = 1

const TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'profile_version',
  'tasks',
  'agent_workflows'
])
const AGENT_WORKFLOW_KEYS = new Set(['pre_tool'])
const TASK_KEYS = new Set(['type', 'protected_paths'])
const TASK_TYPES = new Set(['config_guard'])

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertPlainObject (value, label, filePath) {
  if (!isPlainObject(value)) {
    throw new Error(`${filePath}: ${label} must be an object`)
  }
}

function assertKnownKeys (value, allowed, label, filePath) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${filePath}: unknown ${label} key "${key}"`)
    }
  }
}

function validateStringArray (value, label, filePath) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${filePath}: ${label} must be an array of strings`)
  }
}

function validateTask (name, task, filePath) {
  assertPlainObject(task, `tasks.${name}`, filePath)
  assertKnownKeys(task, TASK_KEYS, `tasks.${name}`, filePath)

  if (!TASK_TYPES.has(task.type)) {
    throw new Error(`${filePath}: tasks.${name}.type must be "config_guard"`)
  }

  if (task.protected_paths !== undefined) {
    validateStringArray(task.protected_paths, `tasks.${name}.protected_paths`, filePath)
  }
}

function validateConfig (config, filePath) {
  assertPlainObject(config, 'config', filePath)
  assertKnownKeys(config, TOP_LEVEL_KEYS, 'top-level', filePath)

  if (config.schema_version !== SCHEMA_VERSION) {
    throw new Error(`${filePath}: schema_version must be ${SCHEMA_VERSION}`)
  }

  if (config.profile_version !== undefined && typeof config.profile_version !== 'string') {
    throw new Error(`${filePath}: profile_version must be a string`)
  }

  assertPlainObject(config.tasks, 'tasks', filePath)
  assertPlainObject(config.agent_workflows, 'agent_workflows', filePath)
  assertKnownKeys(config.agent_workflows, AGENT_WORKFLOW_KEYS, 'agent_workflows', filePath)

  const preTool = config.agent_workflows.pre_tool || []
  validateStringArray(preTool, 'agent_workflows.pre_tool', filePath)

  for (const [name, task] of Object.entries(config.tasks)) {
    validateTask(name, task, filePath)
  }

  for (const taskName of preTool) {
    if (!Object.prototype.hasOwnProperty.call(config.tasks, taskName)) {
      throw new Error(`${filePath}: agent_workflows.pre_tool references unknown task "${taskName}"`)
    }
  }

  return {
    schema_version: config.schema_version,
    profile_version: config.profile_version || null,
    tasks: config.tasks,
    agent_workflows: {
      pre_tool: preTool
    }
  }
}

function projectConfigPath (cwd) {
  return path.join(cwd, CONFIG_DIR, CONFIG_FILE)
}

function loadProjectConfig (cwd) {
  const configPath = projectConfigPath(cwd)
  if (!fs.existsSync(configPath)) return null

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`${configPath}: failed to parse JSON: ${error.message}`)
  }

  return validateConfig(parsed, configPath)
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  SCHEMA_VERSION,
  loadProjectConfig,
  projectConfigPath,
  validateConfig
}
