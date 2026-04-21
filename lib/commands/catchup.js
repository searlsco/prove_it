const fs = require('fs')
const { requireSessionId, log } = require('./_helpers')
const {
  isGitRepo,
  gitRoot,
  gitHead,
  gitStatusHash,
  updateRef,
  sanitizeRefName,
  readGrossCounter,
  writeCounterRef
} = require('../git')
const { loadEffectiveConfig } = require('../config')
const { configDefaults } = require('../defaults')
const {
  SESSION_KEYS,
  loadSessionState,
  saveSessionState,
  logReview
} = require('../session')
const { sanitizeTaskName } = require('../io')
const { cleanBackchannel } = require('../checks/agent')
const { backchannelDir } = require('../paths')

function enumerateTasks (cfg) {
  const names = new Set()
  const hooks = cfg.hooks || {}
  for (const type of Object.keys(hooks)) {
    const events = hooks[type] || {}
    for (const eventName of Object.keys(events)) {
      const tasks = events[eventName] || []
      for (const t of tasks) {
        if (t && t.name) names.add(t.name)
      }
    }
  }
  return Array.from(names)
}

function catchupTask (rootDir, sessionId, taskName) {
  const sanitized = sanitizeTaskName(taskName)
  const refName = sanitizeRefName(taskName)
  const cleared = []

  if (rootDir) {
    const head = gitHead(rootDir)
    if (head) {
      updateRef(rootDir, refName, head)
      cleared.push('refs')
    }
    const global = readGrossCounter(rootDir)
    writeCounterRef(rootDir, `${refName}.__gross_lines`, global)
  }

  const failures = loadSessionState(sessionId, SESSION_KEYS.SUCCESSIVE_FAILURES) || {}
  if (failures[sanitized]) {
    failures[sanitized] = 0
    saveSessionState(sessionId, SESSION_KEYS.SUCCESSIVE_FAILURES, failures)
    cleared.push('failures')
  }

  const suspended = loadSessionState(sessionId, SESSION_KEYS.SUSPENDED) || []
  const idx = suspended.indexOf(sanitized)
  if (idx !== -1) {
    suspended.splice(idx, 1)
    saveSessionState(sessionId, SESSION_KEYS.SUSPENDED, suspended)
    cleared.push('suspended')
  }

  if (rootDir) {
    const bcDir = backchannelDir(rootDir, sessionId, taskName)
    if (fs.existsSync(bcDir)) {
      cleanBackchannel(rootDir, sessionId, taskName)
      cleared.push('backchannel')
    }
  }

  return cleared
}

function cmdCatchup (taskNameArg) {
  const sessionId = requireSessionId('catchup')
  const projectDir = process.cwd()

  let cfg
  try {
    ({ cfg } = loadEffectiveConfig(projectDir, configDefaults))
  } catch (e) {
    console.error(`prove_it catchup: failed to load config: ${e.message}`)
    process.exit(1)
  }

  const allTaskNames = enumerateTasks(cfg)

  let taskNames
  if (taskNameArg) {
    if (!allTaskNames.includes(taskNameArg)) {
      console.error(`prove_it catchup: unknown task '${taskNameArg}'`)
      if (allTaskNames.length > 0) {
        console.error(`Available tasks: ${allTaskNames.join(', ')}`)
      }
      process.exit(1)
    }
    taskNames = [taskNameArg]
  } else {
    taskNames = allTaskNames
  }

  const inGit = isGitRepo(projectDir)
  const rootDir = inGit ? gitRoot(projectDir) : null
  const head = inGit && rootDir ? gitHead(rootDir) : null

  for (const taskName of taskNames) {
    const cleared = catchupTask(rootDir, sessionId, taskName)
    if (cleared.length > 0) {
      log(`prove_it: catchup advanced ${taskName} (${cleared.join('+')} cleared)`)
    }
  }

  if (!taskNameArg) {
    if (inGit && head) {
      saveSessionState(sessionId, SESSION_KEYS.GIT, {
        is_repo: true,
        root: rootDir,
        head,
        status_hash: gitStatusHash(rootDir)
      })
      saveSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD, null)
      saveSessionState(sessionId, SESSION_KEYS.LAST_REVIEW_SNAPSHOT, null)
      log(`prove_it: session baseline advanced to ${head.slice(0, 7)}`)
    } else {
      saveSessionState(sessionId, SESSION_KEYS.LAST_STOP_HEAD, null)
      saveSessionState(sessionId, SESSION_KEYS.LAST_REVIEW_SNAPSHOT, null)
      log('prove_it: not a git repository; skipped baseline advance')
    }
  }

  logReview(
    sessionId,
    projectDir,
    'catchup',
    'INFO',
    taskNameArg ? `task=${taskNameArg}` : `tasks=${taskNames.length}`,
    null,
    null
  )
}

module.exports = { cmdCatchup, enumerateTasks }
