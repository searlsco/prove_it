const fs = require('fs')
const path = require('path')

const STRING_PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'notebook_path',
  'notebookPath',
  'target_path',
  'targetPath'
]

const ARRAY_PATH_KEYS = [
  'paths',
  'file_paths',
  'filePaths',
  'notebook_paths',
  'notebookPaths',
  'target_paths',
  'targetPaths'
]

const NESTED_PAYLOAD_KEYS = [
  'input',
  'tool_input',
  'toolInput',
  'edit',
  'write',
  'operation',
  'change'
]

const NESTED_ARRAY_KEYS = [
  'edits',
  'operations',
  'changes',
  'files'
]

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function addPath (paths, value) {
  if (typeof value !== 'string' || value.length === 0) return
  if (!paths.includes(value)) paths.push(value)
}

function addPathArray (paths, value, depth) {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item === 'string') {
      addPath(paths, item)
    } else if (isObject(item)) {
      addPayloadPaths(paths, item, depth + 1)
    }
  }
}

function addPayloadPaths (paths, payload, depth = 0) {
  if (!isObject(payload) || depth > 3) return

  for (const key of STRING_PATH_KEYS) addPath(paths, payload[key])
  for (const key of ARRAY_PATH_KEYS) addPathArray(paths, payload[key], depth)

  addBashWritePaths(paths, payload.command)
  addBashWritePaths(paths, payload.cmd)

  for (const key of NESTED_PAYLOAD_KEYS) addPayloadPaths(paths, payload[key], depth + 1)
  if (isObject(payload.tool)) addPayloadPaths(paths, payload.tool.input, depth + 1)
  for (const key of NESTED_ARRAY_KEYS) addPathArray(paths, payload[key], depth)
}

function shellPathTokenPattern () {
  return '"([^"\\n]+)"|\\\'([^\\\'\\n]+)\\\'|([^\\s;&|]+)'
}

function unescapeShellToken (token) {
  return String(token || '').replace(/\\([\\"'\s])/g, '$1')
}

function capturedShellPath (match) {
  return unescapeShellToken(match[1] || match[2] || match[3] || '')
}

function addBashWritePaths (paths, command) {
  if (typeof command !== 'string' || command.length === 0) return

  const token = shellPathTokenPattern()
  const redirectPattern = new RegExp(`(?:^|[\\s;&|])(?:\\d*)>>?\\s*(?:${token})`, 'g')
  let match
  while ((match = redirectPattern.exec(command)) !== null) addPath(paths, capturedShellPath(match))

  const teePattern = new RegExp(`(?:^|[\\s;&|])tee(?:\\s+-[A-Za-z]+)*\\s+(?:${token})`, 'g')
  while ((match = teePattern.exec(command)) !== null) addPath(paths, capturedShellPath(match))
}

function extractTargetPaths (payload) {
  const paths = []
  addPayloadPaths(paths, payload)
  return paths
}

function stripPathDecorators (targetPath) {
  let cleaned = String(targetPath || '')
  if (cleaned.startsWith('@')) cleaned = cleaned.slice(1)
  return cleaned.replace(/^\.\//, '')
}

function slashPath (targetPath) {
  return targetPath.split(path.sep).join('/')
}

function realpathBestEffort (absolutePath) {
  try {
    return fs.realpathSync(absolutePath)
  } catch {
    try {
      const dir = fs.realpathSync(path.dirname(absolutePath))
      return path.join(dir, path.basename(absolutePath))
    } catch {
      return path.resolve(absolutePath)
    }
  }
}

function insideRootRelative (absoluteTarget, absoluteRoot) {
  const relativePath = path.relative(absoluteRoot, absoluteTarget)
  if (!relativePath || relativePath === '') return ''
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  return relativePath
}

function relativeFromAbsoluteTarget (absoluteTarget, rootDir) {
  const resolvedRoot = path.resolve(rootDir)
  const realRoot = realpathBestEffort(resolvedRoot)
  const resolvedTarget = path.resolve(absoluteTarget)
  const realTarget = realpathBestEffort(resolvedTarget)

  return insideRootRelative(realTarget, realRoot) ?? insideRootRelative(resolvedTarget, resolvedRoot)
}

function toProjectRelativePath (targetPath, rootDir) {
  if (!targetPath || !rootDir) return null
  const cleaned = stripPathDecorators(targetPath)
  if (!cleaned) return null

  let relativePath
  if (path.isAbsolute(cleaned)) {
    relativePath = relativeFromAbsoluteTarget(cleaned, rootDir)
    if (relativePath === null) return null
  } else {
    relativePath = path.normalize(cleaned)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  }

  return slashPath(relativePath)
}

function normalizeProtectedPath (protectedPath) {
  const normalized = path.normalize(stripPathDecorators(protectedPath))
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null
  return slashPath(normalized)
}

function targetPathMatchesProtected (targetPath, protectedPath, rootDir) {
  const relativeTarget = toProjectRelativePath(targetPath, rootDir)
  const normalizedProtected = normalizeProtectedPath(protectedPath)
  if (!relativeTarget || !normalizedProtected) return false
  return relativeTarget === normalizedProtected
}

function targetPathMatchesAnyProtected (targetPath, protectedPaths, rootDir) {
  for (const protectedPath of protectedPaths || []) {
    if (targetPathMatchesProtected(targetPath, protectedPath, rootDir)) return protectedPath
  }
  return null
}

module.exports = {
  extractTargetPaths,
  targetPathMatchesAnyProtected,
  targetPathMatchesProtected,
  toProjectRelativePath
}
