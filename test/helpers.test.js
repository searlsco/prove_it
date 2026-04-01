const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { describe, it } = require('node:test')
const { SKILLS } = require('../lib/commands/_helpers')

describe('SKILLS registry', () => {
  it('includes every skill file in lib/skills/', () => {
    const skillsDir = path.join(__dirname, '..', 'lib', 'skills')
    const skillFiles = fs.readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))

    const registered = SKILLS.map(s => s.name)

    for (const name of skillFiles) {
      assert.ok(
        registered.includes(name),
        `Skill file "lib/skills/${name}.md" is not registered in SKILLS array in lib/commands/_helpers.js`
      )
    }
  })

  it('does not reference skill files that do not exist', () => {
    const skillsDir = path.join(__dirname, '..', 'lib', 'skills')
    const skillFiles = fs.readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))

    for (const skill of SKILLS) {
      assert.ok(
        skillFiles.includes(skill.name),
        `SKILLS entry "${skill.name}" has no corresponding file at lib/skills/${skill.src}`
      )
    }
  })
})
