const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { getUnknownVars, KNOWN_VARS } = require('../lib/template')

const SKILL_PATH = path.join(__dirname, '..', 'lib', 'skills', 'prove-dry.md')

describe('prove-dry skill', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8')

  describe('frontmatter', () => {
    it('starts with YAML frontmatter', () => {
      assert.ok(content.startsWith('---\n'), 'should start with ---')
    })

    it('has a closing frontmatter delimiter', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      assert.ok(endIdx > 0, 'should have closing --- delimiter')
    })

    it('has required frontmatter fields', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      const frontmatter = content.slice(4, endIdx)
      assert.ok(frontmatter.includes('name: prove-dry'), 'should have name')
      assert.ok(frontmatter.includes('description:'), 'should have description')
      assert.ok(frontmatter.includes('context: fork'), 'should have context: fork')
      assert.ok(frontmatter.includes('disable-model-invocation: true'), 'should disable model invocation')
    })
  })

  describe('template variables', () => {
    it('uses only known template variables', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      const body = content.slice(endIdx + 5)
      const unknown = getUnknownVars(body)
      assert.deepStrictEqual(unknown, [],
        `Unknown template variables: ${unknown.join(', ')}. Known: ${KNOWN_VARS.join(', ')}`)
    })

    it('uses expected context variables', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      const body = content.slice(endIdx + 5)
      const expectedVars = ['sources', 'files_changed_since_last_run', 'session_diff', 'changes_since_last_run', 'git_status', 'signal_message']
      for (const v of expectedVars) {
        assert.ok(body.includes(`{{${v}}}`), `should use {{${v}}}`)
      }
    })
  })

  describe('conditional blocks', () => {
    it('has well-formed conditional blocks', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      const body = content.slice(endIdx + 5)

      const openings = [...body.matchAll(/\{\{#(\w+)\}\}/g)].map(m => m[1])
      const closings = [...body.matchAll(/\{\{\/(\w+)\}\}/g)].map(m => m[1])

      assert.deepStrictEqual(openings.sort(), closings.sort(),
        'every {{#var}} should have a matching {{/var}}')
    })
  })

  describe('verdict logic', () => {
    it('defaults to PASS', () => {
      assert.ok(content.includes('default verdict is PASS'), 'should document PASS as default verdict')
    })

    it('documents PASS, FAIL, and SKIP verdicts', () => {
      assert.ok(content.includes('Verdict: PASS'), 'should have PASS verdict format')
      assert.ok(content.includes('Verdict: FAIL'), 'should have FAIL verdict format')
      assert.ok(content.includes('Verdict: SKIP'), 'should have SKIP verdict format')
    })
  })
})
