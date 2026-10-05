#!/bin/bash
# Start the HOLE2 Python FastAPI service on port 3001.
#
# The HOLE2 binaries are BUNDLED in vendor/hole2/bin/ — no conda/micromamba
# installation is needed. The binaries use the system's libgfortran.so.5.
#
# This script is called by .zscripts/dev.sh via "bun run dev".
# It can also be called directly: bash mini-services/hole2-service/start.sh

set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"
cd "$SERVICE_DIR"

echo "[hole2-service] Starting..."

# 1. Verify bundled HOLE2 binaries exist
if [ -f "$PROJECT_ROOT/vendor/hole2/bin/hole" ]; then
    echo "[hole2-service] Using bundled HOLE2 binaries from vendor/hole2/bin/"
    # Make sure binaries are executable
    chmod +x "$PROJECT_ROOT/vendor/hole2/bin/"* 2>/dev/null || true
else
    echo "[hole2-service] WARNING: Bundled binaries not found at vendor/hole2/bin/"
    echo "[hole2-service] The service will start but HOLE2 runs will fail."
    echo "[hole2-service] Expected: $PROJECT_ROOT/vendor/hole2/bin/hole"
fi

# 2. Ensure Python deps (fastapi, uvicorn, etc.) are available
PYTHON="${PYTHON:-python3}"
if ! "$PYTHON" -c "import fastapi" 2>/dev/null; then
    echo "[hole2-service] Installing Python deps..."
    # Try uv first, then pip3
    if command -v uv >/dev/null 2>&1; then
        uv pip install --system fastapi uvicorn python-multipart aiofiles || true
    elif command -v pip3 >/dev/null 2>&1; then
        pip3 install fastapi uvicorn python-multipart aiofiles || true
    else
        echo "[hole2-service] WARNING: Could not install Python deps."
        echo "[hole2-service] Please install manually: pip3 install fastapi uvicorn python-multipart aiofiles"
    fi
fi

# 3. Start the FastAPI server
echo "[hole2-service] Starting uvicorn on port 3001..."
exec "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port 3001
