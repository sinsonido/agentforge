#!/usr/bin/env bash
# Run AgentForge from an immutable release directory, never from a working tree.
#
# Layout under $AGENTFORGE_HOME:
#   repo.git/           bare clone used as the export source
#   releases/<sha>/     complete release (its existence means "installed")
#   current             symlink to the active release
#   data/               SQLite database (container working directory)
#   config/             agentforge.yml, created once from the example
#   state/              reserved for the executor (per-task clones)
set -euo pipefail

AGENTFORGE_HOME="${AGENTFORGE_HOME:-$HOME/.agentforge-self}"
AGENTFORGE_REPO_URL="${AGENTFORGE_REPO_URL:-https://github.com/sinsonido/agentforge.git}"
AGENTFORGE_NODE_IMAGE="${AGENTFORGE_NODE_IMAGE:-node:24}"
AGENTFORGE_CONTAINER="${AGENTFORGE_CONTAINER:-agentforge-self}"
AGENTFORGE_BIND="${AGENTFORGE_BIND:-127.0.0.1}"
AGENTFORGE_PORT="${AGENTFORGE_PORT:-4343}"
# Reserved for the executor (#197, #198, #200). Not mounted yet.
AGENTFORGE_DOCKER_SOCKET="${AGENTFORGE_DOCKER_SOCKET:-/var/run/docker.sock}"
AGENTFORGE_STATE_DIR="${AGENTFORGE_STATE_DIR:-$AGENTFORGE_HOME/state}"

REPO="$AGENTFORGE_HOME/repo.git"
RELEASES="$AGENTFORGE_HOME/releases"
CURRENT="$AGENTFORGE_HOME/current"
DATA_DIR="$AGENTFORGE_HOME/data"
CONFIG_DIR="$AGENTFORGE_HOME/config"
CONTAINER_PORT=4242

log() { echo "[self-host] $*" >&2; }
die() { log "error: $*"; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [ref]

Commands:
  install <ref>   Build release <ref> (tag or SHA) and point 'current' at it
  start           Run the 'current' release in a container
  stop            Stop and remove the container
  status          Show the installed, running and reachable state
  upgrade <ref>   install <ref>, then restart if the running SHA differs

Environment:
  AGENTFORGE_HOME          $AGENTFORGE_HOME
  AGENTFORGE_REPO_URL      $AGENTFORGE_REPO_URL
  AGENTFORGE_NODE_IMAGE    $AGENTFORGE_NODE_IMAGE
  AGENTFORGE_CONTAINER     $AGENTFORGE_CONTAINER
  AGENTFORGE_BIND          $AGENTFORGE_BIND
  AGENTFORGE_PORT          $AGENTFORGE_PORT
  AGENTFORGE_DOCKER_SOCKET $AGENTFORGE_DOCKER_SOCKET (reserved, unused)
  AGENTFORGE_STATE_DIR     $AGENTFORGE_STATE_DIR (reserved, unused)
EOF
}

status_url() { echo "http://$AGENTFORGE_BIND:$AGENTFORGE_PORT/api/status"; }

current_sha() {
  if [[ -L "$CURRENT" ]]; then basename "$(readlink "$CURRENT")"; fi
}

running_sha() {
  docker inspect --format '{{ if .State.Running }}{{ index .Config.Labels "agentforge.sha" }}{{ end }}' \
    "$AGENTFORGE_CONTAINER" 2>/dev/null || true
}

resolve_ref() {
  local ref="$1"
  if [[ ! -d "$REPO" ]]; then
    log "cloning $AGENTFORGE_REPO_URL"
    git clone --quiet --bare "$AGENTFORGE_REPO_URL" "$REPO"
  fi
  git -C "$REPO" fetch --quiet --force --tags origin '+refs/heads/*:refs/heads/*'
  git -C "$REPO" rev-parse --verify --quiet "$ref^{commit}" || die "unknown ref: $ref"
}

