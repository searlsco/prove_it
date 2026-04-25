const { loadEffectiveConfig } = require('../redesign/config')

function cmdExplain () {
  try {
    const explained = loadEffectiveConfig(process.cwd(), { explain: true })
    console.log(JSON.stringify(explained, null, 2))
  } catch (error) {
    console.error(`prove_it explain failed: ${error.message}`)
    process.exit(1)
  }
}

module.exports = { cmdExplain }
