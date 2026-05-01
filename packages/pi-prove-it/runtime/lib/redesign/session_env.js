const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function validateEnvVarName (name) {
  return typeof name === 'string' && ENV_VAR_NAME_PATTERN.test(name)
}

function parseSessionEnvOutput (stdout) {
  const trimmed = (stdout || '').trim()
  if (!trimmed) return { vars: {}, parseError: null }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { vars: {}, parseError: 'JSON output must be an object with string values' }
      }
      const vars = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (!validateEnvVarName(key)) {
          return { vars: {}, parseError: `invalid variable name "${key}"` }
        }
        if (typeof value !== 'string') {
          return { vars: {}, parseError: `JSON value for "${key}" must be a string, got ${typeof value}` }
        }
        vars[key] = value
      }
      return { vars, parseError: null }
    } catch (error) {
      return { vars: {}, parseError: `Failed to parse JSON: ${error.message}` }
    }
  }

  const vars = {}
  const lines = trimmed.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue

    const stripped = line.startsWith('export ') ? line.slice(7) : line
    const eqIdx = stripped.indexOf('=')
    if (eqIdx === -1) {
      return { vars: {}, parseError: `Line ${i + 1}: no "=" found in "${line}"` }
    }

    const key = stripped.slice(0, eqIdx).trim()
    let value = stripped.slice(eqIdx + 1).trim()

    if (!validateEnvVarName(key)) {
      return { vars: {}, parseError: `Line ${i + 1}: invalid variable name "${key}"` }
    }

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    vars[key] = value
  }

  return { vars, parseError: null }
}

module.exports = {
  ENV_VAR_NAME_PATTERN,
  parseSessionEnvOutput,
  validateEnvVarName
}
