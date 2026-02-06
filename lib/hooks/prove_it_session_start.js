#!/usr/bin/env node
/**
 * prove_it: SessionStart hook
 * - Records baseline git state for this session_id
 * - Optionally injects a small reminder into Claude's context
 */
const fs = require('fs')
const path = require('path')

const {
  readStdin,
  ensureDir,
  loadJson,
  isGitRepo,
  gitRoot,
  gitHead,
  gitStatusHash,
  loadGlobalConfig,
  isIgnoredPath,
  getProveItDir
} = require('../shared')

function main () {
  let input
  try {
    input = JSON.parse(readStdin())
  } catch (e) {
    // For SessionStart, failing to parse is less critical
    // Just log warning and continue without recording baseline
    console.error(`prove_it: Failed to parse SessionStart input: ${e.message}`)
    process.exit(0)
  }

  // Check for global disable via env var
  if (process.env.PROVE_IT_DISABLED) {
    process.exit(0)
  }

  const sessionId = input.session_id || 'unknown'
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

  // Skip hooks entirely for non-git directories (tmp, home, bin, etc.)
  if (!isGitRepo(projectDir)) {
    process.exit(0)
  }

  // Check for ignored paths in global config
  const globalCfg = loadGlobalConfig()
  if (isIgnoredPath(projectDir, globalCfg.ignoredPaths)) {
    process.exit(0)
  }

  const sessionsDir = path.join(getProveItDir(), 'sessions')
  ensureDir(sessionsDir)

  const root = gitRoot(projectDir) || projectDir
  const head = gitHead(root)
  const statusHash = gitStatusHash(root)

  const sessionFile = path.join(sessionsDir, `${sessionId}.json`)
  const payload = {
    session_id: sessionId,
    project_dir: projectDir,
    root_dir: root,
    started_at: new Date().toISOString(),
    git: {
      is_repo: true,
      root,
      head,
      status_hash: statusHash
    }
  }

  try {
    // Merge into existing state to preserve keys like last_review_snapshot
    const existing = loadJson(sessionFile) || {}
    const merged = { ...existing, ...payload }
    ensureDir(sessionsDir)
    fs.writeFileSync(sessionFile, JSON.stringify(merged, null, 2), 'utf8')
  } catch (e) {
    console.error(`prove_it: failed to write session baseline: ${e.message}`)
  }

  // Add context that shapes verification mindset (stdout becomes context for SessionStart)
  const reminder = [
    'prove_it active: verifiability-first workflow.',
    '',
    'Before claiming done:',
    '- Run ./script/test (or the configured test command)',
    '- Verify to the last mile - if you can run it, run it',
    "- Never say 'Try X to verify' - that's handing off your job",
    "- If you can't verify something, mark it UNVERIFIED explicitly",
    '',
    'The user should receive verified, working code - not a verification checklist.'
  ].join('\n')

  // For SessionStart, stdout is appended to Claude context.
  process.stdout.write(reminder)
}

// Export for CLI, auto-run when called directly
if (require.main === module) {
  main()
}
module.exports = { main }
