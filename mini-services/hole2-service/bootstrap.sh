#!/usr/bin/env bash
# Bootstrap the HOLE2 micromamba environment so the FastAPI service can run.
# Idempotent: re-running is a no-op once the env exists.
set -euo pipefail

MAMBA_ROOT="${MAMBA_ROOT_PREFIX:-/tmp/mamba-root}"
MM_BIN="${MICROMAMBA_BIN:-/tmp/mm/bin/micromamba}"
ENV_NAME="${HOLE2_ENV_NAME:-hole2}"
ENV_PREFIX="$MAMBA_ROOT/envs/$ENV_NAME"

mkdir -p "$MAMBA_ROOT"

if [ ! -x "$MM_BIN" ]; then
  echo ">>> downloading micromamba static binary"
  curl -sL "https://micro.mamba.pm/api/micromamba/linux-64/latest" -o /tmp/micromamba.tar.bz2
  mkdir -p "$(dirname "$MM_BIN")"
  tar -xjf /tmp/micromamba.tar.bz2 -C "$(dirname "$MM_BIN")/.."
fi

if [ ! -d "$ENV_PREFIX" ] || [ ! -x "$ENV_PREFIX/bin/hole" ]; then
  echo ">>> creating hole2 conda-forge env (this downloads ~200 MB on first run)"
  "$MM_BIN" create -y -n "$ENV_NAME" -c conda-forge hole2 gfortran
else
  echo ">>> hole2 env already exists at $ENV_PREFIX"
fi

echo ">>> verifying hole binary"
"$MM_BIN" run -n "$ENV_NAME" hole 2>&1 | head -3 || true

echo ">>> hole2 env ready: $ENV_PREFIX"
