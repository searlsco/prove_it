const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function shellEscape (str) {
  if (typeof str !== 'string') return String(str)
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

function readStdin () {
  return fs.readFileSync(0, 'utf8')
}

function loadJson (p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeJson (p, obj) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function ensureDir (p) {
  fs.mkdirSync(p, { recursive: true })
}

function emitJson (obj) {
  process.stdout.write(JSON.stringify(obj))
}

function truncateChars (s, maxChars) {
  if (s.length <= maxChars) return s
  return s.slice(-maxChars)
}

function tryRun (cmd, opts) {
  const { input, ...rest } = opts || {}
  const r = spawnSync(cmd, {
    ...rest,
    ...(input != null ? { input } : {}),
    shell: true,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  })
  return { code: r.status ?? (r.signal ? 1 : 0), signal: r.signal || null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

module.exports = {
  shellEscape,
  readStdin,
  loadJson,
  writeJson,
  ensureDir,
  emitJson,
  truncateChars,
  tryRun
}
