# Deployment

The backend is one long-lived Node.js service (HTTP + WebSockets) plus managed
PostgreSQL and S3-compatible object storage. Nothing is stored on the service's local disk,
so the container can be replaced at any time.

## Primary: Vultr

| Piece | Vultr product | Notes |
|---|---|---|
| API (HTTPS + WSS) | Cloud Compute VM (Ubuntu 24.04, 1-2 vCPU / 2 GB is plenty for the demo) running Docker; Caddy terminates TLS | `deploy/vultr/` |
| Database | Managed Database for PostgreSQL (16+) | TLS required (`DATABASE_SSL=true`) |
| Storage | Object Storage (S3-compatible) | private bucket; signed URLs |

A VM has no idle timeout on WebSockets (unlike many platform proxies), and Caddy proxies
WebSocket upgrades automatically.

### Steps

1. **Database:** create a Managed PostgreSQL cluster in the same region as the VM. Add the
   VM to its *Trusted Sources*. Copy the connection string into `DATABASE_URL`.
2. **Object storage:** create an Object Storage subscription and a bucket (or let the app
   create it with `S3_CREATE_BUCKET=true`). Copy hostname, access key and secret key into
   `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` (`https://<region>.vultrobjects.com`), `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`. Keep the bucket private (default).
3. **VM:** create the instance, install Docker (`curl -fsSL https://get.docker.com | sh`),
   open ports 80 and 443 in the Vultr firewall group (SSH 22 only from your IP).
4. **DNS:** point `api.example.com` (A/AAAA) at the VM's IP.
5. **Configure:**
   ```bash
   git clone <repo> && cd <repo>/backend/deploy/vultr
   cp .env.production.example .env.production   # fill in every CHANGE_ME
   echo "API_DOMAIN=api.example.com" > .env       # read by docker compose for Caddy
   ```
   Secrets to set: `DATABASE_URL`, `S3_*`, `GEMINI_API_KEY`, and (only with donations)
   `SOLANA_WALLET_ENCRYPTION_KEY`. `PUBLIC_API_URL=https://api.example.com`,
   `PUBLIC_WEB_URL` / `VIEWER_BASE_URL` = the website origin, `CORS_ORIGINS` = the website
   origin(s), `TRUST_PROXY=true`.
6. **Start:** `docker compose up -d --build`. Caddy obtains the certificate on first request.
   Migrations run at startup (`MIGRATE_ON_START=true`, serialized with an advisory lock). To run
   them separately: `docker compose run --rm api node dist/src/db/migrate.js` and set
   `MIGRATE_ON_START=false`.
7. **Bucket CORS** (for browsers loading textures from signed URLs):
   `docker compose run --rm api node dist/scripts/storage-cors.js`.
8. **Verify:** `curl https://api.example.com/ready` -> `{"status":"ready","checks":{"database":"ok","storage":"ok"}}`,
   then `npm run demo:simulate -- --base https://api.example.com` from your machine.
9. **Assistant check:** `docker compose run --rm api node dist/scripts/smoke-gemini.js`
   (writes `reports/gemini-smoke.json` inside the container; mount a volume at `/app/reports`
   if you want `/v1/capabilities` to show the results after restarts).
10. **Demo data (optional, not for real users):** `docker compose run --rm -e NODE_ENV=development api node dist/scripts/seed-demo.js`
    prints random demo passwords once.

Updates: `git pull && docker compose up -d --build`. Shutdown is graceful (SIGTERM closes
WebSockets with 1001 so clients reconnect).

## Alternative: Render

`render.yaml` defines a Docker web service (single instance) and a managed PostgreSQL
database. Render supports WebSockets on web services and terminates HTTPS/WSS. Its local
filesystem is ephemeral, so object storage must be external (Vultr Object Storage, R2, S3).
Set the `sync: false` variables in the dashboard. Health check: `/ready`.

## Configuration reference

All variables are documented in `.env.example`. Production essentials:

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `DATABASE_SSL` | PostgreSQL (managed, TLS) |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | private object storage; the public endpoint is used for signed URLs |
| `PUBLIC_API_URL` | builds `wss://` ticket URLs |
| `PUBLIC_WEB_URL`, `VIEWER_BASE_URL` | editor/invitation/join links; mobile-browser viewer links in QR codes (HTTPS needed for phone motion sensors) |
| `CORS_ORIGINS` | website origins (comma-separated); never `*` in production |
| `TRUST_PROXY=true` | behind Caddy/Render so client IPs and HTTPS are correct |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_TTS_MODEL` | assistant |
| `SOLANA_*` | donations (optional, see docs/donations.md) |
| `LIMIT_*`, `ASSISTANT_*` | demo limits: starting assumptions, not measured capacity |

## Operations notes

- **Readiness** `/ready` checks the database and the bucket; **liveness** `/health`.
- **Logs** are JSON (pino) with request IDs; `Authorization` headers and WebSocket tickets
  are redacted.
- **Backups:** enable automated backups on the managed database. Object storage holds
  originals and variants (re-creatable only from originals).
- **Scaling:** run exactly one API instance. Real-time fan-out, rate limits and the assistant
  queue are in-process. Horizontal scaling needs a shared broadcast channel (PostgreSQL
  `LISTEN/NOTIFY` or Redis) and shared rate limiting; data correctness does not depend on it,
  since every client resyncs from the database.
- **Capacity:** the defaults (5 editors, 10 viewers per gallery) are demo assumptions. The
  measured numbers in `docs/implementation-report.md` come from a single machine.
