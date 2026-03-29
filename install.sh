#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/datboip/HumanAIE.git"
DIR="HumanAIE"

# Check for node
if ! command -v node &>/dev/null; then
  echo "Error: node is not installed. Install Node.js 18+ and try again."
  exit 1
fi

# Check for npm
if ! command -v npm &>/dev/null; then
  echo "Error: npm is not installed. Install Node.js 18+ and try again."
  exit 1
fi

# Check node version
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found v$(node -v))"
  exit 1
fi

# Clone if not already present
if [ -d "$DIR" ]; then
  echo "Directory $DIR already exists, pulling latest..."
  cd "$DIR"
  git pull
else
  echo "Cloning HumanAIE..."
  git clone "$REPO" "$DIR"
  cd "$DIR"
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Install Playwright Chromium
echo "Installing Chromium..."
npx playwright install chromium

echo ""
echo "========================================="
echo "  HumanAIE installed successfully"
echo "========================================="
echo ""
echo "  Start:  npm start"
echo "  Open:   http://localhost:3333/cam/"
echo ""
