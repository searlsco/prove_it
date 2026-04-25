const path = require('path')
const { allowEffect, blockEffect: blockWorkflowEffect } = require('./effects')

const DEFAULT_PROTECTED_PATHS = [
  '.prove_it/config.json',
  '.prove_it/config.local.json'
]

const MUTATING_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'multi_edit',
  'notebookedit',
  'notebook_edit'
])

function normalizeToolName (toolName) {
  return String(toolName || '').toLowerCase()
}

function isMutatingTool (toolName) {
  return MUTATING_TOOLS.has(normalizeToolName(toolName))
}

function toProjectRelativePath (targetPath, rootDir) {
  if (!targetPath) return null
  let cleaned = targetPath.startsWith('@') ? targetPath.slice(1) : targetPath
  cleaned = cleaned.replace(/^\.\//, '')

  let relativePath = cleaned
  if (path.isAbsolute(cleaned)) {
    relativePath = path.relative(rootDir, cleaned)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  }

  return path.normalize(relativePath).split(path.sep).join('/')
}

function protectedPathMatch (targetPath, protectedPath, rootDir) {
  const relativeTarget = toProjectRelativePath(targetPath, rootDir)
  if (!relativeTarget) return false
  const normalizedProtected = path.normalize(protectedPath).split(path.sep).join('/')
  return relativeTarget === normalizedProtected
}

function configGuardBlockEffect (protectedPath) {
  return blockWorkflowEffect(`prove_it: Cannot modify protected prove_it config path ${protectedPath}`)
}

function evaluateConfigGuard (task, event) {
  if (!isMutatingTool(event.toolName)) return allowEffect()

  const protectedPaths = task.protected_paths || DEFAULT_PROTECTED_PATHS
  for (const targetPath of event.targetPaths) {
    for (const protectedPath of protectedPaths) {
      if (protectedPathMatch(targetPath, protectedPath, event.cwd)) {
        return configGuardBlockEffect(protectedPath)
      }
    }
  }

  return allowEffect()
}

function runPreToolWorkflow (config, event) {
  if (!config) return allowEffect()

  for (const taskName of config.agent_workflows.pre_tool) {
    const task = config.tasks[taskName]
    if (!task) continue
    if (task.type === 'config_guard') {
      const effect = evaluateConfigGuard(task, event)
      if (effect.effect === 'block') return effect
    }
  }

  return allowEffect()
}

module.exports = {
  DEFAULT_PROTECTED_PATHS,
  evaluateConfigGuard,
  isMutatingTool,
  protectedPathMatch,
  runPreToolWorkflow,
  toProjectRelativePath
}
