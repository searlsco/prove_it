const fs = require('fs')
const path = require('path')
const { tryRun } = require('./io')
const { gitHead, sanitizeRefName, readRef, sourcePathspecs, findUntrackedSources, removeFromIndex, isGitRepo } = require('./git')
const { generateDiffsSince, loadSessionState } = require('./session')
const { isSourceFile } = require('./globs')

const KNOWN_VARS = [
  'staged_diff', 'staged_files', 'working_diff', 'changed_files',
  'session_diff', 'test_output', 'tool_command', 'file_path',
  'project_dir', 'root_dir', 'session_id', 'git_head',
  'git_status', 'recent_commits', 'files_changed_since_last_run', 'sources',
  'signal_message', 'changes_since_last_run',
  'claude_rules_done'
]

const VAR_DESCRIPTIONS = {
  staged_diff: 'Staged changes (git diff --cached)',
  staged_files: 'Staged file names (git diff --cached --name-only)',
  working_diff: 'Working directory changes (git diff)',
  changed_files: 'Files changed vs HEAD (git diff --name-only HEAD)',
  session_diff: 'Diffs for files edited during this Claude Code session',
  test_output: 'Test command output',
  tool_command: 'Tool command being invoked',
  file_path: 'File path from the current tool invocation',
  project_dir: 'Project directory path',
  root_dir: 'Git repository root directory',
  session_id: 'Claude Code session ID',
  git_head: 'Current git HEAD SHA',
  git_status: 'Working tree status (git status --short)',
  recent_commits: 'Recent commits (git log --oneline --stat -5)',
  files_changed_since_last_run: 'Source files changed since last run, sorted by recency',
  sources: 'Source file glob patterns from config',
  signal_message: "Developer's signal message, if provided",
  changes_since_last_run: 'Changes since last run (git diff --stat)',
  claude_rules_done: 'Definition of done rules from .claude/rules/done.md'
}

const SESSION_VARS = ['session_diff', 'session_id', 'signal_message']

/**
 * Return array of {{var}} names in template that are not in KNOWN_VARS.
 * Returns empty array when template is null/empty or all vars are known.
 * Also matches {{#var}} and {{/var}} conditional block tags.
 */
