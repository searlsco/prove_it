const fs = require('fs')
const os = require('os')
const path = require('path')

const CONFIG_DIR = '.prove_it'
const CONFIG_FILE = 'config.json'
const LOCAL_CONFIG_FILE = 'config.local.json'
const SCHEMA_VERSION = 1
const PROFILE_VERSION = 'prove_it.strict.v1'

const DEFAULT_PROTECTED_PATHS = [
  '.prove_it/config.json',
  '.prove_it/config.local.json'
]

const BUILT_IN_PROFILE = Object.freeze({
  name: 'strict',
  profile_version: PROFILE_VERSION,
  config: Object.freeze({
    schema_version: SCHEMA_VERSION,
    project: Object.freeze({}),
    globs: Object.freeze({
      source: Object.freeze([]),
      test: Object.freeze([])
    }),
    tasks: Object.freeze({
      protect_prove_it_config: Object.freeze({
        type: 'config_guard',
        protected_paths: Object.freeze([...DEFAULT_PROTECTED_PATHS])
      })
    }),
    agent_workflows: Object.freeze({
      session_start: Object.freeze([]),
      pre_tool: Object.freeze(['protect_prove_it_config']),
      post_tool: Object.freeze([]),
      post_tool_failure: Object.freeze([]),
      agent_end: Object.freeze([])
    }),
    git_workflows: Object.freeze({
      pre_commit: Object.freeze([]),
      pre_push: Object.freeze([])
    }),
    adapters: Object.freeze({
      pi: Object.freeze({ enabled: false }),
      claude: Object.freeze({ enabled: false })
    })
  })
})

const TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'profile_version',
  'project',
  'globs',
  'tasks',
  'agent_workflows',
  'git_workflows',
  'adapters'
])
const PROJECT_KEYS = new Set(['name'])
const GLOBS_KEYS = new Set(['source', 'test'])
const AGENT_WORKFLOW_KEYS = new Set(['session_start', 'pre_tool', 'post_tool', 'post_tool_failure', 'agent_end'])
const GIT_WORKFLOW_KEYS = new Set(['pre_commit', 'pre_push'])
const PIPELINE_PATCH_KEYS = new Set(['prepend', 'append', 'remove', 'replace_tasks'])
const TASK_COMMON_KEYS = new Set(['type', 'description'])
const TASK_TYPE_KEYS = {
  config_guard: new Set(['protected_paths']),
  script: new Set(['command', 'timeout_ms']),
  agent: new Set(['prompt', 'model'])
}
const TASK_TYPES = new Set(Object.keys(TASK_TYPE_KEYS))
const ADAPTER_KEYS = new Set(['pi', 'claude', 'codex'])
const ADAPTER_CONFIG_KEYS = new Set(['enabled'])

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone (value) {
  return JSON.parse(JSON.stringify(value))
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

function validateOptionalString (value, label, filePath) {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${filePath}: ${label} must be a string`)
  }
}

function mergeObject (base, patch) {
  return { ...(base || {}), ...(patch || {}) }
}

function sourceEntry (kind, filePath, present, extra = {}) {
  return {
    kind,
    path: filePath || null,
    present,
    ...extra
  }
}

function profileSourceEntry () {
  return {
    kind: 'profile',
    name: BUILT_IN_PROFILE.name,
    profile_version: PROFILE_VERSION,
    present: true
  }
}

function resolveConfigPaths (cwd, options = {}) {
  const homeDir = options.homeDir || os.homedir()
  return {
    global: path.join(homeDir, CONFIG_DIR, CONFIG_FILE),
    project: projectConfigPath(cwd),
    local: path.join(cwd, CONFIG_DIR, LOCAL_CONFIG_FILE)
  }
}

function readJsonFile (filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${filePath}: failed to parse JSON: ${error.message}`)
  }
}

function validateProject (project, filePath) {
  if (project === undefined) return {}
  assertPlainObject(project, 'project', filePath)
  assertKnownKeys(project, PROJECT_KEYS, 'project', filePath)
  validateOptionalString(project.name, 'project.name', filePath)
  return { ...project }
}

