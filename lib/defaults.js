// Single source of truth for all config defaults.
// See CLAUDE.md "Config defaults cascade" for usage rules.

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Task']

const CONFIG_DEFAULTS = {
  enabled: false,
  sources: [],
  tests: [],
  testCommands: [],
  model: 'sonnet',
  hooks: [],
  maxAgentTurns: 10,
  format: { maxOutputChars: 12000 },
  taskEnv: { TURBOCOMMIT_DISABLED: '1' },
  taskAllowedTools: DEFAULT_ALLOWED_TOOLS,
  taskBypassPermissions: false,
  fileEditingTools: []
}

const DEFAULT_MODELS = {
  PreToolUse: 'haiku',
  Stop: 'haiku',
  'pre-commit': 'sonnet',
  'pre-push': 'sonnet'
}

const CONFIG_SCHEMA = {
  enabled: 'boolean',
  sources: 'array',
  tests: 'array',
  testCommands: 'array',
  model: 'string',
  hooks: 'array',
  maxAgentTurns: 'number',
  format: 'object',
  taskEnv: 'object',
  taskAllowedTools: 'array',
  taskBypassPermissions: 'boolean',
  fileEditingTools: 'array',
  ignoredPaths: 'array'
}

function configDefaults () {
  return JSON.parse(JSON.stringify(CONFIG_DEFAULTS))
}

module.exports = { CONFIG_DEFAULTS, CONFIG_SCHEMA, DEFAULT_MODELS, DEFAULT_ALLOWED_TOOLS, configDefaults }
