const fs = require('fs')
const path = require('path')

// Strict: plan file idempotency guard — must contain the exact command
const SIGNAL_PLAN_MARKER = 'prove_it signal done'
const PHASE_PLAN_MARKER = 'prove_it phase implement'
// Liberal: TaskCompleted auto-signaling — any task with "signal" and "done" tokens
const SIGNAL_TASK_PATTERN = /\bsignal\b.*\bdone\b/i

/**
 * Detect the last numbered heading in plan content.
 * Supports: ### N. / ### N: / ## Step N: / ## Step N. / ## N. / ## N:
 * Returns { level, number } or null.
 */
function detectLastNumberedHeading (content) {
  const pattern = /^(#{2,3})\s+(?:Step\s+)?(\d+)[.:]/gm
  let last = null
  let m
  while ((m = pattern.exec(content)) !== null) {
    last = { level: m[1].length, number: parseInt(m[2], 10) }
  }
  return last
}

/**
 * Build the signal step block at the given heading level and step number.
 */
function buildSignalBlock (level, stepNum) {
  const stepString = stepNum < 2 ? '' : ` ${stepNum}.`
  const hashes = '#'.repeat(level)
  return `${hashes}${stepString} Run \`prove_it signal done\`

**IMPORTANT — you MUST complete this step.** When all implementation and
testing above is finished, invoke the signal command so that prove_it
can run its quality gates (test suites, code review agents).
Without this signal, your work will not be shipped!

Run this command in your terminal:

\`\`\`bash
prove_it phase implement
prove_it signal done
\`\`\`
`
}

/**
 * Find a plan file in ~/.claude/plans/ that contains the given text.
 * Returns the file path or null.
 */
function findPlanFile (planText) {
  if (!planText || !planText.trim()) return null

  const plansDir = path.join(process.env.HOME, '.claude', 'plans')
  let files
  try {
    files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'))
  } catch { return null }

  if (files.length === 0) return null

  // Sort by mtime descending (newest first)
  files.sort((a, b) => {
    try {
      return fs.statSync(path.join(plansDir, b)).mtimeMs - fs.statSync(path.join(plansDir, a)).mtimeMs
    } catch { return 0 }
  })

  const needle = planText.trim()
  for (const file of files) {
    const filePath = path.join(plansDir, file)
    let content
    try { content = fs.readFileSync(filePath, 'utf8') } catch { continue }
    if (content.includes(needle)) return filePath
  }
  return null
}

/**
 * Idempotent block insertion into a plan file.
 *
 * @param {string} filePath - Path to the plan file
 * @param {object} opts
 * @param {string} opts.marker - Idempotency marker to check
 * @param {string} opts.block - Block content to insert
 * @param {string} opts.position - 'after-title' or 'before-verification'
 */
function appendPlanBlock (filePath, { marker, block, position }) {
  let content
  try { content = fs.readFileSync(filePath, 'utf8') } catch { return }

  if (content.includes(marker)) return // already present

  if (position === 'after-title') {
    // Insert after first heading line (# Title)
    const titleMatch = content.match(/^#[^#].*\n/)
    if (titleMatch) {
      const idx = titleMatch.index + titleMatch[0].length
      content = content.slice(0, idx) + '\n' + block + '\n' + content.slice(idx)
    } else {
      content = block + '\n' + content
    }
  } else if (position === 'before-verification') {
    const verificationPattern = /\n## Verification\b[^\n]*/
    const verificationMatch = content.match(verificationPattern)
    if (verificationMatch) {
      const idx = content.indexOf(verificationMatch[0])
      content = content.slice(0, idx) + '\n' + block + '\n' + content.slice(idx)
    } else {
      content = content + '\n' + block
    }
  }

  fs.writeFileSync(filePath, content, 'utf8')
}

module.exports = {
  SIGNAL_PLAN_MARKER,
  PHASE_PLAN_MARKER,
  SIGNAL_TASK_PATTERN,
  detectLastNumberedHeading,
  buildSignalBlock,
  findPlanFile,
  appendPlanBlock
}
