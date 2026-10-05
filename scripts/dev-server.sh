#!/bin/bash
# Start the Next.js server on port 3000.
# Used by "bun run dev" (package.json dev script) and by start-servers.sh.
#
# The HOLE2 binaries (vendor/hole2/bin/) are spawned directly from the
# Next.js route handlers — no Python mini-service required.

cd "$(dirname "$0")/.."

if [ ! -f ".next/standalone/server.js" ]; then
    echo "[dev-server] Build not found, running bun run build..."
    NODE_OPTIONS="--max-old-space-size=2048" npx next build
    # Copy static files into standalone dir (required for serving CSS/JS)
    cp -r .next/static .next/standalone/.next/ 2>/dev/null
    cp -r public .next/standalone/ 2>/dev/null
fi

# Ensure static files are in place (in case of partial builds)
if [ ! -d ".next/standalone/.next/static" ]; then
    cp -r .next/static .next/standalone/.next/ 2>/dev/null
fi

echo "[dev-server] Starting Next.js server on port 3000..."
exec npx next start -p 3000
