#!/usr/bin/env bash
# graphiti-mem — One-line installer
# Usage: curl -sSf https://graphiti-mem.dev/install.sh | bash
set -euo pipefail

REPO="https://github.com/oliverhees/graphiti-mem"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo ""
echo "  graphiti-mem — Temporal Knowledge Graph Memory for Claude Code"
echo "  ================================================================"
echo ""

# Check for git
if ! command -v git &>/dev/null; then
  echo "Error: git is required. Install git and try again."
  exit 1
fi

# Check for node >= 18
if ! command -v node &>/dev/null; then
  echo "Error: Node.js >= 18 is required."
  echo "Install from: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.version.split('.')[0].slice(1))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js $NODE_MAJOR.x is too old. Need >= 18."
  exit 1
fi

echo "Cloning graphiti-mem..."
git clone --depth 1 "$REPO" "$TMP_DIR/graphiti-mem" 2>/dev/null

echo "Building installer..."
cd "$TMP_DIR/graphiti-mem/installer"
npm install --silent 2>/dev/null
npm run build --silent 2>/dev/null

echo "Running installer..."
node dist/index.js

echo ""
echo "Done! Restart Claude Code to activate graphiti-mem."
