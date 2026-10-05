#!/bin/bash
# Start both the Python HOLE2 service and the Next.js production server.
# Uses setsid to detach from the terminal so processes survive bash session exits.

cd /home/z/my-project

# 1. Start Python HOLE2 mini-service (port 3001) if not running
if ! pgrep -f "uvicorn main:app" > /dev/null 2>&1; then
  echo "Starting HOLE2 Python service on port 3001..."
  setsid bash -c 'cd /home/z/my-project/mini-services/hole2-service && exec python3 -m uvicorn main:app --host 0.0.0.0 --port 3001' > /tmp/hole2-service.log 2>&1 < /dev/null &
  disown
  sleep 2
fi

# 2. Build Next.js if .next doesn't exist
if [ ! -f .next/BUILD_ID ]; then
  echo "Building Next.js production bundle..."
  NODE_OPTIONS="--max-old-space-size=2048" npx next build 2>&1 | tail -5
fi

# 3. Start Next.js production server (port 3000) if not running
if ! pgrep -f "next-server" > /dev/null 2>&1; then
  echo "Starting Next.js production server on port 3000..."
  setsid bash -c 'cd /home/z/my-project && exec npx next start -p 3000' > /tmp/next-prod.log 2>&1 < /dev/null &
  disown
  sleep 5
fi

echo "--- Status ---"
echo "Python service: $(curl -s http://localhost:3001/api/health 2>/dev/null | head -c 50)"
echo "Next.js:        $(curl -s http://localhost:3000/ -o /dev/null -w 'HTTP %{http_code}' 2>/dev/null)"
echo "Gateway (81):   $(curl -s http://localhost:81/ -o /dev/null -w 'HTTP %{http_code}' 2>/dev/null)"
