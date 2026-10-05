#!/bin/bash
# Start both the Python HOLE2 service and the Next.js standalone server.
# Usage: bash start-servers.sh

cd "$(dirname "$0")"
LOG_DIR=".zscripts"
mkdir -p "$LOG_DIR"

# 1. Start Python HOLE2 service (port 3001)
if ! pgrep -f "uvicorn main:app" > /dev/null 2>&1; then
    echo "Starting HOLE2 Python service on port 3001..."
    setsid bash -c 'cd mini-services/hole2-service && exec bash start.sh' > "$LOG_DIR/hole2-service.log" 2>&1 < /dev/null &
    disown
    # Wait for the service to be ready (up to 30 seconds)
    for i in $(seq 1 30); do
        if curl -s http://localhost:3001/api/health > /dev/null 2>&1; then
            echo "  HOLE2 service is ready (after ${i}s)"
            break
        fi
        sleep 1
    done
else
    echo "HOLE2 Python service already running"
fi

# 2. Build Next.js if needed
if [ ! -f ".next/standalone/server.js" ]; then
    echo "Building Next.js (standalone)..."
    NODE_OPTIONS="--max-old-space-size=2048" npx next build 2>&1 | tail -5
    cp -r .next/static .next/standalone/.next/ 2>/dev/null
    cp -r public .next/standalone/ 2>/dev/null
fi

# 3. Start Next.js standalone server (port 3000)
if ! pgrep -f "standalone/server.js" > /dev/null 2>&1; then
    echo "Starting Next.js standalone server on port 3000..."
    setsid bash -c 'cd .next/standalone && PORT=3000 exec node server.js' > "$LOG_DIR/next-server.log" 2>&1 < /dev/null &
    disown
    sleep 3
else
    echo "Next.js server already running"
fi

echo ""
echo "=== Status ==="
echo "Python service: $(curl -s http://localhost:3001/api/health 2>/dev/null | head -c 60)"
echo "Next.js:        $(curl -s http://localhost:3000/ -o /dev/null -w 'HTTP %{http_code}' 2>/dev/null)"
echo ""
echo "Logs: $LOG_DIR/hole2-service.log, $LOG_DIR/next-server.log"
echo "Open: http://localhost:3000/"
