#!/bin/bash
# Start the Next.js server on port 3000.
# Used by "bun run dev" (package.json dev script) and by start-servers.sh.
#
# The HOLE2 binaries (vendor/hole2/bin/) are spawned directly from the
# Next.js route handlers — no Python mini-service required.

cd "$(dirname "$0")/.."

if [ ! -d ".next" ]; then
    echo "[dev-server] Build not found, running bun run build..."
    bun run build
fi

echo "[dev-server] Starting Next.js server on port 3000..."
exec npx next start -p 3000
