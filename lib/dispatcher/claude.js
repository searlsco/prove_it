const fs = require('fs')
const path = require('path')
const { readStdin, ensureDir } = require('../io')
const { loadEffectiveConfig, isIgnoredPath, loadGlobalConfig, getProveItDir } = require('../config')
const { resolveTestRoot } = require('../testing')
const { runScriptCheck } = require('../checks/script')
const { runAgentCheck } = require('../checks/agent')
const { runEnvTask } = require('../checks/env')
const { recordWrite, recordTaskRun, linesWrittenSince } = require('../session')
const { isSourceFile } = require('../globs')
const protocol = require('./protocol')

/**
 * Compute net new source lines from a Write/Edit/NotebookEdit tool invocation.
 * Only counts files that match the configured source globs.
 * Returns { lines: number }.
 */
function computeWriteInfo (hookInput, sources, rootDir) {
  const toolName = hookInput.tool_name || ''
  const toolInput = hookInput.tool_input || {}

  // Determine the file path from the tool input
  const filePath = toolInput.file_path || toolInput.notebook_path || ''
  if (!filePath) return { lines: 0 }

  // Resolve symlinks before comparing paths (macOS /var -> /private/var)
  // Use parent dir for file resolution since the file may not exist yet (Write tool)
  let resolvedRoot = rootDir
  try { resolvedRoot = fs.realpathSync(rootDir) } catch {}
  let resolvedFile = filePath
  if (path.isAbsolute(filePath)) {
    try {
      resolvedFile = fs.realpathSync(filePath)
    } catch {
      try {
        const dir = fs.realpathSync(path.dirname(filePath))
        resolvedFile = path.join(dir, path.basename(filePath))
      } catch {}
    }
  }

  // Check if this is a source file
  const relativePath = path.isAbsolute(resolvedFile)
    ? path.relative(resolvedRoot, resolvedFile)
    : filePath
  if (relativePath.startsWith('..')) return { lines: 0 }
  if (!isSourceFile(relativePath, rootDir, sources)) return { lines: 0 }

  if (toolName === 'Write') {
    const content = toolInput.content || ''
    const newLines = content.split('\n').length
    // If file already exists, subtract existing lines
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    let existingLines = 0
    try {
      const existing = fs.readFileSync(absPath, 'utf8')
      existingLines = existing.split('\n').length
    } catch {}
    return { lines: Math.max(0, newLines - existingLines) }
  }

  if (toolName === 'Edit') {
    const oldStr = toolInput.old_string || ''
    const newStr = toolInput.new_string || ''
    const delta = newStr.split('\n').length - oldStr.split('\n').length
    return { lines: Math.max(0, delta) }
  }

  if (toolName === 'NotebookEdit') {
    const editMode = toolInput.edit_mode || 'replace'
    if (editMode === 'insert') {
      const src = toolInput.new_source || ''
      return { lines: src.split('\n').length }
    }
    return { lines: 0 }
  }

  return { lines: 0 }
}

/**
 * Evaluate `when` conditions on a check.
 * All keys in a `when` object are AND-ed.
 * @param {object} when - the when condition object
 * @param {object} context - dispatch context
 * @param {string} [taskName] - task name, needed for linesWrittenSinceLastRun
 */
function evaluateWhen (when, context, taskName) {
  if (!when) return true

  if (when.fileExists) {
    const target = path.join(context.rootDir, when.fileExists)
    if (!fs.existsSync(target)) return false
  }

  if (when.envSet) {
    if (!process.env[when.envSet]) return false
  }

  if (when.envNotSet) {
    if (process.env[when.envNotSet]) return false
  }

  if (when.variablesPresent) {
    const { makeResolvers } = require('../template')
    const resolvers = makeResolvers(context)
    for (const varName of when.variablesPresent) {
      const resolver = resolvers[varName]
      if (!resolver) return false
      const value = resolver()
      if (!value || !value.trim()) return false
    }
  }

  if (when.linesWrittenSinceLastRun) {
    const written = linesWrittenSince(context.sessionId, taskName)
    if (written < when.linesWrittenSinceLastRun) return false
  }

  return true
}

/**
 * Check if a hook entry matches the current event context.
 */
