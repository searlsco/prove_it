const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('child_process')

const {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  createFile
} = require('./hook-harness')

function claudeAvailable () {
  const result = spawnSync('which', ['claude'], { encoding: 'utf8' })
  return result.status === 0
}

function gitAdd (dir, file) {
  spawnSync('git', ['add', file], { cwd: dir })
}

function gitCommit (dir, message) {
  spawnSync('git', ['commit', '-m', message], { cwd: dir })
}

function runReviewer (dir) {
  const prompt = `You are a code review gatekeeper. A coding agent claims their work is complete.

Your job: verify that code changes have corresponding test coverage.

## Instructions

1. Run: git diff --stat
   - If no changes, return PASS (nothing to verify)

2. For each changed source file (src/, lib/, or main code files):
   - Check if corresponding test files were also modified
   - If test files exist, read them to verify they actually test the changed behavior

3. Be skeptical of:
   - Source changes with no test changes
   - Claims like "existing tests cover it" without evidence
   - New functions/methods without corresponding test cases
   - Bug fixes without regression tests

4. Be lenient for:
   - Documentation-only changes
   - Config file changes
   - Refactors where behavior is unchanged and existing tests still apply
   - Test-only changes

## Response Format

Return EXACTLY one of:
- PASS
- FAIL: <reason>

Examples:
- PASS
- FAIL: src/hooks/gate.js changed but no tests added for new isLocalConfigWrite() function
- FAIL: 5 source files changed, 0 test files changed

Be concise. One line only.`

  const result = spawnSync('claude', ['-p', prompt], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120000
  })

  return {
    exitCode: result.status,
    stdout: result.stdout?.trim() || '',
    stderr: result.stderr?.trim() || ''
  }
}

function parseReviewerResult (stdout) {
  const firstLine = stdout.split('\n')[0].trim()

  if (firstLine === 'PASS') {
    return { pass: true }
  }

  if (firstLine.startsWith('FAIL:')) {
    return { pass: false, reason: firstLine.slice(5).trim() }
  }

  if (firstLine === 'FAIL') {
    const lines = stdout.split('\n')
    const reason = lines.length > 1 ? lines[1].trim() : 'No reason provided'
    return { pass: false, reason }
  }

  return { unknown: true, output: firstLine }
}