function validateGlobs (globs, filePath) {
  if (globs === undefined) return {}
  assertPlainObject(globs, 'globs', filePath)
  assertKnownKeys(globs, GLOBS_KEYS, 'globs', filePath)
  if (globs.source !== undefined) validateStringArray(globs.source, 'globs.source', filePath)
  if (globs.test !== undefined) validateStringArray(globs.test, 'globs.test', filePath)
  return { ...globs }
}

function validateTask (name, task, filePath) {
  assertPlainObject(task, `tasks.${name}`, filePath)

  if (!TASK_TYPES.has(task.type)) {
    throw new Error(`${filePath}: tasks.${name}.type must be one of ${Array.from(TASK_TYPES).join(', ')}`)
  }

  const allowed = new Set([...TASK_COMMON_KEYS, ...TASK_TYPE_KEYS[task.type]])
  assertKnownKeys(task, allowed, `tasks.${name}`, filePath)
  validateOptionalString(task.description, `tasks.${name}.description`, filePath)

  if (task.type === 'config_guard') {
    if (task.protected_paths !== undefined) {
      validateStringArray(task.protected_paths, `tasks.${name}.protected_paths`, filePath)
    }
  } else if (task.type === 'script') {
    if (typeof task.command !== 'string' || task.command.length === 0) {
      throw new Error(`${filePath}: tasks.${name}.command must be a non-empty string`)
    }
    if (task.timeout_ms !== undefined && (!Number.isInteger(task.timeout_ms) || task.timeout_ms < 0)) {
      throw new Error(`${filePath}: tasks.${name}.timeout_ms must be a non-negative integer`)
    }
  } else if (task.type === 'agent') {
    if (typeof task.prompt !== 'string' || task.prompt.length === 0) {
      throw new Error(`${filePath}: tasks.${name}.prompt must be a non-empty string`)
    }
    validateOptionalString(task.model, `tasks.${name}.model`, filePath)
  }

  return clone(task)
}

function validateTasks (tasks, filePath) {
  if (tasks === undefined) return {}
  assertPlainObject(tasks, 'tasks', filePath)
  const normalized = {}
  for (const [name, task] of Object.entries(tasks)) {
    normalized[name] = validateTask(name, task, filePath)
  }
  return normalized
}

function normalizePipelinePatch (value, label, filePath) {
  if (value === undefined) return null
  if (Array.isArray(value)) {
    validateStringArray(value, label, filePath)
    return { replace_tasks: [...value] }
  }

  assertPlainObject(value, label, filePath)
  assertKnownKeys(value, PIPELINE_PATCH_KEYS, label, filePath)

  const patch = {}
  for (const key of PIPELINE_PATCH_KEYS) {
    if (value[key] !== undefined) {
      validateStringArray(value[key], `${label}.${key}`, filePath)
      patch[key] = [...value[key]]
    }
  }
  return patch
}

function validateWorkflows (workflows, allowedKeys, label, filePath) {
  if (workflows === undefined) return {}
  assertPlainObject(workflows, label, filePath)
  assertKnownKeys(workflows, allowedKeys, label, filePath)

  const normalized = {}
  for (const [stage, pipeline] of Object.entries(workflows)) {
    const patch = normalizePipelinePatch(pipeline, `${label}.${stage}`, filePath)
    if (patch) normalized[stage] = patch
  }
  return normalized
}

function validateAdapters (adapters, filePath) {
  if (adapters === undefined) return {}
  assertPlainObject(adapters, 'adapters', filePath)
  assertKnownKeys(adapters, ADAPTER_KEYS, 'adapters', filePath)

  const normalized = {}
  for (const [name, adapter] of Object.entries(adapters)) {
    assertPlainObject(adapter, `adapters.${name}`, filePath)
    assertKnownKeys(adapter, ADAPTER_CONFIG_KEYS, `adapters.${name}`, filePath)
    if (adapter.enabled !== undefined && typeof adapter.enabled !== 'boolean') {
      throw new Error(`${filePath}: adapters.${name}.enabled must be a boolean`)
    }
    normalized[name] = { ...adapter }
  }
  return normalized
}

