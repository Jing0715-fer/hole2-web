#!/bin/bash
# Start both the Python HOLE2 service and the Next.js standalone server.
# This is a convenience script for manual startup.
# The sandbox's .zscripts/dev.sh handles auto-startup on deployment.

cd "$(dirname "$0")"

# 1. Start Python HOLE2 service (port 3001)
if ! pgrep -f "uvicorn main:app" > /dev/null 2>&1; then
    echo "Starting HOLE2 Python service on port 3001..."
    setsid bash -c 'cd mini-services/hole2-service && exec bash start.sh' > /tmp/hole2-service.log 2>&1 < /dev/null &
    disown
    sleep 3
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
    setsid bash -c 'cd .next/standalone && PORT=3000 exec node server.js' > /tmp/next-prod.log 2>&1 < /dev/null &
    disown
    sleep 3
fi

echo "--- Status ---"
echo "Python service: $(curl -s http://localhost:3001/api/health 2>/dev/null | head -c 50)"
echo "Next.js:        $(curl -s http://localhost:3000/ -o /dev/null -w 'HTTP %{http_code}' 2>/dev/null)"
echo "Gateway (81):   $(curl -s http://localhost:81/ -o /dev/null -w 'HTTP %{http_code}' 2>/dev/null)"
