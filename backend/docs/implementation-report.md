# Implementation report

Status as of 2026-10-10. This separates what is implemented and verified from what is
implemented but not yet verified live, and from what is out of scope or missing.

## Approach

One TypeScript service (Node.js 24 LTS, Fastify 5) with PostgreSQL (relational tables for
identity, membership, sessions, history, assets, assistant and donations; JSONB for the
validated scene) and private S3-compatible storage. TypeBox schemas are the single source
of truth for request validation, the scene/operation model, OpenAPI and the exported JSON
Schemas/TypeScript types. Every scene change, manual or AI, undo or redo, goes through
one transactional pipeline (`src/actions/service.ts`). Real-time fan-out is in-process over
WebSockets for a single instance. No microservices, queues, CRDTs or vector databases.

```
src/
  actions/       edit pipeline: atomic batches, idempotency, conflicts, history, undo/redo
  assets/        uploads (sharp), variants, signed URLs, storage adapter
  assistant/     Gemini adapter, prompt/context, voice validation, async command queue
  auth/          accounts, opaque rotating tokens
  capabilities/  capabilities + schema endpoints
  donations/     Solana custodial wallets, on-chain verification, withdrawals
  galleries/     gallery CRUD, access resolution (roles, links, precedence)
  realtime/      WebSocket hub (ordering, gap replay, back-pressure), protocol schemas
  scene/         pure scene engine: compile ops -> invertible changes, validation, math
  schemas/       TypeBox: scene, operations, API envelopes, field descriptors
  sharing/       members, invitations, sharing modes, links, QR, pairing, viewer sessions
migrations/      001 core, 002 sharing+assistant, 003 donations
scripts/         seed-demo, export-contracts, smoke-gemini, demo-simulate, storage-cors
test/            75 integration/unit tests against real PostgreSQL + S3 (SeaweedFS)
contracts/       generated: openapi.json, JSON Schemas, types/gallery-api.d.ts
deploy/vultr/    Docker Compose + Caddy (HTTPS/WSS) for a Vultr VM; render.yaml alternative
```

## Verified (automated, run on 2026-10-10)

`npm test`: **75 tests in 9 files pass** (one run showed a single 85 s timeout in
"viewers cannot undo" that did not reproduce in 4 subsequent full runs; cause unknown) against a real PostgreSQL 18 database and S3-compatible
storage (SeaweedFS), with multiple simulated WebSocket clients. `npm run typecheck` is clean.

| Requirement | Evidence |
|---|---|
| Upload -> place -> save -> reload after a full service restart | core-path.test |
| Manual edit reaching two viewers without refresh | realtime.test |
| Stale revision conflict between two editors without data loss; merge mode | core-path.test |
| Duplicate requests (incl. concurrent) applied once | core-path.test, undo.test, assistant.test |
| Atomic batches (all or nothing) | core-path.test |
| Undo/redo as new broadcast revisions; undo preserving a collaborator's change; unsafe undo rejected | undo.test, assistant.test |
| Username/password accounts: rules, case-insensitive login, duplicates, password change, migration from email accounts | auth.test |
| Viewer mutation rejection; read-only viewer sessions even for editor accounts; cross-gallery isolation | core-path.test, realtime.test, sharing.test |
| View / edit / restricted links, link rotation, explicit vs link membership precedence, invitations, editor limit | sharing.test |
| Live downgrade and revocation on open sockets (4403), revoked phone sessions | realtime.test, sharing.test |
| Reconnect/gap recovery (replay and snapshot fallback); join/snapshot race | realtime.test |
| Slow-consumer back-pressure (bounded) | realtime.test |
| Invalid graphs (cycles, missing refs), non-finite numbers, unnormalized quaternions, prototype-polluting paths, unknown ops | scene-engine.test, core-path.test |
| Unsupported, fake and oversized images and audio | core-path.test, assistant.test |
| Assistant: applied edit, clarification, malformed plan + repair, provider timeout, speech failure after a successful edit, mute, follow-ups, "undo that", re-plan after conflicting edit, downgrade during inference, cancellation, voice clips | assistant.test (**fake provider**) |
| Capabilities, schema endpoints, OpenAPI completeness | meta.test |
| Donations: encrypted custody, on-chain verification rules, single counting, poller, owner-only idempotent withdrawals | donations.test (**in-memory ledger**) |

Also checked manually: the production Docker image builds and runs (`/ready` reports database
and storage ok); `npm run seed:demo` produces a furnished gallery through the real pipeline;
`npm run export:contracts` output type-checks; `npm run demo:simulate` passes all 9 steps
against the container.

### Measured synchronization latency

| Measurement | Samples | p50 | p95 | max |
|---|---|---|---|---|
| realtime.test: HTTP submit -> receipt on 2 viewers (in-process server) | 120 | 20.2 ms | 23.4 ms | 73.7 ms |
| realtime.test: commit ack -> viewer receipt | 120 | 0.3 ms | 0.6 ms | - |
| demo-simulate against the Docker container: HTTP submit -> receipt on 2 phone-style viewers + 1 editor | 300 | 18.9 ms | 27.4 ms | 47.5 ms |