function getUnknownVars (template) {
  if (!template) return []
  const seen = new Set()
  const unknown = []
  const re = /\{\{[#/]?(\w+)\}\}/g
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
 * Resolve the best available baseline SHA for diff comparisons.
 * Cascade: task ref → session baseline → HEAD.
 */
function resolveBaseline (rootDir, context) {
  // 1. Task ref (set after first reviewer PASS)
  if (context.taskName) {
    const refSha = readRef(rootDir, sanitizeRefName(context.taskName))
    if (refSha) return refSha
  }
  // 2. Session baseline (checkpoint or initial)
  if (context.sessionId) {
    const checkpoint = loadSessionState(context.sessionId, 'last_stop_head')
    if (checkpoint) return checkpoint
    const git = loadSessionState(context.sessionId, 'git')
    if (git?.head) return git.head
  }
  // 3. Fallback to HEAD
  return 'HEAD'
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
    session_diff: lazy('session_diff', () => {
      if (!sessionId) return ''
      // Try file-history first (Claude Code's built-in tracking)
      const lastSnapshotId = loadSessionState(sessionId, 'last_review_snapshot')
      const diffs = generateDiffsSince(sessionId, projectDir, lastSnapshotId)
      if (diffs && diffs.length > 0) {
        return diffs.map(d => `### ${d.file}\n\`\`\`diff\n${d.diff}\n\`\`\``).join('\n\n')
      }
      // Git-based fallback: diff all source files from baseline to working tree
      if (!isGitRepo(rootDir)) return ''
      const base = resolveBaseline(rootDir, context)
      const { shellEscape: esc } = require('./io')
      const pathspecs = sourcePathspecs(context.sources)
      const untracked = findUntrackedSources(rootDir, context.sources)
      if (untracked.length > 0) {
        const escaped = untracked.map(f => esc(f)).join(' ')
        tryRun(`git -C ${esc(rootDir)} add -N -- ${escaped}`, {})
      }
      try {
        const r = tryRun(`git -C ${esc(rootDir)} diff ${esc(base)} -- ${pathspecs}`, {})
        if (r.code !== 0 || !r.stdout.trim()) return ''
        let diff = r.stdout.trim()
        const MAX_DIFF_CHARS = 100000
        if (diff.length > MAX_DIFF_CHARS) {
          diff = diff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated, ' + diff.length + ' total chars)'
        }
        return '### Session changes (git diff)\n```diff\n' + diff + '\n```'
      } finally {
        removeFromIndex(rootDir, untracked)
      }
    }),
    test_output: lazy('test_output', () => context.testOutput || ''),
    tool_command: lazy('tool_command', () => toolInput?.command || ''),
    file_path: lazy('file_path', () => toolInput?.file_path || toolInput?.notebook_path || ''),
    project_dir: lazy('project_dir', () => projectDir || ''),
    root_dir: lazy('root_dir', () => rootDir || ''),
    session_id: lazy('session_id', () => sessionId || ''),
    git_head: lazy('git_head', () => gitHead(rootDir) || ''),
    git_status: lazy('git_status', () => {
      const r = tryRun('git status --short', { cwd: rootDir })
      if (r.code !== 0) return ''
      const out = r.stdout.trim()
      return out || '(clean)'
    }),
    recent_commits: lazy('recent_commits', () => {
      const r = tryRun('git log --oneline --stat -5', { cwd: rootDir })
      return r.code === 0 ? r.stdout.trim() : ''
    }),
    sources: lazy('sources', () => {
      const src = context.sources
      if (!src || !Array.isArray(src)) return ''
      return src.join('\n')
    }),
    signal_message: lazy('signal_message', () => {
      const { getSignal } = require('./session')
      const signal = getSignal(sessionId)
      return signal?.message || ''
    }),
    files_changed_since_last_run: lazy('files_changed_since_last_run', () => {
      const base = resolveBaseline(rootDir, context)
      const { shellEscape } = require('./io')
      const r = tryRun(`git -C ${shellEscape(rootDir)} diff ${shellEscape(base)} --name-only`, {})
      const tracked = r.code === 0 ? r.stdout.trim().split('\n').filter(f => f.trim()) : []
      const u = tryRun('git ls-files --others --exclude-standard', { cwd: rootDir })
      const untracked = u.code === 0 ? u.stdout.trim().split('\n').filter(f => f.trim()) : []
      const files = [...new Set([...tracked, ...untracked])]
      if (files.length === 0) return ''
      const sources = context.sources
      const sourceFiles = files.filter(f => isSourceFile(f, rootDir, sources))
      sourceFiles.sort((a, b) => {
        try {
          const aStat = fs.statSync(path.join(rootDir, a))
          const bStat = fs.statSync(path.join(rootDir, b))
          return bStat.mtimeMs - aStat.mtimeMs
        } catch { return 0 }
      })
      return sourceFiles.join('\n')
    }),
    claude_rules_done: lazy('claude_rules_done', () => {
      const candidates = [
        projectDir && path.join(projectDir, '.claude', 'rules', 'done.md'),
        process.env.HOME && path.join(process.env.HOME, '.claude', 'rules', 'done.md')
      ].filter(Boolean)
      for (const p of candidates) {
        try { return fs.readFileSync(p, 'utf8').trim() } catch {}
      }
      return ''
    }),
    changes_since_last_run: lazy('changes_since_last_run', () => {
      if (!isGitRepo(rootDir)) return ''
      const base = resolveBaseline(rootDir, context)
      const { shellEscape } = require('./io')
      const pathspecs = sourcePathspecs(context.sources)
      const untracked = findUntrackedSources(rootDir, context.sources)
      if (untracked.length > 0) {
        const escaped = untracked.map(f => shellEscape(f)).join(' ')
        tryRun(`git -C ${shellEscape(rootDir)} add -N -- ${escaped}`, {})
      }
      try {
        const r = tryRun(`git -C ${shellEscape(rootDir)} diff --stat ${shellEscape(base)} -- ${pathspecs}`, {})
        if (r.code !== 0) return ''
        return r.stdout.trim()
      } finally {
        removeFromIndex(rootDir, untracked)
      }
    })
  }
}

/**
 * Expand {{var}} placeholders and {{#var}}...{{/var}} conditional blocks
 * in a template string. Variables are lazily resolved from context.
 *
 * Conditional blocks: if the variable is non-empty, the block content is
 * kept (with inner {{var}} expanded). If empty, the entire block is stripped.
 */
function expandTemplate (template, context) {
  if (!template) return ''
  const resolvers = makeResolvers(context)

  // First pass: resolve conditional blocks {{#var}}...{{/var}}
  let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, varName, content) => {
    const resolver = resolvers[varName]
    if (!resolver) return ''
    const value = resolver()
    if (!value || !value.trim()) return ''
    // Expand inner {{var}} references within the block
    return content.replace(/\{\{(\w+)\}\}/g, (m, inner) => {
      const r = resolvers[inner]
      if (!r) return m
      return r()
    })
  })

  // Second pass: expand remaining {{var}} patterns
  result = result.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const resolver = resolvers[varName]
    if (!resolver) return match
    return resolver()
  })

  return result
}

/**
 * Return array of session-dependent {{var}} names used in the template.
 * These vars require a Claude Code session (sessionId) to resolve.
 * Also matches {{#var}} and {{/var}} conditional block tags.
 */
function getSessionVars (template) {
  if (!template) return []
  const found = []
  const re = /\{\{[#/]?(\w+)\}\}/g
  let match
  while ((match = re.exec(template)) !== null) {
    const varName = match[1]
    if (SESSION_VARS.includes(varName) && !found.includes(varName)) {
      found.push(varName)
    }
  }
  return found
}

module.exports = { expandTemplate, makeResolvers, KNOWN_VARS, VAR_DESCRIPTIONS, SESSION_VARS, getUnknownVars, getSessionVars }
