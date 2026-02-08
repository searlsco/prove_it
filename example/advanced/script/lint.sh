#!/usr/bin/env bash
set -e

# Simple lint: check for console.log in source files
if grep -rn 'console\.log' src/ 2>/dev/null; then
  echo "Lint error: console.log found in source files" >&2
  exit 1
fi

echo "Lint passed"
