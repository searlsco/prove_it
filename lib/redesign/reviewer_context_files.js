const fs = require('fs')
const path = require('path')

function reviewerRootDir (event = {}) {
  return event.rootDir || event.projectDir || event.cwd || process.cwd()
}

function pathInsideRoot (targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function contextFilePathError (filePath, index, reason) {
  return new Error(`context_files[${index}] ${reason}: ${filePath}`)
}

function readReviewerContextFiles (task = {}, event = {}) {
  if (!Array.isArray(task.context_files) || task.context_files.length === 0) return []

  const rootDir = reviewerRootDir(event)
  const rootPath = path.resolve(rootDir)
  let realRoot = rootPath
  try {
    realRoot = fs.realpathSync(rootPath)
  } catch {}

  return task.context_files.map((filePath, index) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw contextFilePathError(String(filePath), index, 'must be a non-empty project-relative path')
    }
    if (path.isAbsolute(filePath)) {
      throw contextFilePathError(filePath, index, 'must be a project-relative path')
    }

    const absolutePath = path.resolve(rootPath, filePath)
    if (!pathInsideRoot(absolutePath, rootPath)) {
      throw contextFilePathError(filePath, index, 'must stay within the project root')
    }

    let realPath
    try {
      realPath = fs.realpathSync(absolutePath)
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`context file not found: ${filePath}`)
      throw new Error(`context file error: ${filePath} (${error.message})`)
    }

    if (!pathInsideRoot(realPath, realRoot)) {
      throw contextFilePathError(filePath, index, 'must stay within the project root')
    }

    try {
      return {
        path: filePath,
        absolutePath,
        content: fs.readFileSync(realPath, 'utf8')
      }
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`context file not found: ${filePath}`)
      throw new Error(`context file error: ${filePath} (${error.message})`)
    }
  })
}

function reviewerContextFilesBlock (contextFiles = []) {
  if (!Array.isArray(contextFiles) || contextFiles.length === 0) return ''

  const sections = contextFiles.map((file, index) => [
    `--- context_files[${index}]: ${file.path} ---`,
    String(file.content || '').trimEnd(),
    `--- end context_files[${index}]: ${file.path} ---`
  ].join('\n'))

  return [
    '--- Project Reviewer Context Files ---',
    'Apply these project-specific reviewer standards in the order shown.',
    '',
    ...sections,
    '--- End Project Reviewer Context Files ---'
  ].join('\n')
}

function attachReviewerContextFiles (runnerContext = {}) {
  const contextFiles = readReviewerContextFiles(runnerContext.task, runnerContext.event)
  if (contextFiles.length === 0) return runnerContext
  return {
    ...runnerContext,
    contextFiles,
    reviewerContextFiles: contextFiles,
    reviewerContextFilesBlock: reviewerContextFilesBlock(contextFiles)
  }
}

module.exports = {
  attachReviewerContextFiles,
  readReviewerContextFiles,
  reviewerContextFilesBlock,
  reviewerRootDir
}
