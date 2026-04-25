#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

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

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyFile (source, target) {
  ensureDir(path.dirname(target))
  fs.copyFileSync(source, target)
}

function resetDir (dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  ensureDir(dir)
}

function syncRuntime () {
  const runtimeDir = path.join(PACKAGE_DIR, 'runtime')
  resetDir(runtimeDir)
  for (const rel of RUNTIME_FILES) {
    copyFile(path.join(ROOT, rel), path.join(runtimeDir, rel))
  }
}

function syncSkills () {
  const sourceDir = path.join(ROOT, 'lib', 'skills')
  const targetDir = path.join(PACKAGE_DIR, 'skills')
  resetDir(targetDir)
  for (const name of fs.readdirSync(sourceDir).filter(name => name.endsWith('.md')).sort()) {
    copyFile(path.join(sourceDir, name), path.join(targetDir, name))
  }
}

function syncStaticFiles () {
  copyFile(path.join(ROOT, 'LICENSE'), path.join(PACKAGE_DIR, 'LICENSE'))
}

syncRuntime()
syncSkills()
syncStaticFiles()
console.log('Synced packages/pi-prove-it runtime, skills, and license.')
