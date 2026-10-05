#!/bin/bash
# Build (if needed) and start the Next.js server on port 3000.
# Usage: bash start-servers.sh
#
# The HOLE2 binaries (vendor/hole2/bin/) are spawned directly from the
# Next.js route handlers — no Python mini-service required.  Everything
# runs on a single port (3000).

cd "$(dirname "$0")"
LOG_DIR=".zscripts"
mkdir -p "$LOG_DIR"

# 1. Build Next.js if needed
if [ ! -d ".next" ]; then
    echo "Building Next.js..."
    NODE_OPTIONS="--max-old-space-size=2048" npx next build 2>&1 | tail -5
fi

# 2. Start Next.js server on port 3000
if ! pgrep -f "next start" > /dev/null 2>&1; then
    echo "Starting Next.js server on port 3000..."
    setsid bash -c 'PORT=3000 exec npx next start -p 3000' > "$LOG_DIR/next-server.log" 2>&1 < /dev/null &
    disown
    sleep 3
else
    echo "Next.js server already running"
fi

echo ""
echo "=== Status ==="
echo "Health:  $(curl -s http://localhost:3000/api/health 2>/dev/null | head -c 200)"
echo "Next.js: $(curl -s http://localhost:3000/ -o /dev/null -w 'HTTP %{http_code}' 2>/dev/null)"
echo ""
echo "Logs: $LOG_DIR/next-server.log"
echo "Open: http://localhost:3000/"
