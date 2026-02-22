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

/**
 * Sanitize a task name for use in a git ref path.
 * Replaces characters not in [a-zA-Z0-9._-] with '_'.
 */
function sanitizeRefName (taskName) {
  return (taskName || '').replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Read a prove_it ref. Returns the SHA or null if ref doesn't exist.
 */
function readRef (dir, refName) {
  const r = tryRun(`git -C ${shellEscape(dir)} rev-parse --verify refs/worktree/prove_it/${shellEscape(refName)}`, {})
  if (r.code !== 0) return null
  return r.stdout.trim()
}

/**
 * Update (or create) a prove_it ref to point at the given SHA.
 */
function updateRef (dir, refName, sha) {
  tryRun(`git -C ${shellEscape(dir)} update-ref refs/worktree/prove_it/${shellEscape(refName)} ${shellEscape(sha)}`, {})
}

/**
 * Build source glob pathspecs for git commands.
 */
function sourcePathspecs (sourceGlobs) {
  const globs = Array.isArray(sourceGlobs) && sourceGlobs.length > 0
    ? sourceGlobs
    : ['**']
  return globs.map(g => shellEscape(`:(glob)${g}`)).join(' ')
}

/**
 * Find untracked files matching source globs.
 * Returns array of relative file paths.
 */
function findUntrackedSources (dir, sourceGlobs) {
  const pathspecs = sourcePathspecs(sourceGlobs)
  const r = tryRun(`git -C ${shellEscape(dir)} ls-files --others --exclude-standard -- ${pathspecs}`, {})
  if (r.code !== 0 || !r.stdout.trim()) return []
  return r.stdout.trim().split('\n').filter(Boolean)
}

/**
 * Remove files from the git index, reverting them to untracked.
 * Used to undo temporary git add / git add -N operations.
 */
function removeFromIndex (dir, files) {
  if (!files || files.length === 0) return
  const escaped = files.map(f => shellEscape(f)).join(' ')
  tryRun(`git -C ${shellEscape(dir)} reset -- ${escaped}`, {})
}

/**
 * Create a commit-like SHA representing the current working tree state
 * (including staged, unstaged, AND untracked source files) without modifying
 * the stash list or working tree permanently.
 *
 * Temporarily stages untracked source files (git add), creates the stash,
 * then undoes the staging (git reset). Falls back to gitHead() when the
 * working tree is clean.
 *
 * This is the correct ref target for churn tracking — using gitHead() fails
 * when churn comes from uncommitted Write/Edit operations (HEAD never moves,
 * so advancing the ref to HEAD is a no-op and churn persists).
 */
function snapshotWorkingTree (dir, sourceGlobs) {
  // Temporarily stage untracked source files so git stash create captures them.
  // git stash create fails with git add -N (intent-to-add), so we use full
  // git add and undo with git reset afterward.
  const untracked = findUntrackedSources(dir, sourceGlobs)
  if (untracked.length > 0) {
    const escaped = untracked.map(f => shellEscape(f)).join(' ')
    tryRun(`git -C ${shellEscape(dir)} add -- ${escaped}`, {})
  }
  try {
    const r = tryRun(`git -C ${shellEscape(dir)} stash create`, {})
    if (r.code === 0 && r.stdout.trim()) {
      return r.stdout.trim()
    }
    // Working tree is clean — HEAD accurately represents the current state
    return gitHead(dir)
  } finally {
    removeFromIndex(dir, untracked)
  }
}

/**
 * Delete all prove_it refs under refs/worktree/prove_it/.
 * Returns the number of refs deleted.
 */
function deleteAllRefs (dir) {
  const r = tryRun(`git -C ${shellEscape(dir)} for-each-ref --format='%(refname)' refs/worktree/prove_it/`, {})
  if (r.code !== 0 || !r.stdout.trim()) return 0
  const refs = r.stdout.trim().split('\n').filter(Boolean)
  for (const ref of refs) {
    tryRun(`git -C ${shellEscape(dir)} update-ref -d ${shellEscape(ref)}`, {})
  }
  return refs.length
}

/**
 * Compute churn (additions + deletions) since a prove_it ref for the given source globs.
 * Diffs the ref against the working tree — includes committed, staged, unstaged,
 * AND untracked source file changes so that Write/Edit tool calls count immediately.
 * If the ref doesn't exist yet, creates it at HEAD and returns current churn
 * (0 if the working tree is clean with no untracked source files).
 * Returns 0 in non-git directories.
 */
function churnSinceRef (dir, refName, sourceGlobs) {
  if (!isGitRepo(dir)) return 0
  const head = gitHead(dir)
  if (!head) return 0

  const existing = readRef(dir, refName)
  if (!existing) {
    // Bootstrap: create ref at HEAD, then fall through to diff ref vs working tree
    // so any already-uncommitted changes are counted immediately.
    updateRef(dir, refName, head)
  }

  const ref = existing || head
  const pathspecs = sourcePathspecs(sourceGlobs)

  // Temporarily mark untracked source files as intent-to-add so git diff sees them.
  // git add -N is lightweight — it creates an empty index entry without staging content.
  const untracked = findUntrackedSources(dir, sourceGlobs)
  if (untracked.length > 0) {
    const escaped = untracked.map(f => shellEscape(f)).join(' ')
    tryRun(`git -C ${shellEscape(dir)} add -N -- ${escaped}`, {})
  }

  try {
    // Diff ref against working tree (not ..HEAD) — captures uncommitted changes too
    const r = tryRun(`git -C ${shellEscape(dir)} diff --numstat ${shellEscape(ref)} -- ${pathspecs}`, {})
    if (r.code !== 0) return 0

    let total = 0
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      const [adds, dels] = line.split('\t')
      // Binary files show '-' for adds/dels
      const a = parseInt(adds, 10)
      const d = parseInt(dels, 10)
      if (!isNaN(a)) total += a
      if (!isNaN(d)) total += d
    }
    return total
  } finally {
    removeFromIndex(dir, untracked)
  }
}

