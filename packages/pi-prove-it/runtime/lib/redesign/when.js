const { isSourceFile, isTestFile } = require('../globs')
const { readPhase } = require('./phase_state')
const { readSignal } = require('./signal_lifecycle')
const { toProjectRelativePath } = require('./target_paths')

const OBSERVATION_STATE_KEYS = ['observations', 'facts']
const EDITING_TOOLS = new Set(['edit', 'write', 'multiedit', 'multi_edit', 'notebookedit', 'notebook_edit'])
const NET_CHURN_SEMANTICS = 'net:additions_plus_deletions_since_last_successful_run'
const GROSS_CHURN_SEMANTICS = 'gross:lines_written_by_edit_observations_since_last_successful_run'

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asArray (value) {
  if (Array.isArray(value)) return value
  if (value == null) return []
  return [value]
}

function readStateValue (statePort, sessionId, key) {
  if (!statePort || !key) return null
  try {
    if (typeof statePort.readSessionState === 'function') return statePort.readSessionState(sessionId, key)
    if (typeof statePort.read === 'function') return statePort.read(sessionId, key)
    if (typeof statePort.getSessionState === 'function') return statePort.getSessionState(sessionId, key)
  } catch {}
  return null
}

function providerFacts (provider, context) {
  if (!provider) return null
  try {
    if (typeof provider === 'function') return provider(context)
    if (typeof provider.getFacts === 'function') return provider.getFacts(context)
    if (typeof provider.readFacts === 'function') return provider.readFacts(context.event?.sessionId, context)
    if (typeof provider.facts === 'function') return provider.facts(context)
    if (isObject(provider.facts)) return provider.facts
  } catch {}
  return null
}

function observationFacts (context) {
  const direct = context.event?.facts || context.event?.observations
  if (isObject(direct)) return direct

  const fromProvider = providerFacts(context.ports?.observations, context)
  if (isObject(fromProvider)) return fromProvider

  for (const key of OBSERVATION_STATE_KEYS) {
    const fromState = readStateValue(context.ports?.state, context.event?.sessionId, key)
    if (isObject(fromState)) return fromState
  }

  return {}
}

function configuredGlobs (context, kind) {
  const globs = context.config?.globs || {}
  return globs[kind] || []
}

function relativePaths (paths, rootDir) {
  const result = []
  for (const candidate of asArray(paths)) {
    if (typeof candidate !== 'string') continue
    const relative = toProjectRelativePath(candidate, rootDir)
    if (relative) result.push(relative)
  }
  return result
}

function factFiles (facts) {
  return [
    ...asArray(facts.editedFiles),
    ...asArray(facts.filesEdited),
    ...asArray(facts.changedFiles)
  ].map(file => isObject(file) ? (file.path || file.file_path || file.filePath) : file)
}

function isClaudeEvent (event) {
  return String(event?.adapterId || event?.adapter || '').toLowerCase() === 'claude'
}

function configuredClaudeEditingTools (context) {
  if (!isClaudeEvent(context.event)) return []
  return asArray(context.config?.adapters?.claude?.file_editing_tools)
    .filter(tool => typeof tool === 'string')
    .map(tool => tool.toLowerCase())
}

function isEditingTool (toolName, context) {
  const normalized = String(toolName || '').toLowerCase()
  return EDITING_TOOLS.has(normalized) || configuredClaudeEditingTools(context).includes(normalized)
}

function eventEditedFiles (event, context) {
  if (!isEditingTool(event?.toolName, context)) return []
  return asArray(event?.targetPaths)
}

function editedFiles (context) {
  const facts = observationFacts(context)
  const files = [...eventEditedFiles(context.event, context), ...factFiles(facts)]
  return relativePaths(files, context.event?.rootDir || context.event?.cwd || process.cwd())
}

function matchesSourceGlob (filePath, context) {
  return isSourceFile(filePath, context.event?.rootDir || context.event?.cwd || process.cwd(), configuredGlobs(context, 'source'))
}

function matchesTestGlob (filePath, context) {
  return isTestFile(filePath, context.event?.rootDir || context.event?.cwd || process.cwd(), configuredGlobs(context, 'test'))
}

function skipped (taskName, reason, fields = {}) {
  return {
    passed: false,
    skipped: true,
    taskName,
    reason,
    ...fields
  }
}

function passed (fields = {}) {
  return {
    passed: true,
    skipped: false,
    ...fields
  }
}

function indexedValue (value, taskName) {
  if (isObject(value) && Object.prototype.hasOwnProperty.call(value, taskName)) return value[taskName]
  return value
}

function normalizeModifiedFact (value) {
  if (typeof value === 'boolean') return { modified: value }
  if (isObject(value)) {
    if (typeof value.modified === 'boolean') return value
    if (typeof value.changed === 'boolean') return { ...value, modified: value.changed }
  }
  return null
}

function factValue (facts, keys, taskName) {
  for (const key of keys) {
    if (facts[key] !== undefined) return indexedValue(facts[key], taskName)
  }
  return undefined
}

