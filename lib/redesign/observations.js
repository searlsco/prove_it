const { isSourceFile, isTestFile } = require('../globs')
const { toProjectRelativePath } = require('./target_paths')

const OBSERVATION_STATE_KEY = 'observations'
const MAX_SUMMARY_CHARS = 12000
const EDITING_TOOLS = new Set(['edit', 'write', 'multiedit', 'multi_edit', 'notebookedit', 'notebook_edit'])

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asArray (value) {
  if (Array.isArray(value)) return value
  if (value == null) return []
  return [value]
}

function readStateValue (statePort, sessionId, key) {
  if (!statePort || !sessionId || !key) return null
  try {
    if (typeof statePort.readSessionState === 'function') return statePort.readSessionState(sessionId, key)
    if (typeof statePort.read === 'function') return statePort.read(sessionId, key)
    if (typeof statePort.getSessionState === 'function') return statePort.getSessionState(sessionId, key)
  } catch {}
  return null
}

function writeStateValue (statePort, sessionId, key, value) {
  if (!statePort || !sessionId || !key) return false
  try {
    if (typeof statePort.writeSessionState === 'function') return statePort.writeSessionState(sessionId, key, value)
    if (typeof statePort.write === 'function') return statePort.write(sessionId, key, value)
    if (typeof statePort.setSessionState === 'function') return statePort.setSessionState(sessionId, key, value)
  } catch {}
  return false
}

function emptyObservationFacts (sessionId) {
  return {
    version: 1,
    sessionId,
    commandResults: [],
    failedCommands: [],
    toolResults: [],
    toolFailures: [],
    fileEdits: [],
    editedFiles: [],
    changedFiles: [],
    classifiedFiles: {},
    churn: {
      netLinesChanged: 0,
      grossLinesWritten: 0
    },
    summary: {
      commands: { succeeded: 0, failed: 0 },
      tools: { succeeded: 0, failed: 0 }
    }
  }
}

function readObservationFacts (statePort, sessionId) {
  const existing = readStateValue(statePort, sessionId, OBSERVATION_STATE_KEY)
  const facts = isObject(existing) ? existing : emptyObservationFacts(sessionId)
  const base = emptyObservationFacts(sessionId)
  return {
    ...base,
    ...facts,
    commandResults: asArray(facts.commandResults),
    failedCommands: asArray(facts.failedCommands),
    toolResults: asArray(facts.toolResults),
    toolFailures: asArray(facts.toolFailures),
    fileEdits: asArray(facts.fileEdits),
    editedFiles: asArray(facts.editedFiles),
    changedFiles: asArray(facts.changedFiles),
    classifiedFiles: isObject(facts.classifiedFiles) ? facts.classifiedFiles : {},
    churn: { ...base.churn, ...(isObject(facts.churn) ? facts.churn : {}) },
    summary: {
      commands: { ...base.summary.commands, ...(isObject(facts.summary?.commands) ? facts.summary.commands : {}) },
      tools: { ...base.summary.tools, ...(isObject(facts.summary?.tools) ? facts.summary.tools : {}) }
    }
  }
}

function addUnique (array, value) {
  if (value == null || value === '') return
  if (!array.includes(value)) array.push(value)
}

function configuredGlobs (config, kind) {
  return config?.globs?.[kind] || []
}

function classifyPath (relativePath, config, rootDir) {
  const source = isSourceFile(relativePath, rootDir, configuredGlobs(config, 'source'))
  const test = isTestFile(relativePath, rootDir, configuredGlobs(config, 'test'))
  return {
    path: relativePath,
    source,
    test,
    unrelated: !source && !test
  }
}

function truncateText (value, maxChars = MAX_SUMMARY_CHARS) {
  if (typeof value !== 'string') return undefined
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars) + '\n... (truncated)'
}

function firstFiniteNumber (...values) {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return undefined
}

function outputSummary (value) {
  if (typeof value === 'string') return { text: truncateText(value) }
  if (!isObject(value)) return null

  const summary = {}
  for (const key of ['stdout', 'stderr', 'text', 'output']) {
    const text = truncateText(value[key])
    if (text !== undefined) summary[key] = text
  }

  const exitCode = firstFiniteNumber(value.exitCode, value.exit_code, value.status, value.code)
  if (exitCode !== undefined) summary.exitCode = exitCode
  if (typeof value.interrupted === 'boolean') summary.interrupted = value.interrupted
  if (typeof value.success === 'boolean') summary.success = value.success
  if (typeof value.message === 'string') summary.message = truncateText(value.message)

  return Object.keys(summary).length > 0 ? summary : null
}

function errorSummary (value) {
  if (typeof value === 'string') return { message: truncateText(value) }
  if (!isObject(value)) return null

  const summary = {}
  for (const key of ['message', 'stderr', 'stdout', 'text', 'output']) {
    const text = truncateText(value[key])
    if (text !== undefined) summary[key] = text
  }

  const exitCode = firstFiniteNumber(value.exitCode, value.exit_code, value.status, value.code)
  if (exitCode !== undefined) summary.exitCode = exitCode
  if (typeof value.name === 'string') summary.name = value.name

  return Object.keys(summary).length > 0 ? summary : null
}

function lineCount (text) {
  if (typeof text !== 'string') return 0
  return text.split('\n').length
}

