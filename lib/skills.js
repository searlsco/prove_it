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
 * Extract the block content between {{#var}} and {{/var}} from an internal
 * template. Returns a Map of varName → block content (without the markers).
 */
function extractConditionalBlocks (body) {
  const blocks = new Map()
  if (!body) return blocks
  const re = /\{\{#(\w+)\}\}\n([\s\S]*?)\n\{\{\/\1\}\}/g
  let match
  while ((match = re.exec(body)) !== null) {
    blocks.set(match[1], match[2])
  }
  return blocks
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
  // Extract the exact block content from the internal template (where markers
  // are unambiguous), then find the corresponding content in the restored body
  // (after var replacement, the block content matches) and wrap it with markers.
  const conditionalBlocks = extractConditionalBlocks(internalBody)
  // Process from bottom to top so insertions don't shift earlier positions
  const insertions = []
  for (const [varName, blockContent] of conditionalBlocks) {
    // The block content has {{var}} in it — after var restoration, it should
    // appear literally in the result. generateStandaloneBody replaced {{var}}
    // with {{description}}, but we already restored {{var}} above.
    const contentIdx = result.indexOf(blockContent)
    if (contentIdx === -1) continue
    insertions.push({
      start: contentIdx,
      end: contentIdx + blockContent.length,
      varName
    })
  }
  // Sort by position descending so we process from bottom to top
  insertions.sort((a, b) => b.start - a.start)
  for (const { start, end, varName } of insertions) {
    const block = result.slice(start, end)
    result = result.slice(0, start) + `{{#${varName}}}\n${block}\n{{/${varName}}}` + result.slice(end)
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
