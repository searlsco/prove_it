#!/usr/bin/env node
/**
 * prove_it: Edit gate hook
 *
 * Handles:
 * - PreToolUse (Edit/Write/NotebookEdit/Bash): config protection + beads enforcement + source filtering
 *
 * Responsibilities:
 * 1. Block modifications to prove_it config files (via any tool)
 * 2. Enforce beads tracking for code-writing operations
 * 3. Skip enforcement for non-source files
 */
const path = require('path')

const {
  readStdin,
  tryRun,
  isGitRepo,
  gitRoot,
  emitJson,
  defaultBeadsConfig,
  loadEffectiveConfig,
  loadGlobalConfig,
  isIgnoredPath,
  isBeadsRepo,
  globToRegex
} = require('../shared')

// Hardcoded: tools that require a bead to be in progress
const GATED_TOOLS = ['Edit', 'Write', 'NotebookEdit']

// Hardcoded: bash patterns that look like code-writing operations
const BASH_WRITE_PATTERNS = [
  '\\bcat\\s+.*>',
  '\\becho\\s+.*>',
  '\\btee\\s',
  '\\bsed\\s+-i',
  '\\bawk\\s+.*-i\\s*inplace'
]

function isProveItConfigPath (filePath) {
  if (!filePath) return false
  // Project configs: .claude/prove_it.json, .claude/prove_it.local.json
  if (/prove_it(\.local)?\.json/.test(filePath)) return true
  // Global config: ~/.claude/prove_it/config.json
  if (/prove_it\/config\.json/.test(filePath)) return true
  return false
}

function isLocalConfigWrite (command) {
  const cmd = command || ''
  const configPat = 'prove_it(\\.local)?\\.json|prove_it/config\\.json'
  return new RegExp(`>\\s*\\S*(${configPat})|tee\\s+.*(${configPat})`).test(cmd)
}

function isConfigFileEdit (toolName, toolInput) {
  if (toolName !== 'Write' && toolName !== 'Edit') return false
  return isProveItConfigPath(toolInput?.file_path || '')
}

/**
 * Check if a file path matches any of the configured source globs.
 * If no sources configured, all files are considered source files.
 */
function isSourceFile (filePath, rootDir, sources) {
  if (!sources || sources.length === 0) return true

  let relativePath
  if (path.isAbsolute(filePath)) {
    relativePath = path.relative(rootDir, filePath)
  } else {
    relativePath = filePath
  }

  // Outside the repo
  if (relativePath.startsWith('..')) return false

  return sources.some((glob) => globToRegex(glob).test(relativePath))
}

function getInProgressBeads (dir) {
  let r
  try {
    r = tryRun('bd list --status in_progress 2>/dev/null', { cwd: dir })
  } catch (e) {
    console.error(`prove_it: bd command failed: ${e.message}. Beads may need updating.`)
    return null
  }

  if (r.code !== 0) {
    if (r.stderr && r.stderr.includes('command not found')) {
      console.error('prove_it: bd command not found. Install beads or disable beads enforcement.')
    }
    return null
  }

  const lines = r.stdout
    .trim()
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false
      if (line.includes('───') || line.includes('---')) return false
      if (line.toLowerCase().includes('no issues found')) return false
      if (line.toLowerCase().includes('id') && line.toLowerCase().includes('subject')) return false
      return true
    })

  return lines
}

function isBashWriteOperation (command, patterns) {
  return patterns.some((pat) => {
    try {
      return new RegExp(pat, 'i').test(command)
    } catch {
      return false
    }
  })
}

function main () {
  let input
  try {
    input = JSON.parse(readStdin())
  } catch (e) {
    // Fail closed: if we can't parse input, deny with error
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `prove_it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`
      }
    })
    process.exit(0)
  }

  const hookEvent = input.hook_event_name
  if (hookEvent !== 'PreToolUse') process.exit(0)

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0)
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

  // Skip hooks entirely for non-git directories (tmp, home, bin, etc.)
  if (!isGitRepo(projectDir)) {
    process.exit(0)
  }

  // Check for ignored paths in global config
  const globalCfg = loadGlobalConfig()
  if (isIgnoredPath(projectDir, globalCfg.ignoredPaths)) {
    process.exit(0)
  }

  const toolName = input.tool_name

  // --- Config file protection (runs before beads enforcement) ---

  // Block Write/Edit to prove_it config files
  if (isConfigFileEdit(toolName, input.tool_input)) {
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'prove_it: Cannot modify .claude/prove_it*.json\n\n' +
          'These files are for user configuration. ' +
          'To modify them, run the command directly in your terminal (not through Claude).'
      }
    })
    process.exit(0)
  }

  // Block Bash redirects to prove_it config files
  if (toolName === 'Bash') {
    const toolCmd = input.tool_input?.command || ''
    if (isLocalConfigWrite(toolCmd)) {
      emitJson({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'prove_it: Cannot modify .claude/prove_it*.json\n\n' +
            'These files are for user configuration. ' +
            'To modify them, run the command directly in your terminal (not through Claude).'
        }
      })
      process.exit(0)
    }
  }

  // --- Beads enforcement ---

  const { cfg } = loadEffectiveConfig(projectDir, defaultBeadsConfig)

  // Check for top-level enabled: false in config
  if (cfg.enabled === false) {
    process.exit(0)
  }

  if (!cfg.beads?.enabled) process.exit(0)

  // Check if this tool requires a bead
  let requiresBead = GATED_TOOLS.includes(toolName)

  // For Bash, check if it looks like a write operation
  if (!requiresBead && toolName === 'Bash') {
    const command = input.tool_input?.command || ''
    requiresBead = isBashWriteOperation(command, BASH_WRITE_PATTERNS)
  }

  if (!requiresBead) process.exit(0)

  // Find the repo root
  const rootDir = gitRoot(projectDir) || projectDir

  // Skip enforcement for non-source files (e.g. docs, README)
  if (cfg.sources && cfg.sources.length > 0) {
    let targetPath = null
    if (GATED_TOOLS.includes(toolName)) {
      targetPath = input.tool_input?.file_path || input.tool_input?.notebook_path
    }
    if (targetPath && !isSourceFile(targetPath, rootDir, cfg.sources)) {
      process.exit(0)
    }
  }

  // Check if this is a beads-enabled repo
  if (!isBeadsRepo(rootDir)) {
    process.exit(0)
  }

  // Check for in_progress beads
  const inProgress = getInProgressBeads(rootDir)

  if (inProgress === null) {
    process.exit(0)
  }

  if (inProgress.length > 0) {
    process.exit(0)
  }

  // No in_progress beads - block and explain
  const reason = `prove_it: No bead is tracking this work.

Before making code changes, select or create a bead to track this work:

  bd ready              # Show tasks ready to work on
  bd list               # Show all tasks
  bd show <id>          # View task details
  bd update <id> --status in_progress   # Start working on a task
  bd create "Title"     # Create a new task

Once you have an in_progress bead, this operation will be allowed.

Tip: If this is exploratory work, you can disable beads enforcement in
.claude/prove_it.local.json by setting beads.enabled: false`

  emitJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  })
}

// Export for CLI, auto-run when called directly
if (require.main === module) {
  main()
}
module.exports = { main, isSourceFile, isProveItConfigPath, isConfigFileEdit, isLocalConfigWrite }
