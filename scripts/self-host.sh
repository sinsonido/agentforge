#!/usr/bin/env bash
# Run AgentForge from an immutable release directory, never from a working tree.
#
# Layout under $AGENTFORGE_HOME:
#   repo.git/           bare clone used as the export source
#   releases/<sha>/     complete release (its existence means "installed")
#   current             symlink to the active release
#   data/               SQLite database (container working directory)
#   config/             agentforge.yml, created once from the example;
#                       gh-token, the instance's own GitHub token (mode 600)
#   state/              executor state: mirrors, per-task clones and HOMEs
#   tools/              gh release binary for the container
set -euo pipefail

AGENTFORGE_HOME="${AGENTFORGE_HOME:-$HOME/.agentforge-self}"
AGENTFORGE_REPO_URL="${AGENTFORGE_REPO_URL:-https://github.com/sinsonido/agentforge.git}"
AGENTFORGE_NODE_IMAGE="${AGENTFORGE_NODE_IMAGE:-node:24}"
AGENTFORGE_CONTAINER="${AGENTFORGE_CONTAINER:-agentforge-self}"
AGENTFORGE_BIND="${AGENTFORGE_BIND:-127.0.0.1}"
AGENTFORGE_PORT="${AGENTFORGE_PORT:-4343}"
# What the coding executor needs. See docs/self-hosting.md, "Executor mounts".
AGENTFORGE_DOCKER_SOCKET="${AGENTFORGE_DOCKER_SOCKET:-/var/run/docker.sock}"
AGENTFORGE_STATE_DIR="${AGENTFORGE_STATE_DIR:-$AGENTFORGE_HOME/state}"
AGENTFORGE_CLAUDE_BIN="${AGENTFORGE_CLAUDE_BIN:-$(readlink -f "$HOME/.local/bin/claude" 2>/dev/null || true)}"
AGENTFORGE_PSTACK_DIR="${AGENTFORGE_PSTACK_DIR:-$HOME/.claude/plugins/cache/cursor-plugins/pstack/0.15.30}"
AGENTFORGE_CLAUDE_CREDENTIALS="${AGENTFORGE_CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
AGENTFORGE_GH_VERSION="${AGENTFORGE_GH_VERSION:-2.62.0}"

REPO="$AGENTFORGE_HOME/repo.git"
RELEASES="$AGENTFORGE_HOME/releases"
CURRENT="$AGENTFORGE_HOME/current"
DATA_DIR="$AGENTFORGE_HOME/data"
CONFIG_DIR="$AGENTFORGE_HOME/config"
TOOLS_DIR="$AGENTFORGE_HOME/tools"
GH_TOKEN_FILE="$CONFIG_DIR/gh-token"
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
  AGENTFORGE_DOCKER_SOCKET      $AGENTFORGE_DOCKER_SOCKET
  AGENTFORGE_STATE_DIR          $AGENTFORGE_STATE_DIR
  AGENTFORGE_CLAUDE_BIN         $AGENTFORGE_CLAUDE_BIN
  AGENTFORGE_PSTACK_DIR         $AGENTFORGE_PSTACK_DIR
  AGENTFORGE_CLAUDE_CREDENTIALS $AGENTFORGE_CLAUDE_CREDENTIALS
  AGENTFORGE_GH_VERSION         $AGENTFORGE_GH_VERSION
  CLAUDE_CODE_OAUTH_TOKEN       (optional; preferred over the credentials file)
  AGENTFORGE_GH_TOKEN           the instance's GitHub token; else the file
                                $GH_TOKEN_FILE (mode 600)
  AGENTFORGE_ALLOW_OPERATOR_TOKEN=1  use 'gh auth token' instead (not recommended)
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
    cat <<'YAML'

# Added by scripts/self-host.sh on first run. The ${...} values come from
# the container environment that `self-host.sh start` sets.
database:
  path: /data/agentforge.db

executor:
  image: node:24
  state_dir: ${AGENTFORGE_STATE_DIR}
  pstack_dir: ${AGENTFORGE_PSTACK_DIR}
  claude_bin: ${AGENTFORGE_CLAUDE_BIN}
  credentials_file: ${AGENTFORGE_CLAUDE_CREDENTIALS}
  oauth_token: ${CLAUDE_CODE_OAUTH_TOKEN}
  model: sonnet
  effort: medium
  budget_usd: 2.00
  timeout_minutes: 30
  concurrency: 1
