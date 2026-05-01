#!/usr/bin/env bun
/* global Bun */
'use strict'

const path = require('path')
const fs = require('fs')
const { createArchitectureModel } = require('./architecture_model')
const { renderArchitectureMarkdown } = require('./render_markdown')

function usage () {
  return [
    'Usage: bun tools/visualizer/generate.js [--output <path>] [--check]',
    '',
    'Generates the source-driven prove_it architecture visualizer markdown.',
    '',
    'Options:',
    '  -o, --output <path>  Output path. Defaults to docs/architecture.md',
    '  --check              Verify the output file is up to date without writing',
    '  -h, --help           Show this help'
  ].join('\n')
}

function parseArgs (argv) {
  const options = {
    output: path.join(process.cwd(), 'docs', 'architecture.md'),
    check: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '--check') {
      options.check = true
    } else if (arg === '-o' || arg === '--output') {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a path`)
      options.output = path.resolve(process.cwd(), value)
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

function architectureMarkdown () {
  return `${renderArchitectureMarkdown(createArchitectureModel())}\n`
}

async function writeFileWithBun (filePath, content) {
  if (typeof Bun === 'undefined' || typeof Bun.write !== 'function') {
    throw new Error('This visualizer generator must be run with Bun: bun tools/visualizer/generate.js')
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, content)
}

async function main (argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }

  const content = architectureMarkdown()

  if (options.check) {
    const existing = fs.existsSync(options.output) ? fs.readFileSync(options.output, 'utf8') : null
    if (existing !== content) {
      console.error(`${path.relative(process.cwd(), options.output)} is out of date. Run: bun tools/visualizer/generate.js`)
      return 1
    }
    console.log(`${path.relative(process.cwd(), options.output)} is up to date.`)
    return 0
  }

  await writeFileWithBun(options.output, content)
  console.log(`Wrote ${path.relative(process.cwd(), options.output)}`)
  return 0
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code
  }).catch(error => {
    console.error(`architecture visualizer failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  architectureMarkdown,
  main,
  parseArgs
}
