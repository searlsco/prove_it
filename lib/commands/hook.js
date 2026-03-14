function cmdHook (hookSpec) {
  if (!hookSpec || !hookSpec.includes(':')) {
    console.error(`Invalid hook spec: ${hookSpec}`)
    console.error('Usage: prove_it hook claude:<Event> or prove_it hook git:<event>')
    console.error('Examples: prove_it hook claude:Stop, prove_it hook git:pre-commit')
    process.exit(1)
  }

  const [type, event] = hookSpec.split(':', 2)

  if (type === 'claude') {
    const { dispatch } = require('../dispatcher/claude')
    dispatch(event).catch(e => {
      console.error(`prove_it: dispatch error: ${e.message}`)
      process.exit(1)
    })
  } else if (type === 'git') {
    const { dispatch } = require('../dispatcher/git')
    dispatch(event)
  } else {
    console.error(`Unknown hook type: ${type}`)
    console.error('Supported types: claude, git')
    process.exit(1)
  }
}

module.exports = { cmdHook }
