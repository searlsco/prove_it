const fs = require('fs')
const path = require('path')

// Strict: plan file idempotency guard — must contain the exact command
const SIGNAL_PLAN_MARKER = 'prove_it signal done'
const PHASE_PLAN_MARKER = 'prove_it phase'
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
testing above is finished, run \`prove_it signal done\` so that prove_it
can run its quality gates (test suites, code review agents).
Without this signal, your work will not be shipped!

\`\`\`bash
$ prove_it signal done
\`\`\`
`
}

/**
 * Detect whether a plan is a refactoring plan or an implementation plan.
 * Scans the first ~30 lines for refactor signals. Conservative — defaults
 * to 'implement' since that's the stricter mode (full red-green TDD).
 */
function detectPlanPhase (content) {
  if (!content) return 'implement'
  const lines = content.split('\n').slice(0, 30)
  const region = lines.join('\n')

  // Check title (first # heading) for "refactor"
  const titleMatch = region.match(/^#\s+(.+)/m)
  if (titleMatch && /refactor/i.test(titleMatch[1])) return 'refactor'

  // Check prominent headings (## or ###) for "refactor"
  const headingPattern = /^#{2,3}\s+(.+)/gm
  let m
  while ((m = headingPattern.exec(region)) !== null) {
    if (/refactor/i.test(m[1])) return 'refactor'
  }

  // Check for key phrases
  if (/refactor\s*mode/i.test(region)) return 'refactor'
  if (/refactoring\s*phase/i.test(region)) return 'refactor'
  if (/preserve\s+existing\s+behavior/i.test(region)) return 'refactor'
  if (/no\s+behavior\s+change/i.test(region)) return 'refactor'

  return 'implement'
}

/**
 * Build the phase block injected after the plan title.
 * @param {string} [phase='implement'] - 'implement' or 'refactor'
 */
function buildPhaseBlock (phase) {
  phase = phase || 'implement'
  if (phase === 'refactor') {
    return `## Enter refactor phase

In order to freely edit code while using the existing test suite as a harness,
you MUST run this command:

\`\`\`bash
$ prove_it phase refactor
\`\`\`
`
  }
  return `## Enter implementation phase

In order to freely edit code and tests and to have your work count towards
completion, you MUST run this command:

\`\`\`bash
$ prove_it phase implement
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
  detectPlanPhase,
  buildSignalBlock,
  buildPhaseBlock,
  findPlanFile,
  appendPlanBlock
}
