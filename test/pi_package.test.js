const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const ROOT = path.join(__dirname, '..')
const PACKAGE_DIR = path.join(ROOT, 'packages', 'pi-prove-it')

const RUNTIME_FILES = [
  'lib/adapter_capabilities.js',
  'lib/adapters/pi/bridge.js',
  'lib/adapters/pi/extension.js',
  'lib/adapters/pi/task_port.js',
  'lib/checks/script.js',
  'lib/config.js',
  'lib/defaults.js',
  'lib/git.js',
  'lib/globs.js',
  'lib/io.js',
  'lib/methodology.js',
  'lib/redesign/config.js',
  'lib/redesign/effects.js',
  'lib/redesign/engine.js',
  'lib/redesign/events.js',
  'lib/redesign/script_task_port.js',
  'lib/redesign/signal_lifecycle.js',
  'lib/redesign/state_port.js',
  'lib/redesign/target_paths.js',
  'lib/reviewer.js',
  'lib/session.js',
  'lib/template.js',
  'lib/validate.js'
]

function readJson (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function listSkillFiles () {
  return fs.readdirSync(path.join(ROOT, 'lib', 'skills'))
    .filter(name => name.endsWith('.md'))
    .sort()
}

function assertFileMatches (source, vendored) {
  assert.strictEqual(
    fs.readFileSync(vendored, 'utf8'),
    fs.readFileSync(source, 'utf8'),
    `${path.relative(ROOT, vendored)} is stale; run node tools/sync-pi-package.js`
  )
}

function localRequireClosure (entry) {
  const seen = new Set()
  function walk (filePath) {
    const absolute = path.resolve(filePath)
    if (seen.has(absolute)) return
    seen.add(absolute)
    const source = fs.readFileSync(absolute, 'utf8')
    const requirePattern = /require\(['"](\.\.?\/[^'"]+)['"]\)/g
    let match
    while ((match = requirePattern.exec(source))) {
      let required = path.resolve(path.dirname(absolute), match[1])
      if (fs.existsSync(`${required}.js`)) required = `${required}.js`
      else if (fs.existsSync(path.join(required, 'index.js'))) required = path.join(required, 'index.js')
      else continue
      if (required.startsWith(path.join(ROOT, 'lib'))) walk(required)
    }
  }
  walk(entry)
  return [...seen].map(filePath => path.relative(ROOT, filePath)).sort()
}

describe('Pi package scaffold', () => {
  it('declares a portable @davemo/pi-prove-it package with extension and skill resources', () => {
    const pkg = readJson(path.join(PACKAGE_DIR, 'package.json'))

    const rootPkg = readJson(path.join(ROOT, 'package.json'))

    assert.strictEqual(pkg.name, '@davemo/pi-prove-it')
    assert.strictEqual(pkg.version, rootPkg.version)
    assert.strictEqual(pkg.displayName, 'Pi')
    assert.ok(pkg.keywords.includes('pi-package'))
    assert.deepStrictEqual(pkg.pi.extensions, ['./extensions'])
    assert.deepStrictEqual(pkg.pi.skills, ['./skills'])
    assert.deepStrictEqual(pkg.prove_it, { adapterId: 'pi', displayName: 'Pi' })
    assert.ok(pkg.files.includes('extensions/'))
    assert.ok(pkg.files.includes('runtime/'))
    assert.ok(pkg.files.includes('skills/'))
    assert.ok(fs.existsSync(path.join(PACKAGE_DIR, 'extensions', 'prove-it.js')))
  })

  it('loads the packaged extension through the vendored runtime', () => {
    const handlers = {}
    const tools = {}
    const register = require(path.join(PACKAGE_DIR, 'extensions', 'prove-it.js'))

    register({
      on (eventName, handler) {
        handlers[eventName] = handler
      },
      registerTool (definition) {
        tools[definition.name] = definition
      }
    })

    assert.strictEqual(typeof handlers.before_agent_start, 'function')
    assert.strictEqual(typeof handlers.tool_call, 'function')
    assert.strictEqual(typeof handlers.turn_end, 'function')
    assert.strictEqual(typeof handlers.agent_end, 'function')
    assert.strictEqual(typeof tools.prove_it_signal.execute, 'function')
  })

  it('tracks the complete local runtime require closure for the Pi extension', () => {
    assert.deepStrictEqual(
      RUNTIME_FILES,
      localRequireClosure(path.join(ROOT, 'lib', 'adapters', 'pi', 'extension.js'))
    )
  })

  it('vendors the Pi runtime files without drift from the repository source', () => {
    for (const rel of RUNTIME_FILES) {
      assertFileMatches(
        path.join(ROOT, rel),
        path.join(PACKAGE_DIR, 'runtime', rel)
      )
    }
  })

  it('bundles every shipped prove_it skill without drift', () => {
    for (const skillFile of listSkillFiles()) {
      assertFileMatches(
        path.join(ROOT, 'lib', 'skills', skillFile),
        path.join(PACKAGE_DIR, 'skills', skillFile)
      )
    }
  })

  it('can build the Pi package tarball from the repo', () => {
    const result = childProcess.spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8'
    })

    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
    const packed = JSON.parse(result.stdout)[0]
    const files = new Set(packed.files.map(file => file.path))
    assert.ok(files.has('package.json'))
    assert.ok(files.has('extensions/prove-it.js'))
    assert.ok(files.has('runtime/lib/adapters/pi/extension.js'))
    assert.ok(files.has('runtime/lib/adapters/pi/task_port.js'))
    assert.ok(files.has('skills/prove.md'))
    assert.ok(files.has('skills/prove-done.md'))
  })
})
