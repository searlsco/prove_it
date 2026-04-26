const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const MIN_GIT_CONFIG_HOOK_VERSION = Object.freeze({ major: 2, minor: 54, patch: 0 })

const PROVE_IT_GIT_CONFIG_HOOKS = Object.freeze({
  'pre-commit': Object.freeze({
    event: 'pre-commit',
    stage: 'pre_commit',
    name: 'prove-it-pre-commit',
    command: 'prove_it hook git:pre-commit'
  }),
  'pre-push': Object.freeze({
    event: 'pre-push',
    stage: 'pre_push',
    name: 'prove-it-pre-push',
    command: 'prove_it hook git:pre-push'
  })
})

function gitConfigKey (hook, field) {
  return `hook.${hook.name}.${field}`
}

function runGit (repoRoot, args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
}

function parseGitVersion (value) {
  const match = String(value || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
    raw: match[0]
  }
}

function compareVersion (actual, minimum) {
  for (const key of ['major', 'minor', 'patch']) {
    if (actual[key] > minimum[key]) return 1
    if (actual[key] < minimum[key]) return -1
  }
  return 0
}

function gitVersion (repoRoot) {
  if (process.env.PROVE_IT_TEST_GIT_VERSION) {
    const parsed = parseGitVersion(process.env.PROVE_IT_TEST_GIT_VERSION)
    return parsed ? { ...parsed, output: `git version ${parsed.raw}` } : null
  }
  const result = runGit(repoRoot, ['--version'])
  if (result.status !== 0) return null
  const parsed = parseGitVersion(result.stdout)
  return parsed ? { ...parsed, output: result.stdout.trim() } : null
}

function gitConfigHooksSupported (repoRoot) {
  const version = gitVersion(repoRoot)
  if (!version) {
    return {
      supported: false,
      version: null,
      reason: 'Git version could not be detected; Git 2.54+ is required'
    }
  }
  if (compareVersion(version, MIN_GIT_CONFIG_HOOK_VERSION) < 0) {
    return {
      supported: false,
      version,
      reason: `Git ${version.raw} detected; Git 2.54+ is required`
    }
  }
  return { supported: true, version, reason: null }
}

function gitConfigGetAll (repoRoot, key) {
  const result = runGit(repoRoot, ['config', '--local', '--get-all', key])
  if (result.status !== 0) return []
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

function gitConfigUnsetAll (repoRoot, key) {
  runGit(repoRoot, ['config', '--local', '--unset-all', key])
}

function gitConfigSet (repoRoot, key, value) {
  const result = runGit(repoRoot, ['config', '--local', '--replace-all', key, value])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git config failed for ${key}`)
}

function gitConfigAdd (repoRoot, key, value) {
  const result = runGit(repoRoot, ['config', '--local', '--add', key, value])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git config failed for ${key}`)
}

function activeGitWorkflowEvents (effectiveConfig) {
  const workflows = effectiveConfig?.git_workflows || {}
  return Object.values(PROVE_IT_GIT_CONFIG_HOOKS)
    .filter(hook => Array.isArray(workflows[hook.stage]) && workflows[hook.stage].length > 0)
    .map(hook => hook.event)
}

function configureGitConfigHook (repoRoot, event) {
  const hook = PROVE_IT_GIT_CONFIG_HOOKS[event]
  if (!hook) throw new Error(`unsupported prove_it git hook event: ${event}`)
  if (!fs.existsSync(path.join(repoRoot, '.git'))) return { configured: false, skipped: true, reason: 'not a git repository' }
  const support = gitConfigHooksSupported(repoRoot)
  if (!support.supported) return { configured: false, skipped: true, reason: support.reason, support }

  gitConfigSet(repoRoot, gitConfigKey(hook, 'command'), hook.command)
  gitConfigUnsetAll(repoRoot, gitConfigKey(hook, 'event'))
  gitConfigAdd(repoRoot, gitConfigKey(hook, 'event'), hook.event)
  gitConfigSet(repoRoot, gitConfigKey(hook, 'enabled'), 'true')
  return { configured: true, skipped: false, hook }
}

function removeGitConfigHook (repoRoot, event) {
  const hook = PROVE_IT_GIT_CONFIG_HOOKS[event]
  if (!hook) return false
  const keys = ['command', 'event', 'enabled'].map(field => gitConfigKey(hook, field))
  const existed = keys.some(key => gitConfigGetAll(repoRoot, key).length > 0)
  for (const key of keys) gitConfigUnsetAll(repoRoot, key)
  return existed
}

function inspectGitConfigHook (repoRoot, event) {
  const hook = PROVE_IT_GIT_CONFIG_HOOKS[event]
  if (!hook) throw new Error(`unsupported prove_it git hook event: ${event}`)
  const support = gitConfigHooksSupported(repoRoot)
  if (!support.supported) {
    return { event, hook, supported: false, active: false, reason: support.reason, support }
  }

  const commands = gitConfigGetAll(repoRoot, gitConfigKey(hook, 'command'))
  const events = gitConfigGetAll(repoRoot, gitConfigKey(hook, 'event'))
  const enabled = gitConfigGetAll(repoRoot, gitConfigKey(hook, 'enabled'))
  const commandOk = commands[commands.length - 1] === hook.command
  const eventOk = events.includes(hook.event)
  const enabledOk = enabled.length === 0 || enabled[enabled.length - 1] !== 'false'
  const active = commandOk && eventOk && enabledOk
  return {
    event,
    hook,
    supported: true,
    active,
    commandOk,
    eventOk,
    enabledOk,
    commands,
    events,
    enabled
  }
}

module.exports = {
  MIN_GIT_CONFIG_HOOK_VERSION,
  PROVE_IT_GIT_CONFIG_HOOKS,
  activeGitWorkflowEvents,
  configureGitConfigHook,
  gitConfigHooksSupported,
  inspectGitConfigHook,
  parseGitVersion,
  removeGitConfigHook
}