function matchesHookEntry (entry, event, input) {
  if (entry.type !== 'claude') return false
  if (entry.event !== event) return false

  // Source matching for SessionStart
  if (event === 'SessionStart' && entry.source) {
    const sources = entry.source.split('|')
    const inputSource = input.source || ''
    if (!sources.some(s => s === inputSource)) return false
  }

  // Matcher for PreToolUse (tool name matching)
  if (event === 'PreToolUse' && entry.matcher) {
    const matchers = entry.matcher.split('|')
    const toolName = input.tool_name || ''
    if (!matchers.some(m => m === toolName)) return false
  }

  // Trigger matching for PreToolUse + Bash
  if (event === 'PreToolUse' && entry.triggers && entry.triggers.length > 0) {
    const toolCmd = input.tool_input?.command || ''
    const matches = entry.triggers.some(re => {
      try { return new RegExp(re, 'i').test(toolCmd) } catch { return false }
    })
    if (!matches) return false
  }

  return true
}

/**
 * Default config function for loadEffectiveConfig.
 * Returns minimal defaults for v2 schema.
 */
function defaultConfig () {
  return {
    enabled: true,
    sources: null,
    hooks: []
  }
}

/**
 * Lazily record session baseline (git HEAD + status hash).
 * Runs once per session — skips if session file already exists.
 */
