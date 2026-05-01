const methodology = {
  signals: {
    done: {
      command: 'prove_it signal done',
      meaning: 'The primary agent believes a coherent coding task is complete and ready for completion verification.',
      directive: 'Run `prove_it signal done` once after completing a coherent body of work — not after every edit or file.'
    },
    stuck: {
      command: 'prove_it signal stuck',
      meaning: 'The primary agent is blocked, cycling, or needs intervention before it can honestly proceed.',
      directive: 'When blocked or stuck, run `prove_it signal stuck` to request intervention.'
    },
    idle: {
      command: 'prove_it signal idle',
      meaning: 'The primary agent is between tasks or intentionally not making a completion claim.',
      directive: 'When between tasks or intentionally not claiming completion, run `prove_it signal idle`.'
    }
  },
  completionAccountability: {
    rules: [
      {
        id: 'declare-on-coherent-task',
        title: 'Completion declaration',
        meaning: 'The agent declares completion only when a coherent coding task is actually complete.',
        guidance: '**You MUST run `{doneCommand}` once at the end of each coding task** — not after every edit, not after every file, but after you have finished implementing any coherent body of work ({coherentTaskExamples}).'
      },
      {
        id: 'verification-activation',
        title: 'Verification activation',
        meaning: 'A completion declaration activates the configured completion verification workflow.',
        guidance: 'This triggers AI reviewers and the full test suite. Do not signal prematurely or repeatedly — signal when the work is *actually done*.'
      },
      {
        id: 'completion-language-restrictions',
        title: 'Completion rule',
        meaning: 'Completion language is only honest after the agent declared completion and verification passed.',
        guidance: 'Do not say "done", "finished", "complete", "ready to ship", or similar language unless you have already run `{doneCommand}` in this session and all checks have passed.'
      },
      {
        id: 'preserve-on-fail',
        title: 'Preserve on fail',
        meaning: 'Failed completion verification preserves the active completion claim so gated checks can re-fire after remediation.',
        guidance: 'If a reviewer fails, fix the issues and re-signal.'
      },
      {
        id: 'clear-on-pass',
        title: 'Clear on pass',
        meaning: 'Passed completion verification clears the active completion claim.',
        guidance: 'After completion verification passes, the active signal can be cleared because the completion claim has been proven.'
      }
    ],
    accountabilityIntro: 'After implementing code changes, if you do NOT run `{doneCommand}`, you MUST explicitly state why and what remains. Valid reasons:',
    validIncompleteReasons: [
      'Blocked on user input or a decision',
      'This is an intermediate step in a larger plan (signal is coming later)',
      'Tests are currently failing and you\'re still debugging',
      'The work is incomplete — here is what\'s left: [list]'
    ],
    silenceRule: 'Silence is not acceptable. Either signal or explain.',
    coherentTaskExamples: [
      'a full feature',
      'a complete bug fix',
      'a finished refactor'
    ],
    renderedRuleIds: [
      'declare-on-coherent-task',
      'verification-activation',
      'completion-language-restrictions',
      'preserve-on-fail'
    ]
  },
  evidenceProving: {
    id: 'evidence-oriented-proving',
    conciseDirective: 'Always verify claims with evidence before saying work is complete.',
    principles: [
      'Make claims only after collecting evidence from checks, artifacts, reproduction steps, or direct inspection.',
      'Prefer demonstrated verification over plausible explanation.',
      'Report honestly when evidence is missing, incomplete, or contradictory.'
    ]
  },
  coreInvariants: [
    'Agents own completion accountability signals.',
    'Completion claims require verification evidence.',
    'Failed completion verification preserves the active claim until remediation.',
    'Passed completion verification clears the active claim.'
  ],
  defaultProfile: {
    name: 'TDD-forward default methodology profile',
    guidance: [
      'Prefer red-green-refactor for code changes when practical.',
      'Use the strongest focused verification loop available before declaring completion.'
    ]
  }
}

function cloneMethodology (source = methodology) {
  return JSON.parse(JSON.stringify(source))
}

function ruleById (rules, id) {
  return rules.find(rule => rule.id === id)
}

function interpolate (text, values) {
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  })
}

function renderRuleGuidance (rule, values) {
  return interpolate(rule.guidance, values)
}

function renderCompletionAccountability (options = {}) {
  const data = options.methodology || methodology
  const account = data.completionAccountability
  const doneCommand = data.signals.done.command
  const values = {
    doneCommand,
    coherentTaskExamples: account.coherentTaskExamples.join(', ')
  }
  const lines = []

  const declaration = ruleById(account.rules, 'declare-on-coherent-task')
  const activation = ruleById(account.rules, 'verification-activation')
  if (declaration) {
    const declarationText = renderRuleGuidance(declaration, values)
    const activationText = activation ? ` ${renderRuleGuidance(activation, values)}` : ''
    lines.push(`${declarationText}${activationText}`)
  }

  const completionLanguage = ruleById(account.rules, 'completion-language-restrictions')
  const preserveOnFail = ruleById(account.rules, 'preserve-on-fail')
  if (completionLanguage) {
    const completionText = renderRuleGuidance(completionLanguage, values)
    const failText = preserveOnFail ? ` ${renderRuleGuidance(preserveOnFail, values)}` : ''
    lines.push(`### Completion rule\n\n${completionText}${failText}`)
  }

  lines.push(`### Accountability rule\n\n${interpolate(account.accountabilityIntro, values)}`)
  lines.push(account.validIncompleteReasons.map(reason => `- ${reason}`).join('\n'))
  lines.push(account.silenceRule)

  return lines.join('\n\n')
}

function renderSignalDirective (type, options = {}) {
  const data = options.methodology || methodology
  return data.signals[type]?.directive || `When ready, run \`prove_it signal ${type}\`.`
}

function renderMethodologySummary (options = {}) {
  const data = options.methodology || methodology
  const lines = [
    'prove_it methodology:',
    '- Work in small, reviewable slices.',
    `- ${data.evidenceProving.conciseDirective}`,
    '- If blocked or uncertain, say so directly instead of claiming completion.'
  ]
  return lines.join('\n')
}

module.exports = {
  methodology,
  cloneMethodology,
  renderCompletionAccountability,
  renderMethodologySummary,
  renderSignalDirective
}