describe('reviewer integration', { skip: !claudeAvailable() }, () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = createTempDir('reviewer-test-')
    initGitRepo(tmpDir)
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  describe('should PASS', () => {
    it('passes when no changes exist', () => {
      // Create initial commit
      createFile(tmpDir, 'README.md', '# Test')
      gitAdd(tmpDir, 'README.md')
      gitCommit(tmpDir, 'initial')

      // No uncommitted changes
      const result = runReviewer(tmpDir)
      const parsed = parseReviewerResult(result.stdout)

      assert.strictEqual(parsed.pass, true, `Expected PASS, got: ${result.stdout}`)
    })

    it('passes for documentation-only changes', () => {
      // Initial commit
      createFile(tmpDir, 'src/main.js', 'function main() {}')
      createFile(tmpDir, 'README.md', '# Test')
      gitAdd(tmpDir, '.')
      gitCommit(tmpDir, 'initial')

      // Only change docs
      createFile(tmpDir, 'README.md', '# Test\n\nUpdated documentation.')

      const result = runReviewer(tmpDir)
      const parsed = parseReviewerResult(result.stdout)

      assert.strictEqual(parsed.pass, true, `Expected PASS for doc changes, got: ${result.stdout}`)
    })

    it('passes when source and test files both change', () => {
      // Initial commit
      createFile(tmpDir, 'src/utils.js', 'function old() { return 1; }')
      createFile(tmpDir, 'test/utils.test.js', "test('old', () => {});")
      gitAdd(tmpDir, '.')
      gitCommit(tmpDir, 'initial')

      // Change both source and test
      createFile(tmpDir, 'src/utils.js', 'function old() { return 1; }\nfunction newFunc() { return 2; }')
      createFile(tmpDir, 'test/utils.test.js', "test('old', () => {});\ntest('newFunc', () => {});")

      const result = runReviewer(tmpDir)
      const parsed = parseReviewerResult(result.stdout)

      assert.strictEqual(parsed.pass, true, `Expected PASS when tests added, got: ${result.stdout}`)
    })

    it('passes for test-only changes', () => {
      // Initial commit
      createFile(tmpDir, 'src/main.js', 'function main() {}')
      createFile(tmpDir, 'test/main.test.js', "test('basic', () => {});")
      gitAdd(tmpDir, '.')
      gitCommit(tmpDir, 'initial')

      // Only add more tests
      createFile(tmpDir, 'test/main.test.js', "test('basic', () => {});\ntest('edge case', () => {});")

      const result = runReviewer(tmpDir)
      const parsed = parseReviewerResult(result.stdout)

      assert.strictEqual(parsed.pass, true, `Expected PASS for test-only changes, got: ${result.stdout}`)
    })
  })

  describe('should FAIL', () => {
    it('fails when source changes but no tests change', () => {
      // Initial commit
      createFile(tmpDir, 'src/utils.js', 'function old() { return 1; }')
      createFile(tmpDir, 'test/utils.test.js', "test('old', () => {});")
      gitAdd(tmpDir, '.')
      gitCommit(tmpDir, 'initial')

      // Only change source, not tests
      createFile(tmpDir, 'src/utils.js', 'function old() { return 1; }\nfunction brandNew() { return 42; }')

      const result = runReviewer(tmpDir)
      const parsed = parseReviewerResult(result.stdout)

      assert.strictEqual(parsed.pass, false, `Expected FAIL for source-only changes, got: ${result.stdout}`)
    })

    it('fails when new file added without tests', () => {
      // Initial commit
      createFile(tmpDir, 'src/main.js', 'function main() {}')
      gitAdd(tmpDir, '.')
      gitCommit(tmpDir, 'initial')

      // Add new source file without tests
      createFile(tmpDir, 'src/newFeature.js', "function newFeature() { return 'new'; }")

      const result = runReviewer(tmpDir)
      const parsed = parseReviewerResult(result.stdout)

      assert.strictEqual(parsed.pass, false, `Expected FAIL for new file without tests, got: ${result.stdout}`)
    })

    it('fails when multiple source files change but no tests', () => {
      // Initial commit with actual behavioral code
      createFile(tmpDir, 'src/auth.js', `
function authenticate(user, pass) {
  return user === 'admin' && pass === 'secret';
}
module.exports = { authenticate };
`)
      createFile(tmpDir, 'src/api.js', `
function fetchData(url) {
  return fetch(url).then(r => r.json());
}
module.exports = { fetchData };
`)
      createFile(tmpDir, 'src/utils.js', `
function formatDate(d) {
  return d.toISOString();
}
module.exports = { formatDate };
`)
      gitAdd(tmpDir, '.')
      gitCommit(tmpDir, 'initial')

      // Change multiple files with behavioral changes, no tests
      createFile(tmpDir, 'src/auth.js', `
function authenticate(user, pass) {
  return user === 'admin' && pass === 'secret';
}
function validateToken(token) {
  return token && token.length > 10;
}
module.exports = { authenticate, validateToken };
`)
      createFile(tmpDir, 'src/api.js', `
function fetchData(url) {
  return fetch(url).then(r => r.json());
}
function postData(url, data) {
  return fetch(url, { method: 'POST', body: JSON.stringify(data) });
}
module.exports = { fetchData, postData };
`)
      createFile(tmpDir, 'src/utils.js', `
function formatDate(d) {
  return d.toISOString();
}
function parseDate(s) {
  return new Date(s);
}
module.exports = { formatDate, parseDate };
`)

      const result = runReviewer(tmpDir)
      const parsed = parseReviewerResult(result.stdout)

      assert.strictEqual(parsed.pass, false, `Expected FAIL for multiple source changes with new functions, got: ${result.stdout}`)
    })
  })
})
