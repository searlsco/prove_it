'use strict'

const { VAR_DESCRIPTIONS } = require('./template')

/**
 * Extract ordered array of bare {{var}} names from an internal template body.
 * Skips {{#var}} and {{/var}} conditional markers.
 */
function extractTemplateVars (body) {
  if (!body) return []
  const vars = []
  const re = /\{\{(\w+)\}\}/g
  let match
  while ((match = re.exec(body)) !== null) {
    vars.push(match[1])
  }
  return vars
}

/**
 * Forward mapping: transform internal template body to standalone body.
 * - Strips {{#var_name}}\n and \n{{/var_name}} conditional markers
 * - Replaces each {{var}} with {{VAR_DESCRIPTIONS[var]}}
 */
function generateStandaloneBody (internalBody) {
  if (!internalBody) return internalBody

  // Strip conditional markers: {{#var_name}}\n and \n{{/var_name}}
  let result = internalBody.replace(/\{\{#\w+\}\}\n/g, '')
  result = result.replace(/\n\{\{\/\w+\}\}/g, '')

  // Replace each {{var}} with {{description}}
  result = result.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const desc = VAR_DESCRIPTIONS[varName]
    return desc ? `{{${desc}}}` : match
  })

  return result
}

/**
 * Reverse mapping: positionally restore {{var}} names from standalone body
 * using the internal template as the source of truth for var ordering.
 */
function restoreTemplateVars (standaloneBody, internalBody) {
  if (!standaloneBody || !internalBody) return standaloneBody
  const varList = extractTemplateVars(internalBody)
  if (varList.length === 0) return standaloneBody

  let idx = 0
  return standaloneBody.replace(/\{\{([^}]+)\}\}/g, (match) => {
    if (idx < varList.length) {
      return `{{${varList[idx++]}}}`
    }
    return match
  })
}

/**
 * Transform a full skill file (with YAML frontmatter) to standalone form.
 * Preserves frontmatter, transforms only the body.
 */
function generateStandaloneSkill (fullContent) {
  if (!fullContent) return fullContent
  if (!fullContent.startsWith('---\n')) {
    return generateStandaloneBody(fullContent)
  }
  const endIdx = fullContent.indexOf('\n---\n', 4)
  if (endIdx === -1) {
    return generateStandaloneBody(fullContent)
  }
  const frontmatter = fullContent.slice(0, endIdx + 5)
  const body = fullContent.slice(endIdx + 5)
  return frontmatter + generateStandaloneBody(body)
}

module.exports = { extractTemplateVars, generateStandaloneBody, restoreTemplateVars, generateStandaloneSkill }
