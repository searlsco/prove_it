const crypto = require('crypto')
const { shellEscape, tryRun } = require('./io')

function sha256 (s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function isGitRepo (dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse --is-inside-work-tree`, {})
  return r.code === 0 && r.stdout.trim() === 'true'
}

function gitRoot (dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse --show-toplevel`, {})
  if (r.code !== 0) return null
  return r.stdout.trim()
}

function gitHead (dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse HEAD`, {})
  if (r.code !== 0) return null
  return r.stdout.trim()
}

function gitStatusHash (dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} status --porcelain=v1`, {})
  if (r.code !== 0) return null
  return sha256(r.stdout)
}

function gitTrackedFiles (dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} ls-files`, {})
  if (r.code !== 0) return []
  return r.stdout.split('\n').filter(Boolean)
}

function gitDiffFiles (dir, baseHead, files) {
  if (!baseHead || !files || files.length === 0) return ''
  const escapedFiles = files.map(f => shellEscape(f)).join(' ')
  const r = tryRun(`git -C ${shellEscape(dir)} diff ${shellEscape(baseHead)} -- ${escapedFiles}`, {})
  if (r.code !== 0) return ''
  return r.stdout.trim()
}

module.exports = {
  isGitRepo,
  gitRoot,
  gitHead,
  gitStatusHash,
  gitTrackedFiles,
  gitDiffFiles
}
