const { describe, it } = require('node:test')
const assert = require('node:assert')
const { renderBriefing, eventLabel, whenDescription, taskLine, timeAgo, signalDirective } = require('../lib/briefing')
const { buildConfig } = require('../lib/config')

describe('briefing', () => {
  describe('renderBriefing', () => {
    it('contains prove_it header', () => {
      const text = renderBriefing({ hooks: [] })
      assert.ok(text.includes('prove_it'), 'should mention prove_it')
      assert.ok(text.includes('supervisory framework'), 'should describe what prove_it is')
    })

    it('renders PreToolUse tasks with matcher in heading', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          tasks: [{ name: 'lock-config', type: 'script', command: 'prove_it run_builtin config:lock' }]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(text.includes('Before tool use (Edit, Write)'), 'should show matcher tools')
      assert.ok(text.includes('lock-config'), 'should show task name')
    })

    it('renders Stop tasks (script + agent)', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [
            { name: 'fast-tests', type: 'script', command: './script/test_fast' },
            { name: 'code-review', type: 'agent', prompt: 'review:code_quality', when: { linesWritten: 733 } }
          ]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(text.includes('After each turn'), 'should show Stop label')
      assert.ok(text.includes('fast-tests'), 'should show script task')
      assert.ok(text.includes('code-review'), 'should show agent task')
      assert.ok(text.includes('AI reviewer'), 'should describe agent type')
    })

    it('renders git hook tasks', () => {
      const cfg = {
        hooks: [
          {
            type: 'git',
            event: 'pre-commit',
            tasks: [{ name: 'full-tests', type: 'script', command: './script/test' }]
          },
          {
            type: 'git',
            event: 'pre-push',
            tasks: [{ name: 'deploy-check', type: 'script', command: './script/deploy_check' }]
          }
        ]
      }
      const text = renderBriefing(cfg)
      assert.ok(text.includes('On git commit'), 'should show pre-commit label')
      assert.ok(text.includes('On git push'), 'should show pre-push label')
      assert.ok(text.includes('full-tests'), 'should show pre-commit task')
      assert.ok(text.includes('deploy-check'), 'should show pre-push task')
    })

    it('describes agent when conditions in English', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{
            name: 'review',
            type: 'agent',
            when: {
              linesWritten: 500,
              linesChanged: 200,
              sourceFilesEdited: true,
              fileExists: 'script/test'
            }
          }]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(text.includes('500+ lines written'), 'should describe linesWritten')
      assert.ok(text.includes('200+ net lines changed'), 'should describe linesChanged')
      assert.ok(text.includes('when source files are edited'), 'should describe sourceFilesEdited')
      assert.ok(text.includes('requires script/test'), 'should describe fileExists')
    })

    it('skips the session-briefing task itself', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'SessionStart',
          tasks: [
            { name: 'session-briefing', type: 'script', command: 'prove_it run_builtin session:briefing' },
            { name: 'other-task', type: 'script', command: 'echo hello' }
          ]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(!text.includes('session-briefing'), 'should not mention itself')
      assert.ok(text.includes('other-task'), 'should include other tasks')
    })

    it('omits sections with zero renderable tasks', () => {
      const cfg = {
        hooks: [
          {
            type: 'claude',
            event: 'SessionStart',
            tasks: [
              { name: 'session-briefing', type: 'script', command: 'prove_it run_builtin session:briefing' }
            ]
          },
          {
            type: 'claude',
            event: 'Stop',
            tasks: [{ name: 'tests', type: 'script', command: './script/test' }]
          }
        ]
      }
      const text = renderBriefing(cfg)
      assert.ok(!text.includes('On session start'), 'should omit SessionStart when only briefing task')
      assert.ok(text.includes('After each turn'), 'should include Stop section')
    })

    it('includes "How reviews work" when agent tasks exist', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{ name: 'review', type: 'agent' }]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(text.includes('How reviews work'), 'should include review section')
      assert.ok(text.includes('backchannel'), 'should mention backchannel')
      assert.ok(text.includes('supervisory process'), 'should mention supervisory process')
    })

    it('omits review section when no agent tasks', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{ name: 'tests', type: 'script', command: './script/test' }]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(!text.includes('How reviews work'), 'should not include review section')
    })

    it('includes signaling section when signal-gated tasks exist', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{ name: 'shipworthy-review', type: 'agent', when: { signal: 'done' } }]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(text.includes('Signaling:'), 'should include signaling section')
      assert.ok(text.includes('prove_it signal done'), 'should include signal directive')
      assert.ok(text.includes('Include this as a step'), 'should instruct agent to plan for signaling')
      assert.ok(text.includes('prove_it signal clear'), 'should mention clear')
    })

    it('shows "last ran" timing for signal-gated tasks when run data provided', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{ name: 'full-tests', type: 'script', command: './script/test', when: { signal: 'done' } }]
        }]
      }
      const runs = { 'full-tests': { at: Date.now() - 2 * 60 * 60 * 1000, result: 'pass' } }
      const text = renderBriefing(cfg, runs)
      assert.ok(text.includes('Signal-gated tasks:'), 'should include signal-gated tasks heading')
      assert.ok(text.includes('full-tests—last ran 2h ago'), 'should show timing')
    })

    it('shows "never" for signal-gated tasks with no run data', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{ name: 'deploy-check', type: 'agent', when: { signal: 'done' } }]
        }]
      }
      const text = renderBriefing(cfg, {})
      assert.ok(text.includes('deploy-check—last ran never'), 'should show never')
    })

    it('backward compat: renderBriefing(cfg) works without runs arg', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{ name: 'my-task', type: 'script', command: 'true', when: { signal: 'done' } }]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(text.includes('my-task—last ran never'), 'should default to never')
    })

    it('omits signaling section when no signal-gated tasks', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'Stop',
          tasks: [{ name: 'tests', type: 'script', command: './script/test' }]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(!text.includes('Signaling:'), 'should not include signaling section')
    })

    it('handles buildConfig() output correctly', () => {
      const cfg = buildConfig()
      const text = renderBriefing(cfg)
      assert.ok(text.includes('prove_it'), 'should have header')
      assert.ok(text.includes('lock-config'), 'should include lock-config')
      assert.ok(text.includes('fast-tests'), 'should include fast-tests')
      assert.ok(text.includes('full-tests'), 'should include full-tests')
      assert.ok(text.includes('coverage-review'), 'should include coverage-review')
      assert.ok(text.includes('shipworthy-review'), 'should include shipworthy-review')
      assert.ok(!text.includes('session-briefing'), 'should not mention session-briefing')
      assert.ok(text.includes('How reviews work'), 'should include review section for default config')
      assert.ok(text.includes('Signaling:'), 'should include signaling section for default config')
    })

    it('handles empty hooks gracefully', () => {
      const text = renderBriefing({ hooks: [] })
      assert.ok(text.includes('prove_it'), 'should still have header')
      assert.ok(!text.includes('How reviews work'), 'no review section with no tasks')
    })

    it('handles missing hooks gracefully', () => {
      const text = renderBriefing({})
      assert.ok(text.includes('prove_it'), 'should still have header')
    })

    it('renders env tasks', () => {
      const cfg = {
        hooks: [{
          type: 'claude',
          event: 'SessionStart',
          source: 'startup|resume',
          tasks: [{ name: 'setup-env', type: 'env' }]
        }]
      }
      const text = renderBriefing(cfg)
      assert.ok(text.includes('setup-env'), 'should show env task name')
      assert.ok(text.includes('sets environment variables'), 'should describe env task type')
    })

    it('sorts events in lifecycle order', () => {
      const cfg = {
        hooks: [
          { type: 'git', event: 'pre-commit', tasks: [{ name: 'commit-check', type: 'script', command: 'true' }] },
          { type: 'claude', event: 'Stop', tasks: [{ name: 'stop-check', type: 'script', command: 'true' }] },
          { type: 'claude', event: 'PreToolUse', matcher: 'Edit', tasks: [{ name: 'pre-check', type: 'script', command: 'true' }] }
        ]
      }
      const text = renderBriefing(cfg)
      const preToolPos = text.indexOf('Before tool use')
      const stopPos = text.indexOf('After each turn')
      const commitPos = text.indexOf('On git commit')
      assert.ok(preToolPos < stopPos, 'PreToolUse should come before Stop')
      assert.ok(stopPos < commitPos, 'Stop should come before pre-commit')
    })
  })

  describe('eventLabel', () => {
    it('labels SessionStart', () => {
      assert.strictEqual(eventLabel({ type: 'claude', event: 'SessionStart' }), 'On session start')
    })

    it('labels PreToolUse with matcher', () => {
      assert.strictEqual(
        eventLabel({ type: 'claude', event: 'PreToolUse', matcher: 'Edit|Write|Bash' }),
        'Before tool use (Edit, Write, Bash)'
      )
    })

    it('labels PreToolUse without matcher', () => {
      assert.strictEqual(
        eventLabel({ type: 'claude', event: 'PreToolUse' }),
        'Before tool use (any tool)'
      )
    })

    it('labels Stop', () => {
      assert.strictEqual(eventLabel({ type: 'claude', event: 'Stop' }), 'After each turn')
    })

    it('labels git pre-commit', () => {
      assert.strictEqual(eventLabel({ type: 'git', event: 'pre-commit' }), 'On git commit')
    })

    it('labels git pre-push', () => {
      assert.strictEqual(eventLabel({ type: 'git', event: 'pre-push' }), 'On git push')
    })
  })

  describe('whenDescription', () => {
    it('returns null for no when', () => {
      assert.strictEqual(whenDescription(null), null)
      assert.strictEqual(whenDescription(undefined), null)
    })

    it('returns null for empty when', () => {
      assert.strictEqual(whenDescription({}), null)
    })

    it('describes linesWritten', () => {
      assert.strictEqual(whenDescription({ linesWritten: 500 }), 'after 500+ lines written')
    })

    it('describes linesChanged', () => {
      assert.strictEqual(whenDescription({ linesChanged: 200 }), 'after 200+ net lines changed')
    })

    it('describes sourceFilesEdited', () => {
      assert.strictEqual(whenDescription({ sourceFilesEdited: true }), 'when source files are edited')
    })

    it('describes sourcesModifiedSinceLastRun', () => {
      assert.strictEqual(
        whenDescription({ sourcesModifiedSinceLastRun: true }),
        'when sources change since last run'
      )
    })

    it('describes fileExists', () => {
      assert.strictEqual(whenDescription({ fileExists: 'script/test' }), 'requires script/test')
    })

    it('describes envSet', () => {
      assert.strictEqual(whenDescription({ envSet: 'CI' }), 'requires $CI')
    })

    it('describes envNotSet', () => {
      assert.strictEqual(whenDescription({ envNotSet: 'SKIP' }), 'requires $SKIP unset')
    })

    it('describes signal', () => {
      assert.strictEqual(whenDescription({ signal: 'done' }), 'on "done" signal')
    })

    it('describes toolsUsed', () => {
      assert.strictEqual(whenDescription({ toolsUsed: ['Edit', 'Write'] }), 'when Edit, Write used')
    })

    it('describes variablesPresent', () => {
      assert.strictEqual(
        whenDescription({ variablesPresent: ['staged_diff'] }),
        'requires {{staged_diff}}'
      )
      assert.strictEqual(
        whenDescription({ variablesPresent: ['foo', 'bar'] }),
        'requires {{foo}}, {{bar}}'
      )
    })

    it('concatenates multiple conditions', () => {
      const desc = whenDescription({ fileExists: 'script/test', linesWritten: 500 })
      assert.ok(desc.includes('requires script/test'), 'should include prerequisite')
      assert.ok(desc.includes('after 500+ lines written'), 'should include trigger')
    })
  })

  describe('timeAgo', () => {
    it('returns "never" for null/undefined', () => {
      assert.strictEqual(timeAgo(null), 'never')
      assert.strictEqual(timeAgo(undefined), 'never')
    })

    it('returns seconds for < 60s', () => {
      const result = timeAgo(Date.now() - 30000)
      assert.match(result, /^\d+s ago$/)
    })

    it('returns minutes for < 60m', () => {
      const result = timeAgo(Date.now() - 5 * 60 * 1000)
      assert.match(result, /^\d+m ago$/)
    })

    it('returns hours for < 24h', () => {
      const result = timeAgo(Date.now() - 2 * 60 * 60 * 1000)
      assert.match(result, /^\d+h ago$/)
    })

    it('returns days for >= 24h', () => {
      const result = timeAgo(Date.now() - 3 * 24 * 60 * 60 * 1000)
      assert.match(result, /^\d+d ago$/)
    })

    it('returns "just now" for future timestamps', () => {
      assert.strictEqual(timeAgo(Date.now() + 10000), 'just now')
    })
  })

  describe('signalDirective', () => {
    it('returns actionable directive for "done"', () => {
      const d = signalDirective('done')
      assert.ok(d.includes('prove_it signal done'), 'should include command')
      assert.ok(d.includes('Include this as a step'), 'should instruct planning')
    })

    it('returns actionable directive for "stuck"', () => {
      const d = signalDirective('stuck')
      assert.ok(d.includes('prove_it signal stuck'), 'should include command')
    })

    it('returns generic directive for unknown signal types', () => {
      const d = signalDirective('custom')
      assert.ok(d.includes('prove_it signal custom'), 'should include command')
    })
  })

  describe('taskLine', () => {
    it('renders script task', () => {
      assert.strictEqual(
        taskLine({ name: 'fast-tests', type: 'script', command: './script/test_fast' }),
        'fast-tests—runs `./script/test_fast`'
      )
    })

    it('renders agent task without when', () => {
      assert.strictEqual(
        taskLine({ name: 'review', type: 'agent' }),
        'review—AI reviewer'
      )
    })

    it('renders agent task with when', () => {
      const line = taskLine({ name: 'review', type: 'agent', when: { linesWritten: 500 } })
      assert.strictEqual(line, 'review—AI reviewer (after 500+ lines written)')
    })

    it('renders env task', () => {
      assert.strictEqual(
        taskLine({ name: 'setup', type: 'env' }),
        'setup—sets environment variables'
      )
    })

    it('renders script task with no command', () => {
      assert.strictEqual(
        taskLine({ name: 'x', type: 'script' }),
        'x—runs `(no command)`'
      )
    })

    it('renders unknown task type as just the name', () => {
      assert.strictEqual(
        taskLine({ name: 'x', type: 'custom' }),
        'x'
      )
    })
  })
})
