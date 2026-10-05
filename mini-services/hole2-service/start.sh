#!/bin/bash
# Start the HOLE2 Python FastAPI service on port 3001.
# HOLE2 binaries are bundled in vendor/hole2/bin/ -- no conda needed.
# Python deps are installed into a local venv (no system pollution).

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"
cd "$SERVICE_DIR"

TAG="[hole2-service]"
echo "$TAG Starting..."

# 1. Verify bundled HOLE2 binaries exist
if [ -f "$PROJECT_ROOT/vendor/hole2/bin/hole" ]; then
    echo "$TAG Using bundled HOLE2 binaries from vendor/hole2/bin/"
    chmod +x "$PROJECT_ROOT/vendor/hole2/bin/"* 2>/dev/null
else
    echo "$TAG WARNING: Bundled binaries not found"
fi

# 2. Create a Python virtual environment and install deps
VENV_DIR="$SERVICE_DIR/.venv"
PYTHON="${PYTHON:-python3}"

if [ ! -d "$VENV_DIR" ]; then
    echo "$TAG Creating Python venv at $VENV_DIR ..."
    "$PYTHON" -m venv "$VENV_DIR" 2>/dev/null || {
        echo "$TAG ERROR: Could not create venv with $PYTHON"
        echo "$TAG Trying uv run as fallback..."
        if command -v uv >/dev/null 2>&1; then
            exec uv run --with-requirements requirements.txt python -m uvicorn main:app --host 0.0.0.0 --port 3001
        fi
        exit 1
    }
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Install deps if not already installed
if ! python -c "import fastapi" 2>/dev/null; then
    echo "$TAG Installing Python deps into venv..."
    pip install -r requirements.txt 2>&1 | tail -3
fi

echo "$TAG Starting uvicorn on port 3001..."
exec python -m uvicorn main:app --host 0.0.0.0 --port 3001
