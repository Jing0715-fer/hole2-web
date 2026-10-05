#!/bin/bash
# Start the HOLE2 Python FastAPI service on port 3001.
#
# This script is called by .zscripts/dev.sh via "bun run dev".
# It ensures the HOLE2 conda env exists (running bootstrap.sh if needed),
# then starts uvicorn with the FastAPI app.
#
# The service wraps the HOLE2 command-line suite (hole, sph_process,
# sos_triangle, qpt_conv) and exposes REST endpoints for the web UI.

set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SERVICE_DIR"

MAMBA_ROOT="${MAMBA_ROOT_PREFIX:-/tmp/mamba-root}"
MM_BIN="${MICROMAMBA_BIN:-/tmp/mm/bin/micromamba}"
HOLE2_ENV="hole2"
ENV_PREFIX="$MAMBA_ROOT/envs/$HOLE2_ENV"

# 1. Ensure the HOLE2 conda env exists (idempotent — bootstrap.sh handles this)
if [ ! -x "$ENV_PREFIX/bin/hole" ]; then
    echo "[hole2-service] HOLE2 env not found, running bootstrap..."
    bash "$SERVICE_DIR/bootstrap.sh"
fi

# 2. Ensure Python deps (fastapi, uvicorn, etc.) are available
#    We use the system Python (not the conda env's Python) to run the
#    FastAPI service — the conda env is only needed for the HOLE2 binaries.
PYTHON="${PYTHON:-python3}"
if ! "$PYTHON" -c "import fastapi" 2>/dev/null; then
    echo "[hole2-service] Installing Python deps via uv..."
    uv pip install --system fastapi uvicorn python-multipart aiofiles 2>/dev/null || \
    pip3 install fastapi uvicorn python-multipart aiofiles 2>/dev/null || true
fi

# 3. Start the FastAPI server
export MAMBA_ROOT_PREFIX="$MAMBA_ROOT"
export HOLE2_ENV_NAME="$HOLE2_ENV"

echo "[hole2-service] Starting uvicorn on port 3001..."
exec "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port 3001
