#!/usr/bin/env bash
# AgentForge start script — autónomo, no modifica el sistema
# Usage: ./scripts/start.sh [--tunnel] [--verbose] [--port PORT]
set -euo pipefail

TUNNEL=false
VERBOSE=false
PORT=4242

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  -t, --tunnel        Start with Cloudflare tunnel (prints URL only)
  -v, --verbose       Show full logs (server + tunnel)
  -p, --port PORT     Port to listen on (default: 4242)
  -h, --help          Show this help

Examples:
  $(basename "$0")                    # Normal start
  $(basename "$0") --tunnel           # Start + tunnel, prints URL only
  $(basename "$0") --tunnel --verbose # Start + tunnel, full logs
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --tunnel|-t)  TUNNEL=true;  shift ;;
    --verbose|-v) VERBOSE=true; shift ;;
    --port|-p)    PORT="$2";    shift 2 ;;
    --help|-h)    usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
CLI="$ROOT_DIR/src/cli.js"
CACHE_DIR="$ROOT_DIR/.cache"
CLOUDFLARED_BIN="$CACHE_DIR/cloudflared"

log() { if $VERBOSE; then echo "$1" >&2; fi; }

# ------------------------------------------------------------------
# Asegura cloudflared disponible localmente (sin tocar el sistema)
# ------------------------------------------------------------------
ensure_cloudflared() {
  if command -v cloudflared &>/dev/null; then
    CLOUDFLARED_BIN="$(command -v cloudflared)"
    return
  fi

  if [[ -x "$CLOUDFLARED_BIN" ]]; then
    return
  fi

  echo "[tunnel] cloudflared no encontrado, descargando en .cache/ (solo una vez)..." >&2
  mkdir -p "$CACHE_DIR"

  local arch os url
  arch="$(uname -m)"
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"

  case "$arch" in
    x86_64)  arch="amd64" ;;
    aarch64) arch="arm64" ;;
    armv7l)  arch="arm"   ;;
    *) echo "Arquitectura no soportada: $arch" >&2; exit 1 ;;
  esac

  if [[ "$os" == "darwin" ]]; then
    url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz"
    curl -fsSL "$url" -o "$CACHE_DIR/cloudflared.tgz"
    tar -xzf "$CACHE_DIR/cloudflared.tgz" -C "$CACHE_DIR"
    rm -f "$CACHE_DIR/cloudflared.tgz"
  else
    url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
    curl -fsSL "$url" -o "$CLOUDFLARED_BIN"
  fi

  chmod +x "$CLOUDFLARED_BIN"
  echo "[tunnel] cloudflared listo: $CLOUDFLARED_BIN" >&2
}

# ------------------------------------------------------------------
# Espera hasta que el API responda (max 15s)
# ------------------------------------------------------------------
wait_for_server() {
  local max=15 i=0
  log "[tunnel] Esperando servidor en puerto $PORT..."
  while ! curl -sf "http://localhost:$PORT/api/status" >/dev/null 2>&1; do
    sleep 1; i=$((i + 1))
    if [[ $i -ge $max ]]; then
      echo "Error: el servidor no respondió después de ${max}s" >&2
      kill "$AF_PID" 2>/dev/null || true
      exit 1
    fi
  done
  log "[tunnel] Servidor listo."
}

# ------------------------------------------------------------------
# TUNNEL mode
# ------------------------------------------------------------------
if $TUNNEL; then
  ensure_cloudflared

  AF_PID=""
  CF_PID=""
  CF_LOG="$(mktemp)"

  cleanup() {
    if [[ -n "${AF_PID:-}" ]]; then kill "$AF_PID" 2>/dev/null || true; fi
    if [[ -n "${CF_PID:-}" ]]; then kill "$CF_PID" 2>/dev/null || true; fi
    rm -f "$CF_LOG"
  }
  trap cleanup EXIT INT TERM

  # Arranca agentforge en background
  if $VERBOSE; then
    node "$CLI" start --port "$PORT" --host "0.0.0.0" &
  else
    node "$CLI" start --port "$PORT" --host "0.0.0.0" >/dev/null 2>&1 &
  fi
  AF_PID=$!

  wait_for_server

  # Lanza cloudflared en background
  if $VERBOSE; then
    "$CLOUDFLARED_BIN" tunnel --url "http://localhost:$PORT" 2>&1 | tee "$CF_LOG" &
  else
    "$CLOUDFLARED_BIN" tunnel --url "http://localhost:$PORT" >"$CF_LOG" 2>&1 &
  fi
  CF_PID=$!

  # Espera la URL en el log (max 30s)
  url=""
  i=0
  while [[ $i -lt 30 ]]; do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -1 || true)"
    if [[ -n "$url" ]]; then break; fi
    sleep 1
    i=$((i + 1))
  done

  if [[ -z "$url" ]]; then
    echo "Error: no se pudo obtener la URL del túnel" >&2
    exit 1
  fi

  if $VERBOSE; then
    echo "" >&2
    echo ">>> Tunnel URL: $url" >&2
    echo "" >&2
  else
    echo "$url"
  fi

  # Mantiene el proceso vivo hasta Ctrl+C
  wait "$CF_PID" 2>/dev/null || true
  wait "$AF_PID" 2>/dev/null || true

# ------------------------------------------------------------------
# NORMAL mode
# ------------------------------------------------------------------
else
  exec node "$CLI" start --port "$PORT"
fi
