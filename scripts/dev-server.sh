#!/bin/bash
# Start the Next.js standalone server on port 3000.
# Used by "bun run dev" (package.json dev script).
# Requires a prior "bun run build" to generate .next/standalone/.

cd "$(dirname "$0")/.."

if [ ! -f ".next/standalone/server.js" ]; then
    echo "[dev-server] Build not found, running bun run build..."
    bun run build
fi

echo "[dev-server] Starting Next.js standalone server on port 3000..."
cd .next/standalone
PORT=3000 exec node server.js