function recordSessionBaseline (sessionId, projectDir) {
  if (!sessionId) return
  const sessionsDir = path.join(getProveItDir(), 'sessions')
  const sessionFile = path.join(sessionsDir, `${sessionId}.json`)
  if (fs.existsSync(sessionFile)) return

  try {
    const { gitRoot, gitHead, gitStatusHash } = require('../git')
    ensureDir(sessionsDir)
    const root = gitRoot(projectDir) || projectDir
    const head = gitHead(root)
    const statusHash = gitStatusHash(root)
    const payload = {
      session_id: sessionId,
      project_dir: projectDir,
      root_dir: root,
      started_at: new Date().toISOString(),
      git: { is_repo: true, root, head, status_hash: statusHash }
    }
    fs.writeFileSync(sessionFile, JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) {
    console.error(`prove_it: failed to write session baseline: ${e.message}`)
  }
}

/**
 * Write env vars to CLAUDE_ENV_FILE.
 * Creates or appends to the file specified by the CLAUDE_ENV_FILE env var.
 */
function writeEnvFile (vars) {
  const envFile = process.env.CLAUDE_ENV_FILE
  if (!envFile) {
    console.error('prove_it: CLAUDE_ENV_FILE not set, cannot write env vars')
    return
  }
  const lines = Object.entries(vars).map(([k, v]) => {
    // Quote values that contain newlines, quotes, or backslashes
    if (/[\n\r"\\]/.test(v)) {
      const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
      return `${k}="${escaped}"`
    }
    return `${k}=${v}`
  })
  fs.appendFileSync(envFile, lines.join('\n') + '\n', 'utf8')
}

/**
 * Main dispatcher for Claude Code hook events.
 * Reads stdin, finds matching hook entries, runs checks.
 */
function dispatch (event) {
  let input
  try {
    input = JSON.parse(readStdin())
  } catch (e) {
    const failMsg = `prove_it: Failed to parse hook input.\n\nError: ${e.message}\n\nThis is a safety block. Please report this issue.`
    protocol.emit(event, protocol.failDecision(event), failMsg, failMsg)
    process.exit(0)
  }

  const sessionId = input.session_id || null
  const hookEvent = input.hook_event_name || event
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0)
  }

  // Check for ignored paths in global config
  const globalCfg = loadGlobalConfig()
  if (isIgnoredPath(projectDir, globalCfg.ignoredPaths)) {
    process.exit(0)
  }

  // Lazy session baseline recording (once per session)
  recordSessionBaseline(sessionId, projectDir)

  let cfg, localCfgPath
  try {
    ({ cfg, localCfgPath } = loadEffectiveConfig(projectDir, defaultConfig))
  } catch (e) {
    protocol.emit(hookEvent, protocol.failDecision(hookEvent),
      e.message, e.message)
    process.exit(0)
  }

  // Check for top-level enabled: false
  if (cfg.enabled === false) {
    process.exit(0)
  }

  const hooks = cfg.hooks || []
  if (!Array.isArray(hooks)) {
    process.exit(0)
  }

  const rootDir = resolveTestRoot(projectDir)
  const maxChars = cfg.format?.maxOutputChars || 12000
  const toolName = input.tool_name || null
  const toolInput = input.tool_input || null

  // Build context shared across all checks
  const context = {
    rootDir,
    projectDir,
    sessionId,
    hookEvent,
    toolName,
    toolInput,
    localCfgPath,
    sources: cfg.sources,
    maxChars,
    testOutput: ''
  }

  // Find matching hook entries
  const matchingEntries = hooks.filter(entry => matchesHookEntry(entry, hookEvent, input))

  if (matchingEntries.length === 0) {
    process.exit(0)
  }

  // Collect results
  const outputs = []
  const contextParts = []
  const systemMessages = []
  const envVars = {}

  for (const entry of matchingEntries) {
    const tasks = entry.tasks || []

    for (const task of tasks) {
      if (!evaluateWhen(task.when, context, task.name)) continue

      // Handle env tasks (SessionStart only, startup/resume only)
      if (task.type === 'env') {
        const source = input.source || ''
        if (source !== 'startup' && source !== 'resume') continue
        const envResult = runEnvTask(task, context)
        if (envResult.error) {
          systemMessages.push(envResult.error)
          contextParts.push(envResult.error)
        } else {
          Object.assign(envVars, envResult.vars)
        }
        continue
      }

      let result
      if (task.type === 'script') {
        result = runScriptCheck(task, context)
      } else if (task.type === 'agent') {
        result = runAgentCheck(task, context)
      } else {
        continue
      }

      if (result.output) {
        context.testOutput = result.output
      }

      if (!result.pass) {
        if (hookEvent === 'SessionStart') {
          systemMessages.push(result.reason)
          contextParts.push(result.reason)
        } else {
          // For write-budget checks, record the run even on failure.
          // This resets the line counter, giving the agent a fresh write
          // budget to fix the issue (e.g. write the missing tests).
          // Without this, the check deadlocks: it demands tests but
          // blocks every Write/Edit — including writes to test files.
          if (task.when && task.when.linesWrittenSinceLastRun) {
            recordTaskRun(sessionId, task.name)
          }
          // PreToolUse/Stop: fail fast — block and exit immediately
          const failMsg = `prove_it: ${task.name} failed.\n\n${result.reason}`
          protocol.emit(hookEvent, protocol.failDecision(hookEvent), failMsg, failMsg)
          process.exit(0)
        }
      } else {
        if (task.when && task.when.linesWrittenSinceLastRun) {
          recordTaskRun(sessionId, task.name)
        }
        const text = result.reason || result.output
        if (text) {
          outputs.push(text)
          if (hookEvent === 'SessionStart') {
            contextParts.push(text)
          }
        }
      }
    }
  }

  // All checks passed (or SessionStart always continues)
  if (hookEvent === 'SessionStart') {
    // Write env vars to CLAUDE_ENV_FILE if any were collected
    if (Object.keys(envVars).length > 0) {
      writeEnvFile(envVars)
      const varNames = Object.keys(envVars).join(', ')
      contextParts.push(`prove_it: set env vars: ${varNames}`)
    }

    const additionalContext = contextParts.join('\n') || null
    const systemMessage = systemMessages.join('\n') || null
    protocol.emitSessionStart({ additionalContext, systemMessage })
    process.exit(0)
  }

  // Record source line writes after successful PreToolUse dispatch
  if (hookEvent === 'PreToolUse') {
    const writeInfo = computeWriteInfo(input, cfg.sources, rootDir)
    if (writeInfo.lines > 0) {
      recordWrite(sessionId, writeInfo.lines)
    }
  }

  // For PreToolUse/Stop: emit pass
  const summaryParts = outputs.filter(o => o && !o.startsWith('cached'))
  const summary = summaryParts.length > 0 ? summaryParts.join('\n') : 'all checks passed'
  protocol.emit(hookEvent, protocol.passDecision(hookEvent),
    `prove_it: ${summary}`)
  process.exit(0)
}

module.exports = { dispatch, matchesHookEntry, evaluateWhen, computeWriteInfo, defaultConfig, recordSessionBaseline, writeEnvFile }
