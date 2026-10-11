#!/usr/bin/env bash
# My World: one command to set up the backend (Docker), start both servers, and check that they agree.
#   cd HackathonProject && bash run-everything.sh
# Stop everything later with:  bash run-everything.sh stop
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACK="${BACKEND_DIR:-$HERE/../backend}"
LOG="$HERE/.run"; mkdir -p "$LOG"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*"; exit 1; }

if [ "${1:-}" = "stop" ]; then
  for f in backend web; do [ -f "$LOG/$f.pid" ] && kill "$(cat "$LOG/$f.pid")" 2>/dev/null && echo "stopped $f"; rm -f "$LOG/$f.pid"; done
  (cd "$BACK" && docker compose stop db s3 >/dev/null 2>&1 && echo "stopped database and storage")
  exit 0
fi

command -v node   >/dev/null || die "Node 22+ is needed. Install it from https://nodejs.org and run this again."
command -v docker >/dev/null || die "Docker is needed for the database and picture storage. Install Docker Desktop, open it, and run this again."
docker info >/dev/null 2>&1  || die "Docker is installed but not running. Open Docker Desktop, wait until it says it's running, then run this again."
[ -f "$BACK/package.json" ]   || die "Can't find the backend at $BACK. Run: BACKEND_DIR=/path/to/backend bash run-everything.sh"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); [ "$NODE_MAJOR" -ge 22 ] || die "Node $NODE_MAJOR is too old; the backend needs 22.12 or newer."

say "1/6  Database and picture storage"
(cd "$BACK" && docker compose up -d db s3) || die "docker compose failed (see the message above)."
printf "     waiting for the database"; for i in $(seq 1 40); do (cd "$BACK" && docker compose exec -T db pg_isready -U gallery -d gallery >/dev/null 2>&1) && break; printf .; sleep 2; done; echo

say "2/6  Backend settings"
[ -f "$BACK/.env" ] || { cp "$BACK/.env.example" "$BACK/.env"; echo "     created backend/.env from .env.example"; }
# no Gemini key? use the built-in test assistant so the Assistant tab still works while you try things out
if ! grep -Eq '^GEMINI_API_KEY=.+' "$BACK/.env" && ! grep -Eq '^ASSISTANT_PROVIDER=.+' "$BACK/.env"; then
  sed -i.bak 's/^ASSISTANT_PROVIDER=.*/ASSISTANT_PROVIDER=fake/' "$BACK/.env" && rm -f "$BACK/.env.bak"; echo "     no GEMINI_API_KEY: using the test assistant (ASSISTANT_PROVIDER=fake)"
fi

say "3/6  Backend packages, database tables, storage"
(cd "$BACK" && { [ -d node_modules ] || npm ci; } && npm run migrate && npm run storage:cors) || die "Backend setup failed (see above). If it's the storage step, wait 10 seconds and run this again."

say "4/6  Starting the backend on :8080"
[ -f "$LOG/backend.pid" ] && kill "$(cat "$LOG/backend.pid")" 2>/dev/null
(cd "$BACK" && nohup npm run dev > "$LOG/backend.log" 2>&1 & echo $! > "$LOG/backend.pid")
printf "     waiting"; UP=0; for i in $(seq 1 40); do curl -fsS -m 2 http://localhost:8080/health >/dev/null 2>&1 && { UP=1; break; }; printf .; sleep 1; done; echo
[ $UP = 1 ] || { tail -25 "$LOG/backend.log"; die "The backend didn't start. The last lines of its log are above (full log: $LOG/backend.log)."; }

say "5/6  Starting My World on :5173"
[ -f "$LOG/web.pid" ] && kill "$(cat "$LOG/web.pid")" 2>/dev/null
(cd "$HERE" && nohup node serve.mjs > "$LOG/web.log" 2>&1 & echo $! > "$LOG/web.pid"); sleep 1
curl -fsS -m 3 http://localhost:5173/__info >/dev/null || { cat "$LOG/web.log"; die "The web server didn't start."; }

say "6/6  Checking that the backend and My World agree"
(cd "$HERE" && node tools/verify-backend.mjs http://localhost:8080); R=$?
echo
if [ $R = 0 ]; then say "All good. Open http://localhost:5173  (World → Cloud → create an account)"
else say "Some checks failed (listed above). Everything is still running, so you can look around. Send me the FAIL lines."; fi
echo "Logs: $LOG/backend.log and $LOG/web.log      Stop everything: bash run-everything.sh stop"
