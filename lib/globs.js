const fs = require('fs')
const path = require('path')

/**
 * Expand single-level brace groups: {a,b,c} → (?:a|b|c)
 */
function expandBraces (glob) {
  return glob.replace(/\{([^{}]+)\}/g, (_, contents) => {
    return '(?:' + contents.split(',').join('|') + ')'
  })
}

function globToRegex (glob) {
  // Expand braces into placeholders before escaping
  const altGroups = []
  const expanded = expandBraces(glob).replace(/\(\?:([^)]+)\)/g, (_, alts) => {
    altGroups.push(alts)
    return `{{ALT${altGroups.length - 1}}}`
  })
  let pattern = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  pattern = pattern.replace(/\*\*\//g, '{{DIRSTAR}}')
  pattern = pattern.replace(/\*\*/g, '{{GLOBSTAR}}')
  pattern = pattern.replace(/\*/g, '[^/]*')
  pattern = pattern.replace(/\?/g, '.')
  pattern = pattern.replace(/\{\{DIRSTAR\}\}/g, '(.*/)?')
  pattern = pattern.replace(/\{\{GLOBSTAR\}\}/g, '.*')
  // Restore alternation groups
  for (let i = 0; i < altGroups.length; i++) {
    const escaped = altGroups[i].split('|').map(a => a.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')
    pattern = pattern.replace(`\\{\\{ALT${i}\\}\\}`, `(?:${escaped})`)
  }
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

function matchesGlobList (relativePath, globs) {
  let matched = false
  for (const glob of globs) {
    const negated = glob.startsWith('!')
    const pattern = negated ? glob.slice(1) : glob
    if (globToRegex(pattern).test(relativePath)) {
      matched = !negated
    }
  }
  return matched
}

function expandGlobs (rootDir, globs) {
  const hasNegation = globs.some(g => g.startsWith('!'))

  if (!hasNegation) {
    const files = new Set()
    for (const glob of globs) {
      walkDir(rootDir, rootDir, globToRegex(glob), files)
    }
    return Array.from(files)
  }

  // Slow path: walk once with inclusion patterns, then filter through matchesGlobList
  const inclusions = globs.filter(g => !g.startsWith('!'))
  const candidates = new Set()
  for (const glob of inclusions) {
    walkDir(rootDir, rootDir, globToRegex(glob), candidates)
  }
  return Array.from(candidates).filter(f => matchesGlobList(f, globs))
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

  return matchesGlobList(relativePath, sources)
}

/**
 * Check if a file path matches any of the configured test globs.
 * Returns false if no tests configured.
 */
function isTestFile (filePath, rootDir, tests) {
  if (!tests || tests.length === 0) return false

  let relativePath
  if (path.isAbsolute(filePath)) {
    relativePath = path.relative(rootDir, filePath)
  } else {
    relativePath = filePath
  }

  if (relativePath.startsWith('..')) return false

  return matchesGlobList(relativePath, tests)
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
  expandBraces,
  globToRegex,
  matchesGlobList,
  walkDir,
  expandGlobs,
  isSourceFile,
  isTestFile,
  isProveItConfigPath,
  isLocalConfigWrite,
  isConfigFileEdit
}
