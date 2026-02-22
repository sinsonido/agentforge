#!/bin/sh
# docker/entrypoint.sh — AgentForge container entrypoint
#
# Responsibilities:
#   1. Ensure agentforge.yml exists (copies from example if absent).
#   2. Create the runtime data directory if needed.
#   3. Exec the CLI command, replacing this shell process so that
#      signals (SIGINT / SIGTERM) are delivered directly to Node.

set -e

CONFIG_FILE="${AGENTFORGE_CONFIG:-/app/agentforge.yml}"
EXAMPLE_FILE="/app/agentforge.example.yml"
DATA_DIR="${AGENTFORGE_DATA_DIR:-/app/.agentforge}"

# ── 1. Bootstrap config ──────────────────────────────────────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "$EXAMPLE_FILE" ]; then
    echo "[entrypoint] agentforge.yml not found — copying from agentforge.example.yml"
    cp "$EXAMPLE_FILE" "$CONFIG_FILE"
  else
    echo "[entrypoint] WARNING: Neither $CONFIG_FILE nor $EXAMPLE_FILE found." >&2
    echo "[entrypoint] Mount your agentforge.yml to $CONFIG_FILE and restart." >&2
    exit 1
  fi
fi

# ── 2. Ensure the data directory exists ─────────────────────────────────────
mkdir -p "$DATA_DIR"

# ── 3. Hand off to the CLI ───────────────────────────────────────────────────
# Pass all arguments through so the container CMD / docker run args work normally.
# Default to "start" when no sub-command is provided.
if [ "$#" -eq 0 ]; then
  exec node /app/src/cli.js start
else
  exec node /app/src/cli.js "$@"
fi
