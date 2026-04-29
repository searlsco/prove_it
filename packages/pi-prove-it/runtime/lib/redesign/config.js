const fs = require('fs')
const os = require('os')
const path = require('path')

const { VALID_PHASES } = require('./phase_state')

const CONFIG_DIR = '.prove_it'
const CONFIG_FILE = 'config.json'
const LOCAL_CONFIG_FILE = 'config.local.json'
const SCHEMA_VERSION = 1
const PROFILE_VERSION = 'prove_it.strict.v1'

const DEFAULT_PROTECTED_PATHS = [
  '.prove_it/config.json',
  '.prove_it/config.local.json'
]

const DEFAULT_SOURCE_GLOBS = [
  '**/*.*',
  '!**/*.{md,txt}',
  'replace/these/with/globs/of/your/source/and/test/files.*'
]

const DEFAULT_TEST_GLOBS = [
  '**/*.{test,spec}.*',
  '**/*_{test,spec}.*',
  '**/{test,tests,spec,specs,__tests__}/**/*.*'
]

const VERIFY_ASSUMPTIONS_COMMAND = "echo 'BLOCKING REQUIREMENT: Before presenting this plan, audit every assumption it relies on. If ANY assumption has not been objectively verified by you or the user, you MUST verify it now. Read the code, build a proof-of-concept, exercise the behavior in a real browser or app, or ask the user. Failure to identify and validate your assumptions prior to implementation will result in your work being discarded and re-attempted by another developer.'"