/**
 * Read a blob object and parse its content as an integer.
 * Returns 0 if the blob doesn't exist or can't be parsed.
 */
function readCounterBlob (dir, sha) {
  if (!sha) return 0
  const r = tryRun(`git -C ${shellEscape(dir)} cat-file blob ${shellEscape(sha)}`, {})
  if (r.code !== 0) return 0
  const n = parseInt(r.stdout.trim(), 10)
  return isNaN(n) ? 0 : n
}

/**
 * Write an integer value as a blob and update a prove_it ref to point at it.
 */
function writeCounterRef (dir, refName, value) {
  const r = tryRun(`printf '%s' ${shellEscape(String(value))} | git -C ${shellEscape(dir)} hash-object -w --stdin`, {})
  if (r.code !== 0 || !r.stdout.trim()) return
  updateRef(dir, refName, r.stdout.trim())
}

/**
 * Read the global gross churn counter.
 */
function readGrossCounter (dir) {
  const sha = readRef(dir, '__gross_lines')
  return readCounterBlob(dir, sha)
}

/**
 * Increment the global gross churn counter by delta lines.
 * Uses compare-and-swap (git update-ref with oldvalue) for multi-agent safety.
 */
function incrementGross (dir, delta) {
  if (!delta || delta <= 0) return
  for (let attempt = 0; attempt < 3; attempt++) {
    const oldSha = readRef(dir, '__gross_lines')
    const current = readCounterBlob(dir, oldSha)
    const newValue = current + delta
    const r = tryRun(`printf '%s' ${shellEscape(String(newValue))} | git -C ${shellEscape(dir)} hash-object -w --stdin`, {})
    if (r.code !== 0 || !r.stdout.trim()) return
    const newSha = r.stdout.trim()
    if (!oldSha) {
      // First write — no old ref to CAS against
      updateRef(dir, '__gross_lines', newSha)
      return
    }
    const cas = tryRun(`git -C ${shellEscape(dir)} update-ref refs/worktree/prove_it/__gross_lines ${shellEscape(newSha)} ${shellEscape(oldSha)}`, {})
    if (cas.code === 0) return
    // CAS failed — another agent updated the ref; retry
  }
}

/**
 * Compute gross churn since a task's last run.
 * Returns global counter minus the task's snapshot of the counter.
 * On first call (no snapshot), bootstraps by setting snapshot = current global and returning 0.
 */
function grossChurnSince (dir, taskRefName) {
  const global = readGrossCounter(dir)
  const snapRef = `${taskRefName}.__gross_lines`
  const snapSha = readRef(dir, snapRef)
  if (!snapSha) {
    // Bootstrap: snapshot current global, return 0
    writeCounterRef(dir, snapRef, global)
    return 0
  }
  const snap = readCounterBlob(dir, snapSha)
  return Math.max(0, global - snap)
}

/**
 * Advance the gross churn snapshot for a task to the current global counter.
 */
function advanceGrossSnapshot (dir, taskRefName) {
  const global = readGrossCounter(dir)
  writeCounterRef(dir, `${taskRefName}.__gross_lines`, global)
}

/**
 * Count lines from a tool input without reading files.
 * Handles builtin tools (Write, Edit, NotebookEdit) by schema, and unknown
 * file-editing tools (e.g. MCP) by scanning for the longest string value.
 */
