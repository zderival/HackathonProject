# Real-time protocol (version 1)

One WebSocket per client per gallery carries the authoritative snapshot and every
committed change, in revision order. Message schemas: `contracts/schemas/ws-client-message.schema.json`,
`ws-server-message.schema.json`, TypeScript types in `contracts/types/gallery-api.d.ts`.
The backend never streams rendered video; clients render their own copy.

## Connecting

1. Get a single-use ticket (valid 60 s) over HTTPS:

   ```http
   POST /v1/galleries/{galleryId}/realtime-tickets
   Authorization: Bearer <at_... user token | vs_... viewer token>
   X-Gallery-Link: <share token, only when access comes from a view link>

   { "capability": "edit" }        // website editor
   { "capability": "view" }        // iPhone viewer, website preview, read-only users
   ```

   Response: `{ "ticket", "url": "wss://api.example.com/v1/ws?ticket=...", "capability", "expiresAt" }`.
   Authorization is checked **before** any scene data is sent. `edit` requires editor access
   and a user session; `vs_` viewer tokens can only obtain `view` tickets.

2. Open `url`. The server sends, in order:
   - `hello`: `{ connectionId, galleryId, role, capability, canEdit, canManage, canUseAssistant, canUpload, heartbeatMs, serverTime, protocolVersion: 1 }`
   - `snapshot`: `{ galleryId, revision, reason: "initial", scene }`
   - then `ops` events for every revision after the snapshot.

**No join/snapshot race:** the connection is registered for broadcasts before the snapshot
is read. Events committed meanwhile are buffered and delivered after the snapshot (events
already contained in it are dropped by revision), so nothing committed between "load" and
"subscribe" is lost.

## Capabilities

| | `edit` connection | `view` connection |
|---|---|---|
| Receives snapshot, `ops`, `permissions`, `donation(s)` | yes | yes |
| May send `submit` | yes (re-authorized on every submit) | no: `FORBIDDEN` |
| Receives private `assistant` updates of its own user | yes | no |

A view ticket never authorizes writes, assistant use or permission changes, even when the
account itself is an editor or the owner.

## Server -> client messages

| `type` | Meaning |
|---|---|
| `hello` | Connection accepted; effective role and capability. |
| `snapshot` | Authoritative full state at `revision`. Replace the local copy. `reason`: `initial`, `requested`, `gap`. |
| `ops` | One committed action: `{ eventId, galleryId, revision, baseRevision, actionId, requestId, source, actor, label, undoOf, redoOf, ts, changes[] }`. `source`: manual, ai, undo, redo, system. Apply `changes` in order (see scene-model.md). |
| `ack` | Your `submit` committed: `{ clientMsgId, requestId, actionId, revision, duplicate, noop }`. The matching `ops` event still arrives in order. |
| `error` | `{ code, message (localized), clientMsgId?, requestId?, details?, fatal? }`. `fatal: true` means the server closes the socket next. |
| `permissions` | Your role/capability changed (e.g. downgraded to viewer). Disable editing UI immediately. |
| `pong` | Reply to `ping`: `{ t, serverTime, revision }`. |
| `assistant` | Status update of one of your assistant commands (same shape as `GET /v1/assistant/commands/{id}`). |
| `donation` / `donations` | A donation was verified on-chain / donation settings changed: `{ galleryId, donation?, summary }`. Not part of the revision sequence. |

## Client -> server messages

```jsonc
{ "type": "ping", "t": 1712345678901 }
{ "type": "resync", "fromRevision": 41 }     // replay after 41 (or omit fromRevision for a snapshot)
{ "type": "submit", "clientMsgId": "c-17", "action": { "requestId": "uuid", "baseRevision": 41, "ops": [ ... ] } }
```

`submit` has exactly the semantics of `POST /v1/galleries/{id}/actions` (atomic batch,
idempotent `requestId`, `baseRevision`, optional `conflictMode`, `label`). Failures come back
as `error` with the same `code`/`details` as HTTP.

## Ordering, duplicates and gaps

- The server delivers `ops` to each connection in strictly increasing `revision` order,
  each revision at most once. Broadcasts happen only **after** the database commit.
- Client rule: keep `localRevision`.
  - `revision <= localRevision`: duplicate, ignore (`eventId` = `"<galleryId>:<revision>"`).
  - `revision == localRevision + 1`: apply, set `localRevision = revision`.
  - `revision > localRevision + 1`: gap. Stop applying, send `{ "type": "resync", "fromRevision": localRevision }`.
    The server replays retained events (last `LIMIT_EVENT_REPLAY_WINDOW`, default 500) or, if
    the gap is older, sends a fresh `snapshot` with `reason: "gap"`.
- `GET /v1/galleries/{id}/events?after=N` offers the same replay over HTTP
  (`complete: false` means: load `GET /scene` instead).

## Heartbeat and reconnect

- The server pings every `heartbeatMs` (25 s) at the WebSocket level and closes
  connections that do not answer. Clients may also send `ping` to measure latency.
- Reconnect with exponential backoff and jitter: 0.5 s, 1 s, 2 s, 4 s ... capped at 15-30 s.
  Every reconnect needs a **new ticket** (tickets are single use).
- After reconnecting, the server sends a fresh `snapshot`. If you prefer replay, keep your
  scene and send `resync` with your `localRevision` right after `hello` (the snapshot can
  then be ignored if its revision equals yours).
- A missed broadcast never loses data: everything is committed in PostgreSQL before it
  is broadcast, so reconnecting always yields the latest committed state.

## Close codes

| Code | Meaning | Client action |
|---|---|---|
| 1000 | normal | - |
| 1001 | server shutting down / restarting | reconnect with backoff |
| 4001 | ticket invalid, expired or already used | get a new ticket |
| 4002 | protocol error | fix the client |
| 4008 | slow consumer or too many pending events | reconnect, resync |
| 4029 | too many connections for this gallery | retry later / tell the user |
| 4403 | access revoked (membership removed, link rotated, gallery restricted or deleted, viewer session revoked) | do not auto-reconnect; resolve the link again |

## Back-pressure

Each connection has a bounded send buffer (`LIMIT_WS_MAX_BUFFERED_BYTES`, 4 MB) and a bounded
queue while syncing (1000 events). A consumer that falls behind is closed with 4008 and must
resync; the server never grows memory without bound.

## Live manipulation (dragging)

Throttle to one `node.setTransform` batch per **50 ms** per dragged selection (latest value
wins, coalesce intermediate positions), use `conflictMode: "merge"` so unrelated concurrent
edits do not conflict, and send a final batch on pointer-up with a `label` such as
"Move painting". Never send assets or whole scenes. Each committed batch is one undo step;
if you want a drag to be a single undo step, render the drag locally and submit only on
pointer-up (recommended when other people are not watching the drag live).

## Scaling note

The first deployment runs **one** service instance: fan-out is in-process. Running several
instances requires a shared broadcast channel (PostgreSQL `LISTEN/NOTIFY` or Redis pub/sub)
feeding each instance's hub. Persistence and recovery already work across instances because
clients always resync from the database.

## Measured latency

See `docs/implementation-report.md` (commit-to-receipt measurements and method).
