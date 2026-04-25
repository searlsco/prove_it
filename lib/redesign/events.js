const LIFECYCLE_STAGES = Object.freeze({
  SESSION_START: 'session_start',
  PRE_TOOL: 'pre_tool',
  POST_TOOL: 'post_tool',
  POST_TOOL_FAILURE: 'post_tool_failure',
  AGENT_END: 'agent_end',
  PRE_COMMIT: 'pre_commit',
  PRE_PUSH: 'pre_push'
})

const RAW_EVENT_STAGE_MAP = Object.freeze({
  SessionStart: LIFECYCLE_STAGES.SESSION_START,
  before_agent_start: LIFECYCLE_STAGES.SESSION_START,
  session_start: LIFECYCLE_STAGES.SESSION_START,

  PreToolUse: LIFECYCLE_STAGES.PRE_TOOL,
  tool_call: LIFECYCLE_STAGES.PRE_TOOL,
  pre_tool: LIFECYCLE_STAGES.PRE_TOOL,

  PostToolUse: LIFECYCLE_STAGES.POST_TOOL,
  tool_result: LIFECYCLE_STAGES.POST_TOOL,
  post_tool: LIFECYCLE_STAGES.POST_TOOL,

  PostToolUseFailure: LIFECYCLE_STAGES.POST_TOOL_FAILURE,
  tool_error: LIFECYCLE_STAGES.POST_TOOL_FAILURE,
  post_tool_failure: LIFECYCLE_STAGES.POST_TOOL_FAILURE,

  Stop: LIFECYCLE_STAGES.AGENT_END,
  AgentEnd: LIFECYCLE_STAGES.AGENT_END,
  agent_end: LIFECYCLE_STAGES.AGENT_END,
  stop: LIFECYCLE_STAGES.AGENT_END,

  'pre-commit': LIFECYCLE_STAGES.PRE_COMMIT,
  pre_commit: LIFECYCLE_STAGES.PRE_COMMIT,

  'pre-push': LIFECYCLE_STAGES.PRE_PUSH,
  pre_push: LIFECYCLE_STAGES.PRE_PUSH
})

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function firstString (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function addPath (paths, value) {
  if (typeof value !== 'string' || value.length === 0) return
  if (!paths.includes(value)) paths.push(value)
}

function addPathArray (paths, value) {
  if (!Array.isArray(value)) return
  for (const path of value) addPath(paths, path)
}

function addPayloadPaths (paths, payload) {
  if (!isObject(payload)) return

  addPath(paths, payload.path)
  addPath(paths, payload.file_path)
  addPath(paths, payload.filePath)
  addPath(paths, payload.notebook_path)
  addPath(paths, payload.notebookPath)
  addPathArray(paths, payload.paths)
  addPathArray(paths, payload.target_paths)
  addPathArray(paths, payload.targetPaths)
}

function extractTargetPaths (payload) {
  const paths = []
  if (!isObject(payload)) return paths

  addPayloadPaths(paths, payload)
  addPayloadPaths(paths, payload.input)
  addPayloadPaths(paths, payload.tool_input)
  addPayloadPaths(paths, payload.toolInput)
  addPayloadPaths(paths, payload.tool?.input)

  return paths
}

function extractToolName (rawEvent) {
  return firstString(
    rawEvent?.toolName,
    rawEvent?.tool_name,
    rawEvent?.tool?.name
  )
}

function extractToolInput (rawEvent) {
  if (isObject(rawEvent?.toolInput)) return rawEvent.toolInput
  if (isObject(rawEvent?.tool_input)) return rawEvent.tool_input
  if (isObject(rawEvent?.input)) return rawEvent.input
  if (isObject(rawEvent?.tool?.input)) return rawEvent.tool.input
  return {}
}

function extractToolResponse (rawEvent) {
  if (rawEvent?.toolResponse !== undefined) return rawEvent.toolResponse
  if (rawEvent?.tool_response !== undefined) return rawEvent.tool_response
  if (rawEvent?.response !== undefined) return rawEvent.response
  if (rawEvent?.tool?.response !== undefined) return rawEvent.tool.response
  return null
}

function extractToolError (rawEvent) {
  if (rawEvent?.toolError !== undefined) return rawEvent.toolError
  if (rawEvent?.tool_error !== undefined) return rawEvent.tool_error
  if (rawEvent?.error !== undefined) return rawEvent.error
  if (rawEvent?.tool?.error !== undefined) return rawEvent.tool.error
  return null
}

function extractCommand (rawEvent, toolInput) {
  return firstString(
    rawEvent?.command,
    rawEvent?.cmd,
    toolInput?.command,
    toolInput?.cmd
  )
}

function normalizeStage (rawEventName, rawEvent, ctx) {
  const stage = firstString(
    ctx.stage,
    rawEvent?.stage,
    rawEvent?.hookEventName,
    rawEvent?.hook_event_name,
    rawEventName
  )
  return RAW_EVENT_STAGE_MAP[stage] || stage
}

function normalizeSource (rawEvent, ctx) {
  return {
    kind: firstString(ctx.source, rawEvent?.source, rawEvent?.source_kind) || null,
    transcriptPath: firstString(ctx.transcriptPath, rawEvent?.transcript_path, rawEvent?.transcriptPath) || null,
    metadata: ctx.sourceMetadata || rawEvent?.source_metadata || rawEvent?.sourceMetadata || null
  }
}

function normalizeResume (rawEvent, ctx, source) {
  return {
    isResume: Boolean(ctx.resume || rawEvent?.resume || rawEvent?.is_resume || source.kind === 'resume'),
    metadata: ctx.resumeMetadata || rawEvent?.resume_metadata || rawEvent?.resumeMetadata || null
  }
}

function normalizeLifecycleEvent ({ adapterId, rawEventName, rawEvent = {}, ...ctx } = {}) {
  const event = isObject(rawEvent) ? rawEvent : {}
  const cwd = firstString(ctx.cwd, event.cwd, event.project_dir, event.projectDir, process.cwd())
  const projectDir = firstString(ctx.projectDir, ctx.project_dir, event.projectDir, event.project_dir, cwd)
  const rootDir = firstString(ctx.rootDir, ctx.root_dir, event.rootDir, event.root_dir, projectDir, cwd)
  const toolName = extractToolName(event) || ''
  const toolInput = extractToolInput(event)
  const source = normalizeSource(event, ctx)

  return {
    adapterId,
    adapter: adapterId,
    rawEventName,
    rawEvent: event,
    stage: normalizeStage(rawEventName, event, ctx),
    sessionId: firstString(ctx.sessionId, ctx.session_id, event.sessionId, event.session_id),
    projectDir,
    rootDir,
    cwd,
    tool: {
      name: toolName,
      input: toolInput,
      response: extractToolResponse(event),
      error: extractToolError(event)
    },
    toolName,
    toolInput,
    command: extractCommand(event, toolInput),
    targetPaths: extractTargetPaths(event),
    source,
    resume: normalizeResume(event, ctx, source)
  }
}

function normalizePiToolCall (event, ctx = {}) {
  return normalizeLifecycleEvent({
    adapterId: 'pi',
    rawEventName: 'tool_call',
    rawEvent: event,
    ...ctx
  })
}

module.exports = {
  LIFECYCLE_STAGES,
  RAW_EVENT_STAGE_MAP,
  extractTargetPaths,
  normalizeLifecycleEvent,
  normalizePiToolCall
}