function validateConfig (config, filePath) {
  assertPlainObject(config, 'config', filePath)
  assertKnownKeys(config, TOP_LEVEL_KEYS, 'top-level', filePath)

  if (config.schema_version !== SCHEMA_VERSION) {
    throw new Error(`${filePath}: schema_version must be ${SCHEMA_VERSION}`)
  }

  if (config.profile_version !== PROFILE_VERSION) {
    throw new Error(`${filePath}: profile_version must be ${PROFILE_VERSION}`)
  }

  return {
    schema_version: config.schema_version,
    profile_version: config.profile_version,
    project: validateProject(config.project, filePath),
    globs: validateGlobs(config.globs, filePath),
    tasks: validateTasks(config.tasks, filePath),
    agent_workflows: validateWorkflows(config.agent_workflows, AGENT_WORKFLOW_KEYS, 'agent_workflows', filePath),
    git_workflows: validateWorkflows(config.git_workflows, GIT_WORKFLOW_KEYS, 'git_workflows', filePath),
    adapters: validateAdapters(config.adapters, filePath)
  }
}

function applyPipelinePatch (current, patch) {
  let next = [...(current || [])]
  if (patch.replace_tasks !== undefined) next = [...patch.replace_tasks]
  if (patch.remove !== undefined) {
    const removals = new Set(patch.remove)
    next = next.filter(taskName => !removals.has(taskName))
  }
  if (patch.prepend !== undefined) next = [...patch.prepend, ...next]
  if (patch.append !== undefined) next = [...next, ...patch.append]
  return next
}

function ensureWorkflowContainers (config) {
  config.agent_workflows = config.agent_workflows || {}
  for (const stage of AGENT_WORKFLOW_KEYS) {
    if (!Array.isArray(config.agent_workflows[stage])) config.agent_workflows[stage] = []
  }
  config.git_workflows = config.git_workflows || {}
  for (const stage of GIT_WORKFLOW_KEYS) {
    if (!Array.isArray(config.git_workflows[stage])) config.git_workflows[stage] = []
  }
}

function addLineage (lineage, group, key, entry) {
  if (!lineage[group][key]) lineage[group][key] = []
  lineage[group][key].push(entry)
}

function lineageEntry (source, action, extra = {}) {
  return {
    kind: source.kind,
    path: source.path || null,
    action,
    ...extra
  }
}

function mergeLayer (effective, layer, source, lineage, taskDefinitions) {
  if (Object.keys(layer.project).length > 0) {
    effective.project = mergeObject(effective.project, layer.project)
    addLineage(lineage, 'project', 'project', lineageEntry(source, 'merge', { keys: Object.keys(layer.project) }))
  }

  if (Object.keys(layer.globs).length > 0) {
    effective.globs = mergeObject(effective.globs, layer.globs)
    addLineage(lineage, 'globs', 'globs', lineageEntry(source, 'merge', { keys: Object.keys(layer.globs) }))
  }

  for (const [taskName, task] of Object.entries(layer.tasks)) {
    effective.tasks[taskName] = clone(task)
    if (!taskDefinitions[taskName]) taskDefinitions[taskName] = []
    taskDefinitions[taskName].push(source)
    addLineage(lineage, 'tasks', taskName, lineageEntry(source, 'define'))
  }

  for (const [stage, patch] of Object.entries(layer.agent_workflows)) {
    effective.agent_workflows[stage] = applyPipelinePatch(effective.agent_workflows[stage], patch)
    for (const operation of ['replace_tasks', 'remove', 'prepend', 'append']) {
      if (patch[operation] !== undefined) {
        addLineage(lineage, 'agent_workflows', stage, lineageEntry(source, 'patch', {
          operation,
          tasks: [...patch[operation]]
        }))
      }
    }
  }

  for (const [stage, patch] of Object.entries(layer.git_workflows)) {
    effective.git_workflows[stage] = applyPipelinePatch(effective.git_workflows[stage], patch)
    for (const operation of ['replace_tasks', 'remove', 'prepend', 'append']) {
      if (patch[operation] !== undefined) {
        addLineage(lineage, 'git_workflows', stage, lineageEntry(source, 'patch', {
          operation,
          tasks: [...patch[operation]]
        }))
      }
    }
  }

  for (const [adapterName, adapter] of Object.entries(layer.adapters)) {
    effective.adapters[adapterName] = mergeObject(effective.adapters[adapterName], adapter)
    addLineage(lineage, 'adapters', adapterName, lineageEntry(source, 'merge', { keys: Object.keys(adapter) }))
  }
}

