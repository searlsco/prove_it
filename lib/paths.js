const path = require('path')
const { sanitizeTaskName } = require('./io')

function sessionsDir (rootDir) {
  return path.join(rootDir, '.claude', 'prove_it', 'sessions')
}

function sessionDir (rootDir, sessionId) {
  return path.join(sessionsDir(rootDir), sessionId)
}

function backchannelDir (rootDir, sessionId, taskName) {
  return path.join(sessionDir(rootDir, sessionId), 'backchannel', sanitizeTaskName(taskName))
}

function backchannelReadmePath (rootDir, sessionId, taskName) {
  return path.join(backchannelDir(rootDir, sessionId, taskName), 'README.md')
}

function backchannelPrefix (rootDir, sessionId) {
  return path.join(sessionDir(rootDir, sessionId), 'backchannel')
}

function notepadDir (rootDir, sessionId, taskName) {
  return path.join(sessionDir(rootDir, sessionId), 'notepad', sanitizeTaskName(taskName))
}

function notepadFilePath (rootDir, sessionId, taskName) {
  return path.join(notepadDir(rootDir, sessionId, taskName), 'README.md')
}

module.exports = {
  sessionsDir,
  sessionDir,
  backchannelDir,
  backchannelReadmePath,
  backchannelPrefix,
  notepadDir,
  notepadFilePath
}
