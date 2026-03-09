const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// Unit tests must not spawn node/CLI subprocesses — those belong in
// test/integration/*.integration.test.js. Git commands for test fixtures
// (freshRepo, commit helpers) are fine.

const SUBPROCESS_PATTERNS = [
  /spawnSync\s*\(\s*['"]node['"]/,
  /spawnSync\s*\(\s*['"]bash['"]/,
  /spawn\s*\(\s*['"]node['"]/,
  /execSync\s*\(/,
  /\bfork\s*\(/
]

describe('unit test subprocess guard', () => {
  const testDir = __dirname
  const unitTests = fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.js') && f !== 'no-subprocess.test.js')

  for (const file of unitTests) {
    it(`${file} does not spawn subprocesses`, () => {
      const content = fs.readFileSync(path.join(testDir, file), 'utf8')
      const violations = []

      for (const pattern of SUBPROCESS_PATTERNS) {
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            violations.push(`  line ${i + 1}: ${lines[i].trim()}`)
          }
        }
      }

      assert.strictEqual(violations.length, 0,
        `${file} spawns subprocesses — move these tests to test/integration/:\n${violations.join('\n')}`)
    })
  }
})
