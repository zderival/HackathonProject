# Virtual Gallery Backend

Backend for a collaborative 3D art gallery: a website editor (PowerPoint-like editing,
artwork uploads, multilingual Gemini assistant) and a phone VR viewer that opens in the mobile browser from a QR code and follows edits
live. TypeScript, Node.js 24 LTS, Fastify, PostgreSQL, WebSockets, S3-compatible storage.

## Quick start (local)

Requirements: Node.js >= 22.12 (24 LTS recommended), Docker.

```bash
docker compose up -d db s3        # PostgreSQL on :5433, S3 (SeaweedFS) on :8333
cp .env.example .env              # add GEMINI_API_KEY to enable the assistant
npm ci
npm run migrate
npm run storage:cors
npm run seed:demo                 # optional: demo accounts + furnished gallery (prints a random password)
npm run dev                       # http://localhost:8080  (OpenAPI: /openapi.json)
```

Everything in Docker: `docker compose --profile full up -d --build` (set `API_PORT=8090`
if `npm run dev` already uses 8080).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | develop / compile / run compiled |
| `npm test` | 75 integration tests (needs `docker compose up -d db s3`; uses the `gallery_test` database) |
| `npm run typecheck` | TypeScript check |
| `npm run migrate` (`migrate:prod` when compiled) | apply SQL migrations |
| `npm run seed:demo` | demo/dev data (refused in production) |
| `npm run export:contracts` | regenerate `contracts/` (OpenAPI, JSON Schemas, TS types) |
| `npm run smoke:gemini [ht ko ...]` | LIVE Gemini check per language (needs a key) |
| `npm run demo:simulate -- --base <url>` | scripted end-to-end demo with simulated clients + latency report |
| `npm run storage:cors` | allow browsers to load signed asset URLs |
| `npm run solana:keygen` | generate `SOLANA_WALLET_ENCRYPTION_KEY` (donations) |

## Documentation

| Doc | Contents |
|---|---|
| [docs/scene-model.md](docs/scene-model.md) | Scene schema, coordinate conventions, Unity/three.js/SceneKit conversion, operations |
| [docs/api-guide.md](docs/api-guide.md) | Auth, errors, idempotency and conflicts, undo, permissions precedence, links/QR/mobile-browser viewer flow, assets |
| [docs/websocket-protocol.md](docs/websocket-protocol.md) | Real-time protocol: tickets, ordering, gaps, reconnect, close codes, throttling |
| [docs/assistant.md](docs/assistant.md) | Gemini assistant: async commands, voice, speech, safety, languages, verification |
| [docs/donations.md](docs/donations.md) | Optional Solana donations (custodial gallery wallets) |
| [docs/integration-examples.md](docs/integration-examples.md) | Website editor and mobile-browser VR viewer examples (TypeScript) |
| [docs/deployment.md](docs/deployment.md) | Vultr (primary) and Render deployment, configuration, operations |
| [docs/demo-runbook.md](docs/demo-runbook.md) | Demo preparation and script |
| [docs/implementation-report.md](docs/implementation-report.md) | What is verified, measured latency, what is not, limits |
| `contracts/` | `openapi.json`, `schemas/*.schema.json`, `types/gallery-api.d.ts` |

## Status

Core editing, collaboration, permissions/QR, uploads, real-time sync, undo/redo, the
assistant pipeline and donations are implemented and covered by tests. The live Gemini
smoke test passed for text, voice input (synthesized speech) and spoken replies in all five
languages on 2026-10-10; see the implementation report for everything verified and the
remaining limits.
