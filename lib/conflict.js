/**
 * File conflict resolution prompt for install/init.
 *
 * Supports: Y(es), n(o), d(iff), a(gent merge), m(anual merge), q(uit), ?(help)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const HELP_TEXT = `
  Y - yes, overwrite with the new version
  n - no, skip this file
  d - show unified diff (existing vs proposed)
  a - agent merge (Claude attempts an intelligent merge)
  m - manual merge (writes new version to tmp, prints both paths)
  q - quit the entire command
  ? - show this help
`.trimEnd()

let helpShown = false

function resetState () {
  helpShown = false
}

function isHelpShown () {
  return helpShown
}

/**
 * Ask what to do with a conflicting file.
 *
 * @param {readline.Interface} rl
 * @param {object} opts
 * @param {string} opts.label - display name for the file
 * @param {string} opts.existingPath - absolute path to current file on disk
 * @param {string} opts.existing - content of the current file
 * @param {string} opts.proposed - content of the new/shipped version
 * @param {boolean} [opts.defaultYes=true] - whether Enter means yes
 * @param {Function} [opts._spawnSync] - injectable for testing (defaults to child_process.spawnSync)
 * @param {Function} [opts._log] - injectable for testing (defaults to console.log)
 * @returns {Promise<{ answer: 'yes' | 'no' | 'quit', content: string }>}
 *   answer: terminal decision
 *   content: the content to write (may differ from proposed after agent merge)
 */
function askConflict (rl, opts) {
  const {
    label,
    existingPath,
    existing,
    proposed,
    defaultYes = true,
    _spawnSync = spawnSync,
    _log = console.log
  } = opts

  return new Promise(resolve => {
    if (!helpShown) {
      helpShown = true
      _log('\nFile conflict options:')
      _log(HELP_TEXT)
      _log('')
    }

    let currentProposed = proposed
    const hint = defaultYes ? '[Yndamq?]' : '[yNdamq?]'

    function done (answer) {
      resolve({ answer, content: currentProposed })
    }

    function prompt () {
      rl.question(`Conflict: ${label} — overwrite? ${hint} `, answer => {
        const key = answer.trim().toLowerCase()

        if (key === '' || key === 'y' || key === 'yes') {
          if (key === '' && !defaultYes) return done('no')
          return done('yes')
        }
        if (key === 'n' || key === 'no') return done('no')
        if (key === 'q') return done('quit')

        if (key === 'd') {
          const tmpPath = path.join(os.tmpdir(), `prove_it_proposed_${path.basename(existingPath)}`)
          try {
            fs.writeFileSync(tmpPath, currentProposed)
            const result = _spawnSync('diff', ['-u', existingPath, tmpPath], { encoding: 'utf8' })
            if (result.stdout) {
              _log(result.stdout)
            } else {
              _log('(no differences)')
            }
          } finally {
            try { fs.unlinkSync(tmpPath) } catch {}
          }
          return prompt()
        }

        if (key === 'a') {
          _log('Running agent merge...')
          const mergePrompt = `You are merging two versions of a file.

SHIPPED (new default from prove_it):
\`\`\`
${currentProposed}
\`\`\`

YOURS (current file with your customizations):
\`\`\`
${existing}
\`\`\`

Produce a merged version that incorporates the user's customizations into the new shipped structure. Output ONLY the merged file content, nothing else. If you are not confident in the merge or the user needs to make a judgment call, output exactly the word MERGE_FAILED on a line by itself and nothing else.`

          const result = _spawnSync('claude', ['-p', mergePrompt], {
            encoding: 'utf8',
            timeout: 60000,
            env: { ...process.env, CLAUDECODE: '' }
          })

          const merged = (result.stdout || '').trim()
          if (result.status !== 0 || !merged || merged.includes('MERGE_FAILED')) {
            _log('Agent merge failed or declined. Falling through to manual merge.')
            const tmpPath = path.join(os.tmpdir(), `prove_it_shipped_${path.basename(existingPath)}`)
            fs.writeFileSync(tmpPath, currentProposed)
            _log('\nManual merge:')
            _log(`  Yours:   ${existingPath}`)
            _log(`  Shipped: ${tmpPath}`)
            _log('Merge at your leisure, then re-run the command.')
            return done('no')
          }

          _log('\nAgent merge result (diff from your current file):')
          const tmpMerged = path.join(os.tmpdir(), `prove_it_merged_${path.basename(existingPath)}`)
          try {
            fs.writeFileSync(tmpMerged, merged)
            const diffResult = _spawnSync('diff', ['-u', existingPath, tmpMerged], { encoding: 'utf8' })
            if (diffResult.stdout) {
              _log(diffResult.stdout)
            } else {
              _log('(no differences from your current file)')
            }
          } finally {
            try { fs.unlinkSync(tmpMerged) } catch {}
          }
          currentProposed = merged
          return prompt()
        }

        if (key === 'm') {
          const tmpPath = path.join(os.tmpdir(), `prove_it_shipped_${path.basename(existingPath)}`)
          fs.writeFileSync(tmpPath, currentProposed)
          _log('\nManual merge:')
          _log(`  Yours:   ${existingPath}`)
          _log(`  Shipped: ${tmpPath}`)
          _log('Merge at your leisure, then re-run the command.')
          return done('no')
        }

        if (key === '?' || key === 'h' || key === '/') {
          _log(HELP_TEXT)
          return prompt()
        }

        // Unknown key—show help and re-prompt
        _log(HELP_TEXT)
        prompt()
      })
    }

    prompt()
  })
}

module.exports = { askConflict, resetState, isHelpShown, HELP_TEXT }
