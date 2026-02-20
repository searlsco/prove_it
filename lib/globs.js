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

/**
 * Check if a file path matches any of the configured source globs.
 * If no sources configured, all files are considered source files.
 */
function isSourceFile (filePath, rootDir, sources) {
  if (!sources || sources.length === 0) return true

  let relativePath
  if (path.isAbsolute(filePath)) {
    relativePath = path.relative(rootDir, filePath)
  } else {
    relativePath = filePath
  }

  if (relativePath.startsWith('..')) return false

  return sources.some(glob => globToRegex(glob).test(relativePath))
}

function isProveItConfigPath (filePath) {
  if (!filePath) return false
  if (/prove_it(\.local)?\.json/.test(filePath)) return true
  if (/prove_it\/config(\.local)?\.json/.test(filePath)) return true
  return false
}

function isLocalConfigWrite (command) {
  const cmd = command || ''
  const configPat = 'prove_it(\\.local)?\\.json|prove_it/config(\\.local)?\\.json'
  return new RegExp(`>\\s*\\S*(${configPat})|tee\\s+.*(${configPat})`).test(cmd)
}

function isConfigFileEdit (toolName, toolInput) {
  if (toolName !== 'Write' && toolName !== 'Edit') return false
  return isProveItConfigPath(toolInput?.file_path || '')
}

module.exports = {
  globToRegex,
  walkDir,
  expandGlobs,
  isSourceFile,
  isProveItConfigPath,
  isLocalConfigWrite,
  isConfigFileEdit
}
