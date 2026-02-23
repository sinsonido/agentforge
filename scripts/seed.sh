#!/usr/bin/env bash
# AgentForge seed script — puebla el servidor con datos de prueba
# Usage: ./scripts/seed.sh [--port PORT] [--watch] [--reset]
set -euo pipefail

PORT=4242
WATCH=false
RESET=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --port|-p)  PORT="$2"; shift 2 ;;
    --watch|-w) WATCH=true; shift ;;
    --reset|-r) RESET=true; shift ;;
    --help|-h)
      cat <<EOF
Usage: $(basename "$0") [options]

Options:
  -p, --port PORT   Server port (default: 4242)
  -w, --watch       Keep emitting events every few seconds (live feed demo)
  -r, --reset       Truncate all tasks before seeding (requires SQLite access)
  -h, --help        Show this help
EOF
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

BASE="http://localhost:$PORT/api"

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

ok() { echo "  ✓ $*"; }
info() { echo ""; echo "▸ $*"; }

# POST wrapper — returns the task id from the response
post_task() {
  local body="$1"
  curl -sf -X POST "$BASE/tasks" \
    -H "Content-Type: application/json" \
    -d "$body" | node -e "
      const d=require('fs').readFileSync('/dev/stdin','utf8');
      try { const r=JSON.parse(d); process.stdout.write(r.task?.id ?? ''); } catch {}
    "
  sleep 0.8   # respeta el límite de 30 POST/min del servidor
}

# PATCH task status
set_status() {
  local id="$1" status="$2"
  curl -sf -X POST "$BASE/tasks/$id/status" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"$status\"}" >/dev/null || true
  sleep 0.8
}

# Emit a review event
review_event() {
  local pr="$1" action="$2" reason="${3:-}"
  if [[ "$action" == "approve" ]]; then
    curl -s -X POST "$BASE/review/$pr/approve" \
      -H "Content-Type: application/json" >/dev/null || true
  else
    curl -s -X POST "$BASE/review/$pr/reject" \
      -H "Content-Type: application/json" \
      -d "{\"reason\":\"$reason\"}" >/dev/null || true
  fi
  sleep 0.8
}

# ------------------------------------------------------------------
# Checks
# ------------------------------------------------------------------

if ! curl -sf "$BASE/status" >/dev/null 2>&1; then
  echo "Error: no hay servidor en localhost:$PORT" >&2
  echo "Arranca primero: bash scripts/start.sh  o  agentforge start" >&2
  exit 1
fi
echo "Servidor OK en localhost:$PORT"

# ------------------------------------------------------------------
# Reset (trunca la DB directamente)
# ------------------------------------------------------------------

if $RESET; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  DB="$SCRIPT_DIR/../agentforge.sqlite"
  if [[ -f "$DB" ]]; then
    node -e "
      import('better-sqlite3').then(({default:DB})=>{
        const db=new DB('$DB');
        db.prepare('DELETE FROM tasks').run();
        console.log('  ✓ tasks truncated');
        db.close();
      });
    "
  else
    echo "  (no hay DB aún, nada que borrar)"
  fi
fi

# ------------------------------------------------------------------
# Tareas: queued (se quedan en cola)
# ------------------------------------------------------------------

info "Creando tareas en cola..."
sleep 0.3

QUEUED_IDS=()
tasks_queued=(
  '{"title":"Implement OAuth2 login flow","type":"feature","priority":"high","agent_id":"architect"}'
  '{"title":"Add rate limiting to REST API","type":"feature","priority":"medium","agent_id":"backend"}'
  '{"title":"Write unit tests for task queue","type":"test","priority":"medium","agent_id":"qa"}'
  '{"title":"Refactor cost tracker module","type":"refactor","priority":"low","agent_id":"backend"}'
  '{"title":"Document WebSocket events","type":"research","priority":"low"}'
)

for body in "${tasks_queued[@]}"; do
  id="$(post_task "$body")"
  QUEUED_IDS+=("$id")
  ok "queued → $id"
done

