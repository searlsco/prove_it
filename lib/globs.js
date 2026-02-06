const fs = require('fs')
const path = require('path')

function globToRegex (glob) {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  pattern = pattern.replace(/\*\*\//g, '{{DIRSTAR}}')
  pattern = pattern.replace(/\*\*/g, '{{GLOBSTAR}}')
  pattern = pattern.replace(/\*/g, '[^/]*')
  pattern = pattern.replace(/\?/g, '.')
  pattern = pattern.replace(/\{\{DIRSTAR\}\}/g, '(.*/)?')
  pattern = pattern.replace(/\{\{GLOBSTAR\}\}/g, '.*')
  return new RegExp('^' + pattern + '$')
}

function walkDir (baseDir, currentDir, pattern, files) {
  let entries
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name)
    const relativePath = path.relative(baseDir, fullPath)

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      walkDir(baseDir, fullPath, pattern, files)
    } else if (entry.isFile() && pattern.test(relativePath)) {
      files.add(relativePath)
    }
  }
}

function expandGlobs (rootDir, globs) {
  const files = new Set()
  for (const glob of globs) {
    walkDir(rootDir, rootDir, globToRegex(glob), files)
  }
  return Array.from(files)
}

module.exports = {
  globToRegex,
  walkDir,
  expandGlobs
}