build_release() {
  local sha="$1" staging="$RELEASES/.staging-$1-$$"
  rm -rf "$RELEASES"/.staging-"$sha"-*
  mkdir -p "$staging"
  git -C "$REPO" archive "$sha" | tar -x -C "$staging"
  log "building $sha in $AGENTFORGE_NODE_IMAGE"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$staging":/app -w /app "$AGENTFORGE_NODE_IMAGE" \
    sh -c 'npm ci --no-audit --no-fund && npm ci --prefix ui --no-audit --no-fund && npm run ui:build' >&2
  mv -T "$staging" "$RELEASES/$sha"
}

switch_current() {
  local sha="$1"
  [[ "$(current_sha)" == "$sha" ]] && return
  ln -sfn "releases/$sha" "$CURRENT.next"
  mv -T "$CURRENT.next" "$CURRENT"
  log "current -> $sha"
}

cmd_install() {
  local ref="${1:?install needs a ref}" sha
  mkdir -p "$RELEASES"
  sha="$(resolve_ref "$ref")"
  if [[ -d "$RELEASES/$sha" ]]; then
    log "release $sha already installed"
  else
    build_release "$sha"
  fi
  switch_current "$sha"
  echo "$sha"
}

ensure_config() {
  local config="$CONFIG_DIR/agentforge.yml"
  [[ -f "$config" ]] && return
  mkdir -p "$CONFIG_DIR"
  {
    cat "$CURRENT/agentforge.example.yml"
    printf '\n# Added by scripts/self-host.sh on first run\ndatabase:\n  path: /data/agentforge.db\n'
  } > "$config.tmp"
  mv "$config.tmp" "$config"
  log "created $config"
}

cmd_start() {
  local sha
  sha="$(current_sha)"
  [[ -n "$sha" ]] || die "nothing installed; run: $0 install <ref>"
  if [[ "$(running_sha)" == "$sha" ]]; then
    log "already running $sha"
    return
  fi
  docker rm -f "$AGENTFORGE_CONTAINER" >/dev/null 2>&1 || true
  mkdir -p "$DATA_DIR"
  ensure_config
  docker run -d --name "$AGENTFORGE_CONTAINER" --init --stop-signal SIGINT \
    --restart unless-stopped --label "agentforge.sha=$sha" \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -p "$AGENTFORGE_BIND:$AGENTFORGE_PORT:$CONTAINER_PORT" \
    -v "$RELEASES/$sha":/app:ro -v "$DATA_DIR":/data -v "$CONFIG_DIR":/config:ro \
    -w /data "$AGENTFORGE_NODE_IMAGE" \
    node /app/src/cli.js --config /config/agentforge.yml start --host 0.0.0.0 --port "$CONTAINER_PORT" >/dev/null
  curl -sf -o /dev/null --retry 30 --retry-delay 1 --retry-connrefused --retry-all-errors \
    "$(status_url)" || die "no answer from $(status_url); see: docker logs $AGENTFORGE_CONTAINER"
  log "started $sha on http://$AGENTFORGE_BIND:$AGENTFORGE_PORT"
}

cmd_stop() {
  if docker inspect "$AGENTFORGE_CONTAINER" >/dev/null 2>&1; then
    docker stop "$AGENTFORGE_CONTAINER" >/dev/null
    docker rm "$AGENTFORGE_CONTAINER" >/dev/null
    log "stopped $AGENTFORGE_CONTAINER"
  else
    log "not running"
  fi
}

cmd_status() {
  local running http
  running="$(running_sha)"
  http="$(curl -s -o /dev/null -w '%{http_code}' "$(status_url)" || true)"
  echo "home:      $AGENTFORGE_HOME"
  echo "current:   $(current_sha)"
  echo "running:   ${running:-no}"
  echo "endpoint:  $(status_url) -> ${http:-000}"
  echo "socket:    $AGENTFORGE_DOCKER_SOCKET (reserved)"
  echo "state dir: $AGENTFORGE_STATE_DIR (reserved)"
}

cmd_upgrade() {
  local sha
  sha="$(cmd_install "${1:?upgrade needs a ref}")"
  if [[ "$(running_sha)" == "$sha" ]]; then
    log "already running $sha; nothing to restart"
    return
  fi
  cmd_stop
  cmd_start
}

case "${1:-}" in
  install) cmd_install "${2:-}" ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  upgrade) cmd_upgrade "${2:-}" ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