# ------------------------------------------------------------------
# Tareas: executing
# ------------------------------------------------------------------

info "Creando tareas en ejecución..."
sleep 0.3

EXEC_IDS=()
tasks_exec=(
  '{"title":"Generate API documentation","type":"research","priority":"high","agent_id":"architect"}'
  '{"title":"Fix memory leak in event bus","type":"bug","priority":"critical","agent_id":"backend"}'
  '{"title":"Setup CI/CD pipeline","type":"feature","priority":"high","agent_id":"devops"}'
)

for body in "${tasks_exec[@]}"; do
  id="$(post_task "$body")"
  set_status "$id" "executing"
  EXEC_IDS+=("$id")
  ok "executing → $id"
done

# ------------------------------------------------------------------
# Tareas: completed
# ------------------------------------------------------------------

info "Creando tareas completadas..."
sleep 0.3

tasks_done=(
  '{"title":"Design database schema","type":"research","priority":"high","agent_id":"architect"}'
  '{"title":"Add Helmet.js security headers","type":"feature","priority":"high","agent_id":"backend"}'
  '{"title":"Create Docker Compose setup","type":"feature","priority":"medium","agent_id":"devops"}'
  '{"title":"Implement SQLite persistence layer","type":"feature","priority":"high","agent_id":"backend"}'
)

for body in "${tasks_done[@]}"; do
  id="$(post_task "$body")"
  set_status "$id" "executing"
  set_status "$id" "completed"
  ok "completed → $id"
done

# ------------------------------------------------------------------
# Tareas: failed
# ------------------------------------------------------------------

info "Creando tareas fallidas..."
sleep 0.3

tasks_failed=(
  '{"title":"Integrate external LLM provider X","type":"feature","priority":"medium","agent_id":"backend"}'
  '{"title":"Auto-scale agent pool","type":"feature","priority":"low","agent_id":"devops"}'
)

for body in "${tasks_failed[@]}"; do
  id="$(post_task "$body")"
  set_status "$id" "executing"
  set_status "$id" "failed"
  ok "failed → $id"
done

# ------------------------------------------------------------------
# Eventos de review (PR)
# ------------------------------------------------------------------

info "Emitiendo eventos de review..."
sleep 0.3

review_event 42 "approve"
ok "review.approved  → PR #42"
sleep 0.3
review_event 41 "reject" "Tests are failing in the CI pipeline"
ok "review.rejected  → PR #41"

# ------------------------------------------------------------------
# Resumen
# ------------------------------------------------------------------

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Seed completado. Abre: http://localhost:$PORT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ------------------------------------------------------------------
# Watch mode: sigue emitiendo eventos para animar el feed en tiempo real
# ------------------------------------------------------------------

if $WATCH; then
  echo "Modo watch activo (Ctrl+C para parar)..."
  echo ""

  WATCH_TASKS=(
    '{"title":"Watch: deploy to staging","type":"feature","priority":"medium","agent_id":"devops"}'
    '{"title":"Watch: analyze performance bottlenecks","type":"research","priority":"high","agent_id":"architect"}'
    '{"title":"Watch: patch XSS vulnerability","type":"bug","priority":"critical","agent_id":"security"}'
    '{"title":"Watch: generate weekly report","type":"research","priority":"low","agent_id":"analyst"}'
    '{"title":"Watch: refactor router module","type":"refactor","priority":"medium","agent_id":"backend"}'
  )
  idx=0

  while true; do
    body="${WATCH_TASKS[$((idx % ${#WATCH_TASKS[@]}))]}"
    id="$(post_task "$body")"
    echo "  + queued    $id"
    sleep 2

    set_status "$id" "executing"
    echo "  ~ executing $id"
    sleep 3

    # Alterna entre completed y failed
    if (( idx % 3 == 2 )); then
      set_status "$id" "failed"
      echo "  ✗ failed    $id"
    else
      set_status "$id" "completed"
      echo "  ✓ completed $id"
    fi

    sleep 4
    idx=$((idx + 1))
  done
fi
