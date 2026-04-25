function addPath (paths, value) {
  if (typeof value !== 'string' || value.length === 0) return
  if (!paths.includes(value)) paths.push(value)
}

function extractTargetPaths (payload) {
  const paths = []
  if (!payload || typeof payload !== 'object') return paths

  addPath(paths, payload.path)
  addPath(paths, payload.file_path)
  addPath(paths, payload.notebook_path)

  if (payload.input && typeof payload.input === 'object') {
    addPath(paths, payload.input.path)
    addPath(paths, payload.input.file_path)
    addPath(paths, payload.input.notebook_path)
  }

  if (payload.tool_input && typeof payload.tool_input === 'object') {
    addPath(paths, payload.tool_input.path)
    addPath(paths, payload.tool_input.file_path)
    addPath(paths, payload.tool_input.notebook_path)
  }

  return paths
}

function normalizePiToolCall (event, ctx = {}) {
  const input = event && typeof event.input === 'object' && event.input !== null
    ? event.input
    : {}

  return {
    adapter: 'pi',
    rawEventName: 'tool_call',
    stage: 'pre_tool',
    cwd: ctx.cwd || event?.cwd || process.cwd(),
    toolName: event?.toolName || event?.tool_name || '',
    toolInput: input,
    targetPaths: extractTargetPaths(event)
  }
}

module.exports = {
  extractTargetPaths,
  normalizePiToolCall
}