YAML
  } > "$config.tmp"
  mv "$config.tmp" "$config"
  log "created $config"
}

gh_arch() {
  case "$(uname -m)" in
    x86_64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "no gh release for $(uname -m)" ;;
  esac
}

# A host gh is often linked against the host's loader, so the container gets
# the static release binary instead.
ensure_gh() {
  local dir="$TOOLS_DIR/gh-$AGENTFORGE_GH_VERSION" name
  if [[ ! -x "$dir/gh" ]]; then
    name="gh_${AGENTFORGE_GH_VERSION}_linux_$(gh_arch)"
    log "downloading gh $AGENTFORGE_GH_VERSION"
    rm -rf "$dir.partial"
    mkdir -p "$dir.partial"
    curl -fsSL "https://github.com/cli/cli/releases/download/v$AGENTFORGE_GH_VERSION/$name.tar.gz" \
      | tar -xz -C "$dir.partial" --strip-components=2 "$name/bin/gh"
    mv -T "$dir.partial" "$dir"
  fi
  echo "$dir/gh"
}

check_executor_inputs() {
  [[ -S "$AGENTFORGE_DOCKER_SOCKET" ]] || die "no Docker socket at $AGENTFORGE_DOCKER_SOCKET"
  [[ -x "$AGENTFORGE_CLAUDE_BIN" ]] || die "no claude binary at '$AGENTFORGE_CLAUDE_BIN'; set AGENTFORGE_CLAUDE_BIN"
  [[ -d "$AGENTFORGE_PSTACK_DIR/skills/poteto-mode" ]] || die "no pstack at $AGENTFORGE_PSTACK_DIR; set AGENTFORGE_PSTACK_DIR"
  [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" || -f "$AGENTFORGE_CLAUDE_CREDENTIALS" ]] \
    || die "no harness credentials: set CLAUDE_CODE_OAUTH_TOKEN or AGENTFORGE_CLAUDE_CREDENTIALS"
}

# The repos under intake.repos, one per line, read by the release's own config loader.
intake_repos() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$RELEASES/$1":/app:ro -v "$CONFIG_DIR":/config:ro -w /app "$AGENTFORGE_NODE_IMAGE" \
    node --input-type=module -e '
      const { loadConfig } = await import("/app/src/config/loader.js");
      for (const { repo } of loadConfig("/config/agentforge.yml").intake.repos) console.log(repo);'
}

token_steps() {
  local repos="${1:-<owner>/<repo>}"
  cat >&2 <<EOF

AgentForge needs its own GitHub token, limited to the intake repos.
It does not use your 'gh auth token', which can do anything your account can.

Create a fine-grained personal access token:
  1. Open https://github.com/settings/personal-access-tokens/new
  2. Token name: agentforge-self. Pick an expiration.
  3. Resource owner: the owner of the intake repos.
  4. Repository access: Only select repositories, then pick:
$(sed 's/^/       /' <<<"$repos")
  5. Repository permissions:
       Contents       Read and write
       Issues         Read and write
       Pull requests  Read and write
       Metadata       Read-only (GitHub adds it)
     Leave every other permission at No access.
  6. Generate the token and copy it.

Store it in a file only you can read, then start again:
  ( umask 077; cat > $GH_TOKEN_FILE )    # paste the token, Enter, Ctrl-D
  $0 start
Or set AGENTFORGE_GH_TOKEN in the environment of 'start'.

Last resort: AGENTFORGE_ALLOW_OPERATOR_TOKEN=1 uses your own 'gh auth token'.
EOF
}