Conditions: everything on one Windows 11 machine (Docker Desktop for PostgreSQL/storage),
localhost networking, small load (1 gallery, 3-4 sockets). The "submit" measurements are
upper bounds that include HTTP request handling, validation and the database transaction.
They exclude network distance, Gemini inference, image transfer and rendering. The 300 ms
p95 demo target is met **under these conditions**; it is not a guarantee for a deployed
system. Re-run `npm run demo:simulate -- --base https://<deployed-api>` after deploying to
measure same-region numbers.

## Verified live with Gemini (2026-10-10, models `gemini-3.8-flash` + `gemini-3.8-flash-tts`, voice Kore)

`npm run smoke:gemini`: **15/15 checks passed**. For each language the brief's example
command produced a schema-valid plan that applied cleanly to a real scene and did what was
asked; speech output returned playable WAV audio; and that synthesized audio, sent back as a
voice command, was transcribed and planned correctly.

| Lang | Command | Text plan | Voice -> plan | Reply (excerpt) |
|---|---|---|---|---|
| en | Move the selected painting to the left wall and make its frame black. | pass, 2.9 s | pass, 3.7 s | "I moved the painting to the left wall and updated its frame color to black..." |
| ht | Mete mi yo blan. | pass, 3.6 s | pass, 3.8 s | "Mwen chanje koulè tout mi yo pou fè yo vin blan nèt..." |
| fr | Déplace ce tableau sur le mur de gauche. | pass, 2.5 s | pass, 3.6 s | "J'ai déplacé le tableau sur le mur de gauche..." |
| es | Haz que la iluminación sea más cálida. | pass, 2.7 s | pass, 4.2 s | "He ajustado la luz de techo y el color ambiental a un tono más cálido..." |
| ko | 이 그림을 조금 더 크게 해 주세요. | pass, 9.6 s | pass, 8.2 s | "선택한 그림의 크기를 약 15% 키웠습니다..." |

`npm run demo:simulate` against a server with Gemini enabled also passed end to end: the
Haitian Creole command was applied in 6.7 s and the follow-up "Fè tablo a yon ti kras pi gwo."
resized the same painting in 3.1 s, both answered in Kreyòl; muted follow-up generated no
speech.

Caveats: one run per language; voice input was tested with **synthesized** speech, not human
recordings; replies were not reviewed by native speakers; nobody has yet listened to
`reports/audio/*.wav` for quality. Live testing found one real bug that the fake-provider
tests could not: Gemini rejected the plan schema (`maxItems` on the operations array combined
with the operation-name enum, HTTP 400). Removed; the server caps operation counts itself.

## Implemented but NOT verified live

| Item | Why | How to verify |
|---|---|---|
| Voice commands from real people (accents, noise, browser-recorded WebM/MP4) | Smoke test uses synthesized speech | Record a few clips per language in the website and check transcripts |
| Solana devnet transactions | Tests use an in-memory ledger | Manual devnet donation per docs/donations.md |
| Vultr / Render deployment | Not deployed from this environment | docs/deployment.md steps 1-9 |
| Localized messages in ht/fr/es/ko | Machine-written | Native-speaker review |
| Mobile-browser VR viewer (stereo, motion permission on iPhone, WebXR on Android) | Website team builds the `/view/` and `/p/` pages; backend links and flow are tested | Test on the actual demo phones over HTTPS (docs/api-guide.md) |

## Known limits and decisions

- **Single instance:** in-process WebSocket fan-out, rate limiters and assistant queue.
  Horizontal scaling needs PostgreSQL `LISTEN/NOTIFY` or Redis for broadcasts. Data
  correctness does not depend on it, because clients resync from the database.
- **Capacity defaults** (5 editors, 10 viewers per gallery, 2000 nodes, 200 ops per batch)
  are starting assumptions, not measured capacity.
- **Signed URLs** stay valid until expiry (15 min) after access is revoked; the proxy
  endpoint stops at once.
- **Undo** is per actor and guarded; it refuses (409) rather than overwrite others. A drag
  sent as many throttled batches creates many undo steps unless the client submits on release.
- **Assistant** commands interrupted by a restart fail with `SERVICE_UNAVAILABLE`; an edit
  that committed before the restart stays committed and recorded.
- **Donations** are custodial; the encryption key must be backed up; key rotation is not
  implemented; mainnet requires an explicit flag and legal review.
- **Accounts** are username + password only. There is no email, so a forgotten password
  cannot be recovered (users can change it while signed in). Migration 004 converted existing
  email accounts to usernames derived from the email name.
- **Phone viewing** happens in the mobile browser (no app). iPhone Safari has no WebXR VR mode,
  so the viewer page renders stereo itself from motion sensors, which require HTTPS and a
  permission tap; lens distortion correction is a client concern.
- **Seed** creates a new demo gallery per run and resets the demo passwords; it refuses to
  run with `NODE_ENV=production`.
- **Not in scope:** the website (editor and mobile viewer pages), AI image generation, 3D model
  upload, continuous microphone streaming.