function profileLayer () {
  const config = clone(BUILT_IN_PROFILE.config)
  return {
    schema_version: SCHEMA_VERSION,
    profile_version: PROFILE_VERSION,
    project: config.project,
    globs: config.globs,
    tasks: config.tasks,
    agent_workflows: Object.fromEntries(
      Object.entries(config.agent_workflows).map(([stage, tasks]) => [stage, { replace_tasks: tasks }])
    ),
    git_workflows: Object.fromEntries(
      Object.entries(config.git_workflows).map(([stage, tasks]) => [stage, { replace_tasks: tasks }])
    ),
    adapters: config.adapters
  }
}

function validateTaskReferences (effective) {
  for (const [groupName, workflows] of Object.entries({
    agent_workflows: effective.agent_workflows,
    git_workflows: effective.git_workflows
  })) {
    for (const [stage, pipeline] of Object.entries(workflows)) {
      for (const taskName of pipeline) {
        if (!Object.prototype.hasOwnProperty.call(effective.tasks, taskName)) {
          throw new Error(`effective config: ${groupName}.${stage} references unknown task "${taskName}"`)
        }
      }
    }
  }
}

function buildTaskShadowing (taskDefinitions) {
  const shadowing = {}
  for (const [taskName, sources] of Object.entries(taskDefinitions)) {
    if (sources.length > 1) {
      shadowing[taskName] = sources.map(source => ({
        kind: source.kind,
        path: source.path || null,
        name: source.name || null,
        profile_version: source.profile_version || null
      }))
    }
  }
  return shadowing
}

function loadEffectiveConfig (cwd = process.cwd(), options = {}) {
  const paths = resolveConfigPaths(cwd, options)
  const sourceLayers = [
    profileSourceEntry(),
    sourceEntry('global', paths.global, fs.existsSync(paths.global)),
    sourceEntry('project', paths.project, fs.existsSync(paths.project)),
    sourceEntry('local', paths.local, fs.existsSync(paths.local))
  ]

  const hasConfigFile = sourceLayers.some(layer => layer.kind !== 'profile' && layer.present)
  if (options.requireConfigFile && !hasConfigFile) return null

  const effective = {
    schema_version: SCHEMA_VERSION,
    profile_version: PROFILE_VERSION,
    project: {},
    globs: { source: [], test: [] },
    tasks: {},
    agent_workflows: {},
    git_workflows: {},
    adapters: {}
  }
  ensureWorkflowContainers(effective)

  const lineage = {
    project: {},
    globs: {},
    tasks: {},
    agent_workflows: {},
    git_workflows: {},
    adapters: {}
  }
  const taskDefinitions = {}

  mergeLayer(effective, profileLayer(), sourceLayers[0], lineage, taskDefinitions)

  for (const source of sourceLayers.slice(1)) {
    if (!source.present) continue
    const layer = validateConfig(readJsonFile(source.path), source.path)
    mergeLayer(effective, layer, source, lineage, taskDefinitions)
  }

  effective.profile_version = PROFILE_VERSION
  ensureWorkflowContainers(effective)
  validateTaskReferences(effective)

  return {
    effective,
    source_layers: sourceLayers,
    lineage,
    task_shadowing: buildTaskShadowing(taskDefinitions)
  }
}

function projectConfigPath (cwd) {
  return path.join(cwd, CONFIG_DIR, CONFIG_FILE)
}

function loadProjectConfig (cwd) {
  const explained = loadEffectiveConfig(cwd, { requireConfigFile: true })
  return explained ? explained.effective : null
}

module.exports = {
  BUILT_IN_PROFILE,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_PROTECTED_PATHS,
  LOCAL_CONFIG_FILE,
  PROFILE_VERSION,
  SCHEMA_VERSION,
  loadEffectiveConfig,
  loadProjectConfig,
  projectConfigPath,
  resolveConfigPaths,
  validateConfig
}