function grossLinesForEdit (toolName, toolInput) {
  const name = String(toolName || '').toLowerCase()
  if (!isObject(toolInput)) return 0

  if (name === 'write') return lineCount(toolInput.content)
  if (name === 'edit') return lineCount(toolInput.new_string)
  if (name === 'notebookedit' || name === 'notebook_edit') {
    if (toolInput.edit_mode === 'delete') return 0
    return lineCount(toolInput.new_source)
  }
  if (name === 'multiedit' || name === 'multi_edit') {
    let total = 0
    for (const edit of asArray(toolInput.edits)) total += lineCount(edit?.new_string)
    return total
  }

  let longestContent = ''
  for (const key of ['content', 'text', 'new_content', 'newContent', 'body', 'source', 'new_source', 'newSource', 'value']) {
    const value = toolInput[key]
    if (typeof value === 'string' && value.length > longestContent.length) longestContent = value
  }
  if (longestContent) return lineCount(longestContent)

  let longest = ''
  for (const value of Object.values(toolInput)) {
    if (typeof value === 'string' && value.length > longest.length) longest = value
  }
  return lineCount(longest)
}

function isClaudeEvent (event) {
  return String(event?.adapterId || event?.adapter || '').toLowerCase() === 'claude'
}

function configuredClaudeEditingTools (config, event) {
  if (!isClaudeEvent(event)) return []
  return asArray(config?.adapters?.claude?.file_editing_tools)
    .filter(tool => typeof tool === 'string')
    .map(tool => tool.toLowerCase())
}

function isEditingTool (toolName, config, event) {
  const normalized = String(toolName || '').toLowerCase()
  return EDITING_TOOLS.has(normalized) || configuredClaudeEditingTools(config, event).includes(normalized)
}

function normalizedTargetPaths (event) {
  const rootDir = event?.rootDir || event?.cwd || process.cwd()
  const paths = []
  for (const targetPath of asArray(event?.targetPaths)) {
    const relative = toProjectRelativePath(targetPath, rootDir)
    if (relative) addUnique(paths, relative)
  }
  return paths
}

function recordCommandObservation (facts, event, success) {
  if (String(event?.toolName || '').toLowerCase() !== 'bash' || !event?.command) return

  const responseSummary = outputSummary(event.tool?.response)
  const failureSummary = errorSummary(event.tool?.error)
  const exitCode = firstFiniteNumber(responseSummary?.exitCode, failureSummary?.exitCode)
  const observation = {
    type: 'command_result',
    sessionId: event.sessionId,
    stage: event.stage,
    toolName: event.toolName,
    command: event.command,
    success
  }
  if (exitCode !== undefined) observation.exitCode = exitCode
  if (responseSummary) observation.outputSummary = responseSummary
  if (failureSummary) observation.errorSummary = failureSummary

  facts.commandResults.push(observation)
  if (success) facts.summary.commands.succeeded += 1
  else {
    facts.failedCommands.push(observation)
    facts.summary.commands.failed += 1
  }
}

function recordToolResultObservation (facts, event, config, success) {
  const paths = normalizedTargetPaths(event)
  const observation = {
    type: success ? 'tool_result' : 'tool_failure',
    sessionId: event.sessionId,
    stage: event.stage,
    toolName: event.toolName,
    targetPaths: paths
  }
  if (paths.length === 0 && isEditingTool(event.toolName, config, event)) observation.missingTargetPath = true

  const responseSummary = outputSummary(event.tool?.response)
  const failureSummary = errorSummary(event.tool?.error)
  if (responseSummary) observation.outputSummary = responseSummary
  if (failureSummary) observation.errorSummary = failureSummary

  if (success) {
    facts.toolResults.push(observation)
    facts.summary.tools.succeeded += 1
  } else {
    facts.toolFailures.push(observation)
    facts.summary.tools.failed += 1
  }

  if (!isEditingTool(event.toolName, config, event) || paths.length === 0) return

  const rootDir = event?.rootDir || event?.cwd || process.cwd()
  const grossLinesWritten = grossLinesForEdit(event.toolName, event.toolInput)
  if (grossLinesWritten > 0) facts.churn.grossLinesWritten += grossLinesWritten

  for (const relativePath of paths) {
    addUnique(facts.editedFiles, relativePath)
    addUnique(facts.changedFiles, relativePath)
    facts.classifiedFiles[relativePath] = classifyPath(relativePath, config, rootDir)
    facts.fileEdits.push({
      type: 'file_edit',
      sessionId: event.sessionId,
      stage: event.stage,
      toolName: event.toolName,
      path: relativePath,
      classification: facts.classifiedFiles[relativePath],
      grossLinesWritten
    })
  }
}

function recordObservationFacts ({ statePort, event, config } = {}) {
  if (!statePort || !event?.sessionId) return { ok: false, reason: 'state_unavailable' }
  const isPostTool = event.stage === 'post_tool'
  const isPostToolFailure = event.stage === 'post_tool_failure'
  if (!isPostTool && !isPostToolFailure) return { ok: false, reason: 'not_observable_stage' }

  const facts = readObservationFacts(statePort, event.sessionId)
  const success = isPostTool
  recordCommandObservation(facts, event, success)
  recordToolResultObservation(facts, event, config, success)

  const ok = writeStateValue(statePort, event.sessionId, OBSERVATION_STATE_KEY, facts)
  return { ok, facts }
}

module.exports = {
  OBSERVATION_STATE_KEY,
  recordObservationFacts,
  readObservationFacts
}
