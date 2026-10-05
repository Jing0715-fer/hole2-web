#!/bin/bash
# Start the HOLE2 Python FastAPI service on port 3001.
# HOLE2 binaries are bundled in vendor/hole2/bin/ -- no conda needed.

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"
cd "$SERVICE_DIR"

echo "[hole2-service] Starting..."

# 1. Verify bundled HOLE2 binaries exist
if [ -f "$PROJECT_ROOT/vendor/hole2/bin/hole" ]; then
    echo "[hole2-service] Using bundled HOLE2 binaries from vendor/hole2/bin/"
    chmod +x "$PROJECT_ROOT/vendor/hole2/bin/"* 2>/dev/null
else
    echo "[hole2-service] WARNING: Bundled binaries not found"
fi

# 2. Start the FastAPI server using uv (auto-installs Python deps)
if command -v uv >/dev/null 2>&1; then
    echo "[hole2-service] Using uv to run the service..."
    exec uv run --with-requirements requirements.txt python -m uvicorn main:app --host 0.0.0.0 --port 3001
fi

# 3. Fallback: use system python3
PYTHON="${PYTHON:-python3}"
echo "[hole2-service] Using $PYTHON"

if ! "$PYTHON" -c "import fastapi, uvicorn, multipart, aiofiles" 2>/dev/null; then
    echo "[hole2-service] Installing Python deps..."
    "$PYTHON" -m pip install -r requirements.txt 2>/dev/null || \
    "$PYTHON" -m pip install --user -r requirements.txt 2>/dev/null || \
    "$PYTHON" -m pip install --break-system-packages -r requirements.txt 2>/dev/null || \
    echo "[hole2-service] WARNING: Could not install deps"
fi

echo "[hole2-service] Starting uvicorn on port 3001..."
exec "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port 3001
