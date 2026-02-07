// Barrel re-export: all public functions from focused modules
const io = require('./io')
const git = require('./git')
const config = require('./config')
const globs = require('./globs')
const testing = require('./testing')
const session = require('./session')
const reviewer = require('./reviewer')
const template = require('./template')

module.exports = {
  ...io,
  ...git,
  ...config,
  ...globs,
  ...testing,
  ...session,
  ...reviewer,
  ...template
}
