const { tryRun } = require('./io')
const { gitHead } = require('./git')
const { generateDiffsSince, loadSessionState } = require('./session')

const KNOWN_VARS = [
  'staged_diff', 'staged_files', 'working_diff', 'changed_files',
  'session_diffs', 'test_output', 'tool_command', 'file_path',
  'project_dir', 'root_dir', 'session_id', 'git_head'
]

const SESSION_VARS = ['session_diffs', 'session_id']

/**
 * Return array of {{var}} names in template that are not in KNOWN_VARS.
 * Returns empty array when template is null/empty or all vars are known.
 */
function getUnknownVars (template) {
  if (!template) return []
  const seen = new Set()
  const unknown = []
  const re = /\{\{(\w+)\}\}/g
  let match
  while ((match = re.exec(template)) !== null) {
    const varName = match[1]
    if (!KNOWN_VARS.includes(varName) && !seen.has(varName)) {
      seen.add(varName)
      unknown.push(varName)
    }
  }
  return unknown
}

/**
 * Lazy template variable resolvers.
 * Each returns a function that computes the value on first access.
 */
function makeResolvers (context) {
  const { rootDir, projectDir, sessionId, toolInput } = context
  const cache = {}

  function lazy (key, fn) {
    return () => {
      if (!(key in cache)) cache[key] = fn()
      return cache[key]
    }
  }

  return {
    staged_diff: lazy('staged_diff', () => {
      const r = tryRun('git diff --cached', { cwd: rootDir })
      return r.code === 0 ? r.stdout.trim() : ''
    }),
    staged_files: lazy('staged_files', () => {
      const r = tryRun('git diff --cached --name-only', { cwd: rootDir })
      return r.code === 0 ? r.stdout.trim() : ''
    }),
    working_diff: lazy('working_diff', () => {
      const r = tryRun('git diff', { cwd: rootDir })
      return r.code === 0 ? r.stdout.trim() : ''
    }),
    changed_files: lazy('changed_files', () => {
      const r = tryRun('git diff --name-only HEAD', { cwd: rootDir })
      return r.code === 0 ? r.stdout.trim() : ''
    }),
    session_diffs: lazy('session_diffs', () => {
      if (!sessionId) return ''
      const lastSnapshotId = loadSessionState(sessionId, 'last_review_snapshot')
      const diffs = generateDiffsSince(sessionId, projectDir, lastSnapshotId)
      if (!diffs || diffs.length === 0) return ''
      return diffs.map(d => `### ${d.file}\n\`\`\`diff\n${d.diff}\n\`\`\``).join('\n\n')
    }),
    test_output: lazy('test_output', () => context.testOutput || ''),
    tool_command: lazy('tool_command', () => toolInput?.command || ''),
    file_path: lazy('file_path', () => toolInput?.file_path || toolInput?.notebook_path || ''),
    project_dir: lazy('project_dir', () => projectDir || ''),
    root_dir: lazy('root_dir', () => rootDir || ''),
    session_id: lazy('session_id', () => sessionId || ''),
    git_head: lazy('git_head', () => gitHead(rootDir) || '')
  }
}

/**
 * Expand {{var}} placeholders in a template string.
 * Variables are lazily resolved from context.
 */
function expandTemplate (template, context) {
  if (!template) return ''
  const resolvers = makeResolvers(context)
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const resolver = resolvers[varName]
    if (!resolver) return match
    return resolver()
  })
}

/**
 * Return array of session-dependent {{var}} names used in the template.
 * These vars require a Claude Code session (sessionId) to resolve.
 */
function getSessionVars (template) {
  if (!template) return []
  const found = []
  const re = /\{\{(\w+)\}\}/g
  let match
  while ((match = re.exec(template)) !== null) {
    const varName = match[1]
    if (SESSION_VARS.includes(varName) && !found.includes(varName)) {
      found.push(varName)
    }
  }
  return found
}

module.exports = { expandTemplate, makeResolvers, KNOWN_VARS, SESSION_VARS, getUnknownVars, getSessionVars }
