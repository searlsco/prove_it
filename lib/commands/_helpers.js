const fs = require('fs')
const os = require('os')
const path = require('path')

const SKILLS = [
  { name: 'prove', src: 'prove.md' },
  { name: 'prove-approach', src: 'prove-approach.md' },
  { name: 'prove-coverage', src: 'prove-coverage.md' },
  { name: 'prove-done', src: 'prove-done.md' },
  { name: 'prove-dry', src: 'prove-dry.md' },
  { name: 'prove-test-validity', src: 'prove-test-validity.md' }
]

const RETIRED_SKILLS = ['prove-shipworthy']

function rmIfExists (p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function getClaudeDir () {
  return path.join(os.homedir(), '.claude')
}

function log (...args) {
  console.log(...args)
}

function askYesNo (rl, question, defaultYes = true) {
  const hint = defaultYes ? '(Y/n)' : '(y/N)'
  return new Promise(resolve => {
    rl.question(`${question} ${hint} `, answer => {
      const trimmed = answer.trim().toLowerCase()
      if (trimmed === '') return resolve(defaultYes)
      resolve(trimmed === 'y' || trimmed === 'yes')
    })
  })
}

function guardProjectDir (label) {
  const cwd = fs.realpathSync(process.cwd())
  const home = fs.realpathSync(os.homedir())
  if (cwd === home) {
    console.error(`prove_it ${label} must be run inside a project directory, not your home directory.`)
    process.exit(1)
  }
  const claudePrefix = path.join(home, '.claude')
  if (cwd === claudePrefix || cwd.startsWith(claudePrefix + path.sep)) {
    console.error(`prove_it ${label} must be run inside a project directory, not inside ~/.claude/.`)
    process.exit(1)
  }
}

function removeProveItGroups (groups) {
  if (!Array.isArray(groups)) return groups
  return groups.filter(g => {
    const hooks = g && g.hooks ? g.hooks : []
    const serialized = JSON.stringify(hooks)
    // Remove all prove_it hook registrations (old .js files, short-form, v2 dispatch)
    if (serialized.includes('prove_it_test.js')) return false
    if (serialized.includes('prove_it_session_start.js')) return false
    if (serialized.includes('prove_it_stop.js')) return false
    if (serialized.includes('prove_it_done.js')) return false
    if (serialized.includes('prove_it_edit.js')) return false
    if (serialized.includes('prove_it hook ')) return false
    return true
  })
}

function findProveItGroup (settings, eventName) {
  const groups = settings.hooks?.[eventName]
  if (!Array.isArray(groups)) return null
  return groups.find(g => {
    const hooks = g && g.hooks ? g.hooks : []
    return hooks.some(h => h.command && h.command.includes('prove_it hook'))
  }) || null
}

function buildHookGroups () {
  return [
    {
      event: 'SessionStart',
      group: {
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'prove_it hook claude:SessionStart' }]
      }
    },
    {
      event: 'PreToolUse',
      group: {
        hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }]
      }
    },
    {
      event: 'PostToolUse',
      group: {
        hooks: [{ type: 'command', command: 'prove_it hook claude:PostToolUse' }]
      }
    },
    {
      event: 'PostToolUseFailure',
      group: {
        hooks: [{ type: 'command', command: 'prove_it hook claude:PostToolUseFailure' }]
      }
    },
    {
      event: 'Stop',
      group: {
        hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }]
      }
    },
    {
      event: 'TaskCompleted',
      group: {
        hooks: [{ type: 'command', command: 'prove_it hook claude:TaskCompleted' }]
      }
    }
  ]
}

module.exports = {
  SKILLS,
  RETIRED_SKILLS,
  rmIfExists,
  getClaudeDir,
  log,
  askYesNo,
  guardProjectDir,
  removeProveItGroups,
  findProveItGroup,
  buildHookGroups
}