function computeWriteLines (toolName, toolInput) {
  if (!toolInput) return 0
  if (toolName === 'Write') {
    const content = toolInput.content
    if (typeof content !== 'string') return 0
    return content.split('\n').length
  }
  if (toolName === 'Edit') {
    let total = 0
    const old = toolInput.old_string
    const nw = toolInput.new_string
    if (typeof old === 'string') total += old.split('\n').length
    if (typeof nw === 'string') total += nw.split('\n').length
    return total
  }
  if (toolName === 'NotebookEdit') {
    const mode = toolInput.edit_mode || 'replace'
    if (mode === 'delete') return 0
    const src = toolInput.new_source
    if (typeof src !== 'string') return 0
    return src.split('\n').length
  }
  // Unknown file-editing tool (e.g. MCP): find the longest string value
  // in tool_input as a content proxy. This function is only called inside
  // the fileEditingTools guard, so the tool is confirmed to be an editor.
  let longest = ''
  for (const v of Object.values(toolInput)) {
    if (typeof v === 'string' && v.length > longest.length) longest = v
  }
  return longest ? longest.split('\n').length : 0
}

/**
 * Compute a diff --stat since a prove_it ref for the given source globs.
 * Returns a human-readable stat summary or empty string if no ref exists.
 * Includes untracked source files via intent-to-add (same pattern as churnSinceRef).
 */
function diffStatSinceRef (dir, refName, sourceGlobs) {
  if (!isGitRepo(dir)) return ''
  const ref = readRef(dir, refName)
  if (!ref) return ''

  const pathspecs = sourcePathspecs(sourceGlobs)

  // Temporarily mark untracked source files as intent-to-add so git diff sees them.
  const untracked = findUntrackedSources(dir, sourceGlobs)
  if (untracked.length > 0) {
    const escaped = untracked.map(f => shellEscape(f)).join(' ')
    tryRun(`git -C ${shellEscape(dir)} add -N -- ${escaped}`, {})
  }

  try {
    const r = tryRun(`git -C ${shellEscape(dir)} diff --stat ${shellEscape(ref)} -- ${pathspecs}`, {})
    if (r.code !== 0) return ''
    return r.stdout.trim()
  } finally {
    removeFromIndex(dir, untracked)
  }
}

/**
 * Advance (or skip) the task ref based on pass/fail and hook event.
 *
 * For agent tasks: always snapshot the working tree on advance — this powers
 * the {{changes_since_last_review}} template variable regardless of whether
 * the task has churn triggers.
 *
 * For churn-tracked tasks (linesChanged / linesWritten): advances the
 * corresponding refs so the churn counter resets.
 *
 * On pass: always advance (the work was reviewed).
 * On fail: advance only when resetOnFail applies:
 *   - PreToolUse defaults to reset (avoids deadlock — the task blocks every
 *     Write/Edit, including writes to test files that would fix the issue)
 *   - Stop / git hooks default to no reset (agent gets sent back to fix)
 *   - Explicit resetOnFail on the task overrides the event-based default
 */
function advanceTaskRef (task, passed, hookEvent, rootDir, sources) {
  const hasNetChurn = task.when && task.when.linesChanged
  const hasGrossChurn = task.when && task.when.linesWritten
  const isAgent = task.type === 'agent'

  // Gate: only act for agent tasks or churn-tracked tasks
  if (!isAgent && !hasNetChurn && !hasGrossChurn) return

  const shouldAdvance = passed || (
    task.resetOnFail !== undefined
      ? task.resetOnFail
      : (hookEvent === 'PreToolUse')
  )
  if (!shouldAdvance) return

  // Snapshot working tree for agent tasks or net-churn tasks
  if (isAgent || hasNetChurn) {
    const snap = snapshotWorkingTree(rootDir, sources)
    if (snap) updateRef(rootDir, sanitizeRefName(task.name), snap)
  }

  if (hasGrossChurn) {
    advanceGrossSnapshot(rootDir, sanitizeRefName(task.name))
  }
}

module.exports = {
  isGitRepo,
  gitRoot,
  gitHead,
  gitStatusHash,
  gitTrackedFiles,
  gitDiffFiles,
  sanitizeRefName,
  readRef,
  updateRef,
  snapshotWorkingTree,
  deleteAllRefs,
  churnSinceRef,
  readCounterBlob,
  writeCounterRef,
  readGrossCounter,
  incrementGross,
  grossChurnSince,
  advanceGrossSnapshot,
  computeWriteLines,
  diffStatSinceRef,
  advanceTaskRef
}
