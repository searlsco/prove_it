function cmdMonitor () {
  const { monitor } = require('../monitor')
  const args = process.argv.slice(3)

  const all = args.includes('--all')
  const list = args.includes('--list')
  const showSession = args.includes('--sessions')
  const verbose = args.includes('--verbose')
  const statusArg = args.find(a => a.startsWith('--status='))
  const statusFilter = statusArg ? statusArg.slice('--status='.length).split(',').map(s => s.trim().toUpperCase()) : null

  const noStatusArg = args.find(a => a.startsWith('--no-status='))
  const statusExclude = noStatusArg ? noStatusArg.slice('--no-status='.length).split(',').map(s => s.trim().toUpperCase()) : null

  const taskArg = args.find(a => a.startsWith('--task='))
  const taskFilter = taskArg ? taskArg.slice('--task='.length).split(',').map(s => s.trim().toLowerCase()) : null

  const noTaskArg = args.find(a => a.startsWith('--no-task='))
  const taskExclude = noTaskArg ? noTaskArg.slice('--no-task='.length).split(',').map(s => s.trim().toLowerCase()) : null

  // --project alone -> CWD, --project=/path -> specified path
  const projectArg = args.find(a => a === '--project' || a.startsWith('--project='))
  let project = null
  if (projectArg === '--project') {
    project = process.cwd()
  } else if (projectArg && projectArg.startsWith('--project=')) {
    project = projectArg.slice('--project='.length)
  }

  const sessionId = args.find(a => !a.startsWith('--')) || null

  monitor({ all, list, showSession, verbose, statusFilter, statusExclude, taskFilter, taskExclude, project, sessionId })
}

module.exports = { cmdMonitor }
