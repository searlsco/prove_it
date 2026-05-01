const { behaviorForCapability } = require('../../adapter_capabilities')
const { normalizeLifecycleEvent } = require('../../redesign/events')
const { runWorkflowEngine } = require('../../redesign/engine')
const { LEGACY_CONFIG_DENY_REASON } = require('./effects')

const LEGACY_CLAUDE_CONFIG_PATHS = [
  '.claude/prove_it.json',
  '.claude/prove_it.local.json',
  '.claude/prove_it/config.json',
  '.claude/prove_it/config.local.json'
]

function isLegacyGuardConfigTask (task) {
  return task?.type === 'script' && /(?:^|\/)libexec\/guard-config(?:\s|$)/.test(String(task.command || ''))
}

function hasGlobMagic (protectedPath) {
  return /[*?{}[\]]/.test(protectedPath)
}

function legacyGuardProtectedPaths (task) {
  const paths = task?.params?.paths
  if (Array.isArray(paths) && paths.length > 0) return paths
  return [...LEGACY_CLAUDE_CONFIG_PATHS]
}

function legacyGuardDenyReason (task) {
  const paths = task?.params?.paths
  if (Array.isArray(paths) && paths.length > 0) {
    return 'prove_it: Cannot modify guarded paths\n\n' +
      'Protected patterns: ' + paths.join(', ') + '\n' +
      'To modify them, run the command directly in your terminal (not through Claude).'
  }
  return LEGACY_CONFIG_DENY_REASON
}

function sharedConfigForGuardTask (task) {
  const protectedPaths = legacyGuardProtectedPaths(task)
  if (protectedPaths.some(path => typeof path !== 'string' || hasGlobMagic(path))) return null

  const taskName = task.name || 'claude_guard_config'
  return {
    tasks: {
      [taskName]: {
        type: 'config_guard',
        protected_paths: protectedPaths
      }
    },
    agent_workflows: {
      pre_tool: [taskName]
    }
  }
}

function normalizeClaudePreToolUseEvent ({ input, projectDir, rootDir }) {
  return normalizeLifecycleEvent({
    adapterId: 'claude',
    rawEventName: 'PreToolUse',
    rawEvent: input,
    cwd: input?.cwd || projectDir || process.cwd(),
    projectDir,
    rootDir
  })
}

function runClaudePreToolUseTaskThroughSharedEngine ({
  task,
  input,
  projectDir,
  rootDir,
  statePort = null,
  effectPort = null
} = {}) {
  if (!isLegacyGuardConfigTask(task)) return { handled: false }

  const event = normalizeClaudePreToolUseEvent({ input, projectDir, rootDir })
  if (event.targetPaths.length === 0) return { handled: false }

  const effectiveConfig = sharedConfigForGuardTask(task)
  if (!effectiveConfig) return { handled: false }

  const effect = runWorkflowEngine({
    event,
    effectiveConfig,
    adapterCapabilities: {
      pre_tool_blocking: behaviorForCapability('claude', 'pre_tool_blocking')
    },
    statePort,
    effectPort
  })

  if (effect.effect !== 'block' && effect.effect !== 'fail') return { handled: false }

  return {
    handled: true,
    effect: {
      ...effect,
      adapter: 'claude',
      capability: 'pre_tool_blocking',
      legacyReason: legacyGuardDenyReason(task)
    }
  }
}

module.exports = {
  LEGACY_CLAUDE_CONFIG_PATHS,
  isLegacyGuardConfigTask,
  legacyGuardDenyReason,
  legacyGuardProtectedPaths,
  runClaudePreToolUseTaskThroughSharedEngine
}
