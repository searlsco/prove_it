function greet (name) {
  if (!name || typeof name !== 'string') {
    return 'Hello, world!'
  }
  return `Hello, ${name}!`
}

module.exports = { greet }