# Set GH_TOKEN_VALUE from AGENTFORGE_GH_TOKEN, then the token file, then, only
# when the operator opts in, the host's gh login.
resolve_gh_token() {
  local repos="$1" mode
  if [[ -n "${AGENTFORGE_GH_TOKEN:-}" ]]; then
    GH_TOKEN_VALUE="$AGENTFORGE_GH_TOKEN"
    log "GitHub token: AGENTFORGE_GH_TOKEN"
  elif [[ -f "$GH_TOKEN_FILE" ]]; then
    mode="$(stat -c %a "$GH_TOKEN_FILE")"
    (( (8#$mode & 8#077) == 0 )) || die "$GH_TOKEN_FILE has mode $mode; run: chmod 600 $GH_TOKEN_FILE"
    GH_TOKEN_VALUE="$(tr -d '[:space:]' < "$GH_TOKEN_FILE")"
    [[ -n "$GH_TOKEN_VALUE" ]] || die "$GH_TOKEN_FILE is empty"
    log "GitHub token: $GH_TOKEN_FILE"
  elif [[ "${AGENTFORGE_ALLOW_OPERATOR_TOKEN:-}" == 1 ]]; then
    command -v gh >/dev/null || die "AGENTFORGE_ALLOW_OPERATOR_TOKEN=1 needs gh on the host"
    GH_TOKEN_VALUE="$(gh auth token)"
    log "WARNING: ******************************************************************"
    log "WARNING: AGENTFORGE_ALLOW_OPERATOR_TOKEN=1: the instance gets YOUR gh token."
    log "WARNING: It can do anything your account can, delete_repo included, and"
    log "WARNING: agent PRs will look authored by you. Create a scoped token instead."
    log "WARNING: ******************************************************************"
  else
    log "error: no GitHub token for the instance"
    token_steps "$repos"
    exit 1
  fi
}

# Show who the token is and check that it reaches every intake repo.
probe_gh_token() {
  local gh_bin="$1" repos="$2" out repo missing=()
  out="$(GH_TOKEN="$GH_TOKEN_VALUE" "$gh_bin" api /user --jq .login 2>&1)" \
    || die "the GitHub token does not authenticate: ${out##*gh: }"
  case "$GH_TOKEN_VALUE" in
    github_pat_*) log "GitHub token: fine-grained, acts as $out" ;;
    *) log "WARNING: GitHub token is not fine-grained; it acts as $out with scopes:" \
         "$(GH_TOKEN="$GH_TOKEN_VALUE" "$gh_bin" api -i /user 2>/dev/null | sed -n 's/^X-Oauth-Scopes: *//Ip' | tr -d '\r')" ;;
  esac
  [[ -n "$repos" ]] || log "WARNING: no intake.repos in $CONFIG_DIR/agentforge.yml; the coding loop is off"
  for repo in $repos; do
    if out="$(GH_TOKEN="$GH_TOKEN_VALUE" "$gh_bin" api "repos/$repo" --jq .full_name 2>&1)"; then
      log "  reaches $repo"
    else
      log "  cannot reach $repo: ${out##*gh: }"
      missing+=("$repo")
    fi
  done
  (( ${#missing[@]} == 0 )) || die "the GitHub token cannot reach ${missing[*]}." \
    "Add them to the token's Repository access, or fix intake.repos in $CONFIG_DIR/agentforge.yml"
}

# Everything start checks before it touches a running container, so a missing
# input never takes the instance down. Sets GH_BIN and GH_TOKEN_VALUE.
preflight() {
  local sha="$1" repos
  check_executor_inputs
  GH_BIN="$(ensure_gh)"
  mkdir -p "$DATA_DIR" "$AGENTFORGE_STATE_DIR"
  ensure_config
  repos="$(intake_repos "$sha")"
  resolve_gh_token "$repos"
  probe_gh_token "$GH_BIN" "$repos"
}

launch() {
  local sha="$1" creds=()
  if [[ -f "$AGENTFORGE_CLAUDE_CREDENTIALS" ]]; then
    creds=(-v "$AGENTFORGE_CLAUDE_CREDENTIALS:$AGENTFORGE_CLAUDE_CREDENTIALS:ro")
  fi
  docker rm -f "$AGENTFORGE_CONTAINER" >/dev/null 2>&1 || true
  # Secrets go by name (-e VAR), so they never appear in the host process list.
  GH_TOKEN="$GH_TOKEN_VALUE" CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" \
  docker run -d --name "$AGENTFORGE_CONTAINER" --init --stop-signal SIGINT \
    --restart unless-stopped --label "agentforge.sha=$sha" \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    --group-add "$(stat -c %g "$AGENTFORGE_DOCKER_SOCKET")" \
    -e GH_TOKEN -e CLAUDE_CODE_OAUTH_TOKEN \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=credential.https://github.com.helper \
    -e 'GIT_CONFIG_VALUE_0=!gh auth git-credential' \
    -e AGENTFORGE_STATE_DIR="$AGENTFORGE_STATE_DIR" -e AGENTFORGE_PSTACK_DIR="$AGENTFORGE_PSTACK_DIR" \
    -e AGENTFORGE_CLAUDE_BIN="$AGENTFORGE_CLAUDE_BIN" -e AGENTFORGE_CLAUDE_CREDENTIALS="$AGENTFORGE_CLAUDE_CREDENTIALS" \
    -p "$AGENTFORGE_BIND:$AGENTFORGE_PORT:$CONTAINER_PORT" \
    -v "$RELEASES/$sha":/app:ro -v "$DATA_DIR":/data -v "$CONFIG_DIR":/config:ro \
    -v "$AGENTFORGE_DOCKER_SOCKET":/var/run/docker.sock \
    -v "$(command -v docker)":/usr/local/bin/docker:ro \
    -v "$GH_BIN":/usr/local/bin/gh:ro \
    -v "$AGENTFORGE_STATE_DIR:$AGENTFORGE_STATE_DIR" \
    -v "$AGENTFORGE_CLAUDE_BIN:$AGENTFORGE_CLAUDE_BIN:ro" \
    -v "$AGENTFORGE_PSTACK_DIR:$AGENTFORGE_PSTACK_DIR:ro" \
    "${creds[@]}" \
    -w /data "$AGENTFORGE_NODE_IMAGE" \
    node /app/src/cli.js --config /config/agentforge.yml start --host 0.0.0.0 --port "$CONTAINER_PORT" >/dev/null
  curl -sf -o /dev/null --retry 30 --retry-delay 1 --retry-connrefused --retry-all-errors \
    "$(status_url)" || die "no answer from $(status_url); see: docker logs $AGENTFORGE_CONTAINER"
  log "started $sha on http://$AGENTFORGE_BIND:$AGENTFORGE_PORT"
}

cmd_start() {
  local sha
  sha="$(current_sha)"
  [[ -n "$sha" ]] || die "nothing installed; run: $0 install <ref>"
  if [[ "$(running_sha)" == "$sha" ]]; then
    log "already running $sha"
    return
  fi
  preflight "$sha"
  launch "$sha"
}

# The instance cancels its running tasks on SIGINT: each task container gets
# 'docker stop -t 10', and the orchestrator waits up to 20s for them. The 30s
# here outlasts both. Any af-task-* container still running after that is stopped.
cmd_stop() {
  local leftover=()
  if docker inspect "$AGENTFORGE_CONTAINER" >/dev/null 2>&1; then
    docker stop -t 30 "$AGENTFORGE_CONTAINER" >/dev/null
    docker rm "$AGENTFORGE_CONTAINER" >/dev/null
    log "stopped $AGENTFORGE_CONTAINER"
  else
    log "not running"
  fi
  mapfile -t leftover < <(docker ps --format '{{.Names}}' --filter 'name=^af-task-')
  if (( ${#leftover[@]} )); then
    docker stop -t 10 "${leftover[@]}" >/dev/null
    log "stopped leftover task containers: ${leftover[*]}"
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
  echo "socket:    $AGENTFORGE_DOCKER_SOCKET"
  echo "state dir: $AGENTFORGE_STATE_DIR"
  echo "claude:    $AGENTFORGE_CLAUDE_BIN"
  echo "pstack:    $AGENTFORGE_PSTACK_DIR"
  if [[ -n "${AGENTFORGE_GH_TOKEN:-}" ]]; then echo "gh token:  AGENTFORGE_GH_TOKEN"
  elif [[ -f "$GH_TOKEN_FILE" ]]; then echo "gh token:  $GH_TOKEN_FILE"
  else echo "gh token:  missing (start prints how to create one)"
  fi
}

cmd_upgrade() {
  local sha
  sha="$(cmd_install "${1:?upgrade needs a ref}")"
  if [[ "$(running_sha)" == "$sha" ]]; then
    log "already running $sha; nothing to restart"
    return
  fi
  preflight "$sha"
  cmd_stop
  launch "$sha"
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
