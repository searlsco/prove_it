// Single source of truth for all config defaults.
// See CLAUDE.md "Config defaults cascade" for usage rules.

const CONFIG_DEFAULTS = {
  enabled: false,
  sources: null,
  hooks: [],
  maxAgentTurns: 10,
  format: { maxOutputChars: 12000 },
  taskEnv: { TURBOCOMMIT_DISABLED: '1' },
  taskAllowedTools: null,
  taskBypassPermissions: null,
  model: null,
  fileEditingTools: []
}

const DEFAULT_MODELS = {
  PreToolUse: 'haiku',
  Stop: 'haiku',
  'pre-commit': 'sonnet',
  'pre-push': 'sonnet'
}

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit']

function configDefaults () {
  return JSON.parse(JSON.stringify(CONFIG_DEFAULTS))
}

module.exports = { CONFIG_DEFAULTS, DEFAULT_MODELS, DEFAULT_ALLOWED_TOOLS, configDefaults }