function churnFacts (facts, taskName) {
  const churn = isObject(facts.churn) ? facts.churn : {}
  return {
    net: factValue({ ...facts, ...churn }, ['netLinesChanged', 'linesChanged', 'net'], taskName),
    gross: factValue({ ...facts, ...churn }, ['grossLinesWritten', 'linesWritten', 'gross'], taskName)
  }
}

function evaluateSignal (expected, context, taskName) {
  if (expected === undefined) return passed()
  const active = readSignal(context.ports?.state, context.event?.sessionId)
  if (active?.type === expected) return passed({ evidence: active })
  return skipped(taskName, `Skipped because signal "${expected}" is not active`, { evidence: active || null })
}

function evaluatePhase (expected, context, taskName) {
  if (expected === undefined) return passed()
  const current = readPhase(context.ports?.state, context.event?.sessionId)
  if (current === expected) return passed({ evidence: { phase: current } })
  return skipped(taskName, `Skipped because phase is "${current}", not "${expected}"`, { evidence: { phase: current } })
}

function evaluateSourceFilesEdited (expected, context, taskName) {
  if (expected === undefined) return passed()
  const files = editedFiles(context)
  const matched = files.filter(file => matchesSourceGlob(file, context))
  const ok = matched.length > 0
  if (expected ? ok : !ok) return passed({ evidence: { editedFiles: files, matchedFiles: matched } })
  return skipped(taskName, 'Skipped because no source files were edited', {
    evidence: { editedFiles: files, matchedFiles: matched }
  })
}

function evaluateTestFilesEdited (expected, context, taskName) {
  if (expected === undefined) return passed()
  const files = editedFiles(context)
  const matched = files.filter(file => matchesTestGlob(file, context))
  const ok = matched.length > 0
  if (expected ? ok : !ok) return passed({ evidence: { editedFiles: files, matchedFiles: matched } })
  return skipped(taskName, 'Skipped because no test files were edited', {
    evidence: { editedFiles: files, matchedFiles: matched }
  })
}

function evaluateSourcesModifiedSinceLastRun (expected, context, taskName) {
  if (expected === undefined) return passed()
  const facts = observationFacts(context)
  const raw = factValue(facts, ['sourcesModifiedSinceLastRun', 'sourceModifiedSinceLastRun'], taskName)
  const fact = normalizeModifiedFact(raw)
  const modified = fact ? fact.modified : false
  if (expected ? modified : !modified) return passed({ evidence: fact || null })
  return skipped(taskName, 'Skipped because no sources were modified since the last run', {
    evidence: fact?.evidence || fact || null
  })
}

function evaluateLinesChanged (threshold, context, taskName) {
  if (threshold === undefined) return passed()
  const facts = observationFacts(context)
  const churn = churnFacts(facts, taskName)
  const value = Number.isFinite(churn.net) ? churn.net : 0
  if (value >= threshold) return passed({ evidence: { linesChanged: value }, semantics: NET_CHURN_SEMANTICS })
  return skipped(taskName, `Skipped because only ${value} of ${threshold} net lines changed since the last successful run`, {
    evidence: { linesChanged: value },
    semantics: NET_CHURN_SEMANTICS
  })
}

function evaluateLinesWritten (threshold, context, taskName) {
  if (threshold === undefined) return passed()
  const facts = observationFacts(context)
  const churn = churnFacts(facts, taskName)
  const value = Number.isFinite(churn.gross) ? churn.gross : 0
  if (value >= threshold) return passed({ evidence: { linesWritten: value }, semantics: GROSS_CHURN_SEMANTICS })
  return skipped(taskName, `Skipped because only ${value} of ${threshold} gross lines were written since the last successful run`, {
    evidence: { linesWritten: value },
    semantics: GROSS_CHURN_SEMANTICS
  })
}

function mergeEvidence (results) {
  const evidence = {}
  for (const result of results) {
    if (result.evidence !== undefined) evidence[result.reason || result.semantics || 'condition'] = result.evidence
  }
  return Object.keys(evidence).length > 0 ? evidence : null
}

function evaluateWhenClause (when, context, taskName) {
  if (!when) return passed()
  const results = [
    evaluateSignal(when.signal, context, taskName),
    evaluatePhase(when.phase, context, taskName),
    evaluateSourceFilesEdited(when.sourceFilesEdited, context, taskName),
    evaluateTestFilesEdited(when.testFilesEdited, context, taskName),
    evaluateSourcesModifiedSinceLastRun(when.sourcesModifiedSinceLastRun, context, taskName),
    evaluateLinesChanged(when.linesChanged, context, taskName),
    evaluateLinesWritten(when.linesWritten, context, taskName)
  ]
  const failed = results.find(result => !result.passed)
  if (!failed) return passed({ evidence: mergeEvidence(results) })
  return failed
}

function evaluateWhen (when, context, taskName) {
  if (!when) return passed()
  const clauses = Array.isArray(when) ? when : [when]
  let lastSkip = null
  for (const clause of clauses) {
    const result = evaluateWhenClause(clause, context, taskName)
    if (result.passed) return result
    lastSkip = result
  }
  return lastSkip || skipped(taskName, 'Skipped because no conditions were met')
}

module.exports = {
  GROSS_CHURN_SEMANTICS,
  NET_CHURN_SEMANTICS,
  evaluateWhen,
  evaluateWhenClause,
  observationFacts
}
