#!/bin/bash
# Start the Next.js server with bundled HOLE2 — single port (3000).
# No Python service needed.

cd "$(dirname "$0")"
LOG_DIR=".zscripts"
mkdir -p "$LOG_DIR"

# 1. Build Next.js if needed
if [ ! -f ".next/standalone/server.js" ]; then
    echo "Building Next.js (standalone)..."
    NODE_OPTIONS="--max-old-space-size=2048" npx next build 2>&1 | tail -5
fi

# 2. Ensure static files are in the standalone dir
if [ ! -d ".next/standalone/.next/static" ]; then
    cp -r .next/static .next/standalone/.next/ 2>/dev/null
fi
cp -r public .next/standalone/ 2>/dev/null

# 3. Start Next.js server
if ! pgrep -f "next-server\|standalone/server.js" > /dev/null 2>&1; then
    echo "Starting Next.js on port 3000..."
    setsid bash -c 'cd .next/standalone && PORT=3000 exec node server.js' > "$LOG_DIR/next-server.log" 2>&1 < /dev/null &
    disown
    sleep 3
else
    echo "Next.js already running"
fi

echo ""
echo "=== Status ==="
echo "Next.js: $(curl -s http://localhost:3000/api/health 2>/dev/null | head -c 60)"
echo ""
echo "Log: $LOG_DIR/next-server.log"
echo "Open: http://localhost:3000/"