const BUILT_IN_PROFILE = Object.freeze({
  name: 'strict',
  selector: 'strict',
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

const CLAUDE_PARITY_PROFILE = Object.freeze({
  name: 'claude-parity',
  selector: 'claude',
  profile_version: PROFILE_VERSION,
  config: Object.freeze({
    schema_version: SCHEMA_VERSION,
    project: Object.freeze({}),
    globs: Object.freeze({
      source: Object.freeze([...DEFAULT_SOURCE_GLOBS]),
      test: Object.freeze([...DEFAULT_TEST_GLOBS])
    }),
    tasks: Object.freeze({
      protect_prove_it_config: Object.freeze({
        type: 'config_guard',
        protected_paths: Object.freeze([...DEFAULT_PROTECTED_PATHS])
      }),
      test_first: Object.freeze({
        type: 'script',
        command: '$(prove_it prefix)/libexec/test-first',
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*'
      }),
      verify_assumptions: Object.freeze({
        type: 'script',
        command: VERIFY_ASSUMPTIONS_COMMAND,
        matcher: 'ExitPlanMode'
      }),
      fast_tests: Object.freeze({
        type: 'script',
        command: './script/test_fast',
        when: Object.freeze({ sourcesModifiedSinceLastRun: true, sourceFilesEdited: true })
      }),
      full_tests: Object.freeze({
        type: 'script',
        command: './script/test',
        parallel: true,
        when: Object.freeze({ signal: 'done', sourceFilesEdited: true })
      }),
      git_full_tests: Object.freeze({
        type: 'script',
        command: './script/test',
        when: Object.freeze({ sourcesModifiedSinceLastRun: true })
      }),
      testing_antipatterns_review: Object.freeze({
        type: 'reviewer',
        intent: 'Review recently edited tests for brittle, overly mocked, or implementation-coupled testing patterns.',
        prompt: 'skill:prove-testing-patterns',
        provider: 'claude',
        model: 'haiku',
        async: true,
        provider_options: Object.freeze({ max_turns: 3 }),
        when: Object.freeze({ testFilesEdited: true })
      }),
      coverage_review: Object.freeze({
        type: 'reviewer',
        intent: 'Review whether the test changes and existing suite adequately prove the behavior change.',
        prompt: 'skill:prove-coverage',
        provider: 'claude',
        model: 'haiku',
        async: true,
        when: Object.freeze({ linesChanged: 541 })
      }),
      done_review: Object.freeze({
        type: 'reviewer',
        intent: 'Review whether the task is truly done and ready for the user.',
        prompt: 'skill:prove-done',
        provider: 'claude',
        model: 'opus',
        parallel: true,
        when: Object.freeze({ signal: 'done' })
      }),
      approach_review: Object.freeze({
        type: 'reviewer',
        intent: 'Review whether the current stuck approach should be changed before continuing.',
        prompt: 'skill:prove-approach',
        provider: 'claude',
        model: 'sonnet',
        parallel: true,
        when: Object.freeze({ signal: 'stuck' })
      })
    }),
    agent_workflows: Object.freeze({
      session_start: Object.freeze([]),
      pre_tool: Object.freeze(['protect_prove_it_config', 'test_first', 'verify_assumptions']),
      post_tool: Object.freeze(['testing_antipatterns_review']),
      post_tool_failure: Object.freeze([]),
      agent_end: Object.freeze(['fast_tests', 'full_tests', 'coverage_review', 'done_review', 'approach_review'])
    }),
    git_workflows: Object.freeze({
      pre_commit: Object.freeze(['git_full_tests']),
      pre_push: Object.freeze([])
    }),
    adapters: Object.freeze({
      pi: Object.freeze({ enabled: false }),
      claude: Object.freeze({ enabled: false })
    })
  })
})

const PROFILE_BY_SELECTOR = Object.freeze({
  strict: BUILT_IN_PROFILE,
  claude: CLAUDE_PARITY_PROFILE,
  'claude-parity': CLAUDE_PARITY_PROFILE
})

const TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'profile_version',
  'profile',
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
const TASK_COMMON_KEYS = new Set(['type', 'description', 'matcher', 'triggers', 'when', 'async', 'parallel', 'failure_behavior', 'appeal', 'output'])
const WHEN_KEYS = new Set([
  'signal',
  'phase',
  'sourceFilesEdited',
  'testFilesEdited',
  'sourcesModifiedSinceLastRun',
  'linesChanged',
  'linesWritten'
])
const VALID_WHEN_SIGNALS = new Set(['done', 'stuck', 'idle'])
const VALID_WHEN_PHASES = new Set(VALID_PHASES)
const REVIEWER_PROVIDER_OPTION_KEYS = new Set(['max_turns', 'allowed_tools', 'bypass_permissions', 'command', 'env'])
const VALID_FAILURE_BEHAVIORS = new Set(['block', 'warn'])
const VALID_OUTPUT_POLICIES = new Set(['default', 'failures_only'])
const APPEAL_KEYS = new Set(['enabled', 'threshold'])
const VALID_REVIEWER_PROVIDERS = new Set(['claude', 'pi', 'codex'])
const VALID_PROFILE_SELECTORS = new Set(Object.keys(PROFILE_BY_SELECTOR))

const TASK_TYPE_KEYS = {
  config_guard: new Set(['protected_paths']),
  script: new Set(['command', 'params', 'env', 'timeout_ms']),
  agent: new Set(['prompt', 'model']),
  reviewer: new Set(['intent', 'prompt', 'model', 'provider', 'provider_options', 'timeout_ms', 'context_files'])
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

function validateOptionalBoolean (value, label, filePath) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${filePath}: ${label} must be a boolean`)
  }
}

function validateOptionalNonNegativeInteger (value, label, filePath) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${filePath}: ${label} must be a non-negative integer`)
  }
}

function validateOptionalStringMap (value, label, filePath) {
  if (value === undefined) return
  assertPlainObject(value, label, filePath)
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(`${filePath}: ${label}.${key} must be a string`)
    }
  }
}

function validateAppeal (appeal, label, filePath) {
  if (appeal === undefined) return undefined
  if (typeof appeal === 'boolean') return appeal
  assertPlainObject(appeal, label, filePath)
  assertKnownKeys(appeal, APPEAL_KEYS, label, filePath)
  validateOptionalBoolean(appeal.enabled, `${label}.enabled`, filePath)
  validateOptionalNonNegativeInteger(appeal.threshold, `${label}.threshold`, filePath)
  return clone(appeal)
}

