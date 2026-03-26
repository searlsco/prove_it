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
 * Extract the set of var names that have conditional blocks in a template body.
 */
function extractConditionalVars (body) {
  if (!body) return new Set()
  const vars = new Set()
  const re = /\{\{#(\w+)\}\}/g
  let match
  while ((match = re.exec(body)) !== null) vars.add(match[1])
  return vars
}

/**
 * Reverse mapping: positionally restore {{var}} names from standalone body
 * using the internal template as the source of truth for var ordering.
 * Also re-wraps vars that had conditional blocks in the internal template.
 */
function restoreTemplateVars (standaloneBody, internalBody) {
  if (!standaloneBody || !internalBody) return standaloneBody
  const varList = extractTemplateVars(internalBody)
  if (varList.length === 0) return standaloneBody

  let idx = 0
  let result = standaloneBody.replace(/\{\{([^}]+)\}\}/g, (match, content) => {
    // Skip conditional markers {{#var}} and {{/var}} — these appear
    // in old installed files that predate the standalone transform
    if (/^[#/]\w+$/.test(content)) return match
    if (idx < varList.length) {
      return `{{${varList[idx++]}}}`
    }
    return match
  })

  // Re-wrap vars that had conditional blocks in the internal template.
  // The standalone stripped {{#var}}\n and \n{{/var}}, so we find each
  // conditional var in the result and wrap the line containing {{var}}
  // (plus the preceding label line) with the markers.
  const conditionalVars = extractConditionalVars(internalBody)
  for (const varName of conditionalVars) {
    const varTag = `{{${varName}}}`
    const varIdx = result.indexOf(varTag)
    if (varIdx === -1) continue

    // Find the start of the line containing {{var}}
    const lineStart = result.lastIndexOf('\n', varIdx - 1)
    // Find the line before that (the label line that was inside the conditional block)
    const prevLineStart = lineStart > 0 ? result.lastIndexOf('\n', lineStart - 1) : -1

    // The block to wrap starts at the beginning of the label line
    const blockStart = prevLineStart + 1
    const blockEnd = varIdx + varTag.length

    const block = result.slice(blockStart, blockEnd)
    const wrapped = `{{#${varName}}}\n${block}\n{{/${varName}}}`
    result = result.slice(0, blockStart) + wrapped + result.slice(blockEnd)
  }

  return result
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
