const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

// Cache template repos keyed by setup-function identity.
// Creating a git repo (init + config + add + commit) costs ~5 spawnSync calls.
// Copying a cached template via fs.cpSync is ~10x faster.
const templates = new Map()

function buildTemplate (setupFn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_tmpl_'))
  spawnSync('git', ['init'], { cwd: dir })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  if (setupFn) {
    setupFn(dir)
  } else {
    fs.writeFileSync(path.join(dir, '.gitkeep'), '')
  }
  spawnSync('git', ['add', '.'], { cwd: dir })
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

/**
 * Create a fresh git repo by copying a cached template.
 *
 * @param {Function} [setupFn] - Optional function(dir) to create initial files.
 *   When omitted, the repo contains only `.gitkeep`. The setup function is
 *   called once to build the template; subsequent calls with the same function
 *   reference reuse the cached copy.
 * @returns {string} Path to the new temporary directory.
 */
function freshRepo (setupFn) {
  const key = setupFn || '__default__'
  if (!templates.has(key)) {
    templates.set(key, buildTemplate(setupFn))
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_test_'))
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.cpSync(templates.get(key), tmpDir, { recursive: true })
  return tmpDir
}

module.exports = { freshRepo }