function validateReviewerProviderOptions (options, label, filePath) {
  if (options === undefined) return undefined
  assertPlainObject(options, label, filePath)
  assertKnownKeys(options, REVIEWER_PROVIDER_OPTION_KEYS, label, filePath)
  validateOptionalNonNegativeInteger(options.max_turns, `${label}.max_turns`, filePath)
  if (options.allowed_tools !== undefined) validateStringArray(options.allowed_tools, `${label}.allowed_tools`, filePath)
  validateOptionalBoolean(options.bypass_permissions, `${label}.bypass_permissions`, filePath)
  validateOptionalString(options.command, `${label}.command`, filePath)
  validateOptionalStringMap(options.env, `${label}.env`, filePath)
  return clone(options)
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

function profileSourceEntry (profile = BUILT_IN_PROFILE) {
  return {
    kind: 'profile',
    name: profile.name,
    selector: profile.selector,
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

function validateWhenClause (clause, label, filePath) {
  assertPlainObject(clause, label, filePath)
  assertKnownKeys(clause, WHEN_KEYS, label, filePath)

  if (clause.signal !== undefined && !VALID_WHEN_SIGNALS.has(clause.signal)) {
    throw new Error(`${filePath}: ${label}.signal must be one of ${Array.from(VALID_WHEN_SIGNALS).join(', ')}`)
  }
  if (clause.phase !== undefined && !VALID_WHEN_PHASES.has(clause.phase)) {
    throw new Error(`${filePath}: ${label}.phase must be one of ${Array.from(VALID_WHEN_PHASES).join(', ')}`)
  }
  validateOptionalBoolean(clause.sourceFilesEdited, `${label}.sourceFilesEdited`, filePath)
  validateOptionalBoolean(clause.testFilesEdited, `${label}.testFilesEdited`, filePath)
  validateOptionalBoolean(clause.sourcesModifiedSinceLastRun, `${label}.sourcesModifiedSinceLastRun`, filePath)
  validateOptionalNonNegativeInteger(clause.linesChanged, `${label}.linesChanged`, filePath)
  validateOptionalNonNegativeInteger(clause.linesWritten, `${label}.linesWritten`, filePath)

  return clone(clause)
}

function validateWhen (when, label, filePath) {
  if (when === undefined) return undefined
  if (Array.isArray(when)) return when.map((clause, index) => validateWhenClause(clause, `${label}[${index}]`, filePath))
  return validateWhenClause(when, label, filePath)
}

function validateTask (name, task, filePath) {
  assertPlainObject(task, `tasks.${name}`, filePath)

  if (!TASK_TYPES.has(task.type)) {
    throw new Error(`${filePath}: tasks.${name}.type must be one of ${Array.from(TASK_TYPES).join(', ')}`)
  }

  const allowed = new Set([...TASK_COMMON_KEYS, ...TASK_TYPE_KEYS[task.type]])
  assertKnownKeys(task, allowed, `tasks.${name}`, filePath)
  validateOptionalString(task.description, `tasks.${name}.description`, filePath)
  validateOptionalString(task.matcher, `tasks.${name}.matcher`, filePath)
  if (task.triggers !== undefined) validateStringArray(task.triggers, `tasks.${name}.triggers`, filePath)
  validateOptionalBoolean(task.async, `tasks.${name}.async`, filePath)
  validateOptionalBoolean(task.parallel, `tasks.${name}.parallel`, filePath)
  if (task.failure_behavior !== undefined && !VALID_FAILURE_BEHAVIORS.has(task.failure_behavior)) {
    throw new Error(`${filePath}: tasks.${name}.failure_behavior must be one of ${Array.from(VALID_FAILURE_BEHAVIORS).join(', ')}`)
  }
  if (task.output !== undefined && !VALID_OUTPUT_POLICIES.has(task.output)) {
    throw new Error(`${filePath}: tasks.${name}.output must be one of ${Array.from(VALID_OUTPUT_POLICIES).join(', ')}`)
  }
  if (task.async === true && task.parallel === true) {
    throw new Error(`${filePath}: tasks.${name} cannot be both async and parallel`)
  }
  validateWhen(task.when, `tasks.${name}.when`, filePath)
  validateAppeal(task.appeal, `tasks.${name}.appeal`, filePath)

  if (task.type === 'config_guard') {
    if (task.protected_paths !== undefined) {
      validateStringArray(task.protected_paths, `tasks.${name}.protected_paths`, filePath)
    }
  } else if (task.type === 'script') {
    if (typeof task.command !== 'string' || task.command.length === 0) {
      throw new Error(`${filePath}: tasks.${name}.command must be a non-empty string`)
    }
    if (task.params !== undefined) {
      assertPlainObject(task.params, `tasks.${name}.params`, filePath)
    }
    validateOptionalStringMap(task.env, `tasks.${name}.env`, filePath)
    if (task.timeout_ms !== undefined && (!Number.isInteger(task.timeout_ms) || task.timeout_ms < 0)) {
      throw new Error(`${filePath}: tasks.${name}.timeout_ms must be a non-negative integer`)
    }
  } else if (task.type === 'agent') {
    if (typeof task.prompt !== 'string' || task.prompt.length === 0) {
      throw new Error(`${filePath}: tasks.${name}.prompt must be a non-empty string`)
    }
    validateOptionalString(task.model, `tasks.${name}.model`, filePath)
  } else if (task.type === 'reviewer') {
    if ((typeof task.prompt !== 'string' || task.prompt.length === 0) && (typeof task.intent !== 'string' || task.intent.length === 0)) {
      throw new Error(`${filePath}: tasks.${name} must define a non-empty prompt or intent`)
    }
    validateOptionalString(task.intent, `tasks.${name}.intent`, filePath)
    validateOptionalString(task.prompt, `tasks.${name}.prompt`, filePath)
    validateOptionalString(task.model, `tasks.${name}.model`, filePath)
    validateOptionalString(task.provider, `tasks.${name}.provider`, filePath)
    if (task.provider !== undefined && !VALID_REVIEWER_PROVIDERS.has(task.provider)) {
      throw new Error(`${filePath}: tasks.${name}.provider must be one of ${Array.from(VALID_REVIEWER_PROVIDERS).join(', ')}`)
    }
    validateOptionalNonNegativeInteger(task.timeout_ms, `tasks.${name}.timeout_ms`, filePath)
    if (task.context_files !== undefined) validateStringArray(task.context_files, `tasks.${name}.context_files`, filePath)
    validateReviewerProviderOptions(task.provider_options, `tasks.${name}.provider_options`, filePath)
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

  validateOptionalString(config.profile, 'profile', filePath)
  if (config.profile !== undefined && !VALID_PROFILE_SELECTORS.has(config.profile)) {
    throw new Error(`${filePath}: profile must be one of ${Array.from(VALID_PROFILE_SELECTORS).join(', ')}`)
  }

  return {
    schema_version: config.schema_version,
    profile_version: config.profile_version,
    profile: config.profile,
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
  if (layer.profile !== undefined) effective.profile = layer.profile

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

function profileLayer (profile = BUILT_IN_PROFILE) {
  const config = clone(profile.config)
  return {
    schema_version: SCHEMA_VERSION,
    profile_version: PROFILE_VERSION,
    profile: profile.selector,
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

function resolveProfileSelector (selector, filePath = 'profile') {
  const profile = PROFILE_BY_SELECTOR[selector || 'strict']
  if (!profile) throw new Error(`${filePath}: profile must be one of ${Array.from(VALID_PROFILE_SELECTORS).join(', ')}`)
  return profile
}

function selectedProfileForPaths (paths) {
  let selector = 'strict'
  for (const filePath of [paths.global, paths.project, paths.local]) {
    if (!fs.existsSync(filePath)) continue
    const raw = readJsonFile(filePath)
    if (raw && typeof raw.profile === 'string') selector = raw.profile
  }
  return resolveProfileSelector(selector, 'effective config')
}

function loadEffectiveConfig (cwd = process.cwd(), options = {}) {
  const paths = resolveConfigPaths(cwd, options)
  const selectedProfile = selectedProfileForPaths(paths)
  const sourceLayers = [
    profileSourceEntry(selectedProfile),
    sourceEntry('global', paths.global, fs.existsSync(paths.global)),
    sourceEntry('project', paths.project, fs.existsSync(paths.project)),
    sourceEntry('local', paths.local, fs.existsSync(paths.local))
  ]

  const hasConfigFile = sourceLayers.some(layer => layer.kind !== 'profile' && layer.present)
  if (options.requireConfigFile && !hasConfigFile) return null

  const effective = {
    schema_version: SCHEMA_VERSION,
    profile_version: PROFILE_VERSION,
    profile: selectedProfile.selector,
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

  mergeLayer(effective, profileLayer(selectedProfile), sourceLayers[0], lineage, taskDefinitions)

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
  CLAUDE_PARITY_PROFILE,
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
