# HTTP API guide

Reference: `contracts/openapi.json` (also served at `GET /openapi.json`). All endpoints are
under `/v1`. This guide covers the cross-cutting rules the reference cannot express well.

## Authentication

| Token | Obtained from | Used by | Can |
|---|---|---|---|
| `at_...` access token (15 min) | `POST /v1/auth/register`, `/login`, `/refresh` | website | everything the account's role allows |
| `rt_...` refresh token (30 days, single use, rotates) | same | website | `POST /v1/auth/refresh` only |
| `vs_...` viewer token (12 h) | `POST /v1/galleries/{id}/viewer-sessions`, `POST /v1/pairings/claim` | iPhone app, previews | read ONE gallery: scene, assets, events, `view` tickets |
| `wst_...` WebSocket ticket (60 s, single use) | `POST /v1/galleries/{id}/realtime-tickets` | any client | open one WebSocket |

Send tokens as `Authorization: Bearer <token>`. Tokens are opaque and stored hashed. Roles
are **never** embedded in tokens: every request resolves access from the database, so role
changes and revocations apply to the next request (and immediately to open WebSockets).
`POST /v1/auth/logout` revokes the session (`{"allSessions": true}` revokes all).

## Errors

Every error has the same envelope, an `X-Request-Id` header and an HTTP status:

```json
{ "error": { "code": "REVISION_CONFLICT", "message": "Someone else changed the gallery. Refresh and try again.",
             "details": { "baseRevision": 41, "currentRevision": 43 }, "requestId": "6f0c..." } }
```

`message` is localized from `Accept-Language` (or the user's preferred language): `en`,
`ht`, `fr`, `es`, `ko`. Haitian Creole (`ht`) is matched on its own code and never falls back
to French. Branch on `code`, never on `message`.

| Code | HTTP | Typical cause |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Request shape or field invalid (`details.issues`, `details.opIndex`). |
| `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `TICKET_INVALID` | 401 | Missing/expired token; wrong password; bad ticket. |
| `FORBIDDEN` | 403 | You can see the gallery but lack the capability (e.g. viewer editing). |
| `NOT_FOUND` | 404 | Does not exist **or you have no access** (galleries are not probeable). |
| `REVISION_CONFLICT`, `UNDO_CONFLICT`, `NOTHING_TO_UNDO`, `NOTHING_TO_REDO`, `IDEMPOTENCY_MISMATCH`, `EMAIL_TAKEN`, `AI_CANCELLED` | 409 | See below. |
| `LINK_DISABLED`, `INVITATION_INVALID` | 410 | Share link rotated/disabled; invitation used/expired/revoked. |
| `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 413 / 415 | Upload limits and formats. |
| `INVALID_SCENE`, `INVALID_REFERENCE`, `UNSUPPORTED_OPERATION`, `LIMIT_EXCEEDED`, `AI_INVALID_PLAN`, `DONATION_UNVERIFIED`, `INSUFFICIENT_FUNDS` | 422 | Edit would break the scene; limits; assistant plan rejected; donations. |
| `RATE_LIMITED` | 429 | Slow down. |
| `INTERNAL` / `AI_UNAVAILABLE`, `SERVICE_UNAVAILABLE` / `AI_TIMEOUT` | 500 / 503 / 504 | Server or provider problems. |

## Edits: idempotency, conflicts and retries

`POST /v1/galleries/{id}/actions`:

```json
{ "requestId": "1b4e28ba-2fa1-11d2-883f-0016d3cca427", "baseRevision": 41, "label": "Move painting",
  "conflictMode": "strict",
  "ops": [ { "op": "node.setTransform", "nodeId": "art-1", "position": [-1.2, -0.1, 0.095] } ] }
```

- **Atomic:** all ops apply or none. The result is one revision and one undo step.
- **Idempotent:** generate `requestId` once per logical edit and reuse it on retries
  (network errors, timeouts). A committed request returns `duplicate: true` with the original
  revision and is never applied twice. Reusing a `requestId` for different ops returns
  `IDEMPOTENCY_MISMATCH`.
- **Revision check:** the server locks the gallery row, checks the revision, validates the
  full resulting scene, writes scene + history and increments the revision in one
  transaction, and broadcasts only after commit.
  - `strict` (default): fails with `REVISION_CONFLICT` if anyone committed after `baseRevision`.
  - `merge`: commits on top of newer revisions unless a change since `baseRevision` touched
    the same node property / scene setting (or added/removed the same node). Recommended for
    property-level editor UIs and dragging.

**Conflict procedure (409 `REVISION_CONFLICT`):**
1. Bring your copy up to date: apply pending WebSocket `ops`, or `GET /events?after=<base>`,
   or `GET /scene`.
2. Re-evaluate the user's intent against the new state (the edited node may be gone).
3. Resubmit with the new `baseRevision` and a **new** `requestId`.

Never resolve a conflict by sending an old whole scene: there is no "replace scene" endpoint
by design.

## Undo / redo

- `POST /v1/galleries/{id}/undo { requestId, actionId? }` undoes **your** latest
  manual/AI/redo action (or the given one of yours). `POST .../redo { requestId }` re-applies
  your most recent undo until you make a new edit.
- An undo commits the guarded inverse as a new revision (broadcast like any edit):
  changes made by collaborators to **other** properties are preserved. If anyone changed a
  property the undo would restore (or removed/edited a node it would delete/recreate), it
  returns `409 UNDO_CONFLICT` (`details.key` names the property) and changes nothing. It never
  restores an old scene snapshot.
- `GET /v1/galleries/{id}/actions` lists history with actor, time, source and labels.

## Permissions and sharing

Roles: **owner** (one per gallery), **editor**, **viewer**. Only the owner manages
permissions, sharing modes, links and invitations.

**Precedence** (highest role wins; resolved from the database on every request):
1. Owner.
2. Explicit membership (`source` invite or direct): valid in every sharing mode until
   changed or revoked.
3. Link membership (`source` link, created by `POST /galleries/{id}/join` with the edit link):
   counts as editor **only while** the gallery is in `edit_link` mode **and** the edit link has
   not been rotated since (its `link_version` matches). Leaving `edit_link` mode rotates the
   edit link, so link editors never silently return.
4. A valid share token presented with the request (`X-Gallery-Link` header or `?link=`):
   viewer, while the mode is `view_link` or `edit_link`.
5. Otherwise no access. In `restricted` mode only 1-2 apply: a link or QR code alone never
   grants access.

| Mode | Link holders | Signed-in users with the edit join link | Explicit members |
|---|---|---|---|
| `restricted` | nothing | nothing | their role |
| `view_link` | view | view | their role |
| `edit_link` | view | may join as editors | their role |

Effects of owner actions (all apply immediately, including on open WebSockets via
`permissions` messages or close code 4403):

| Action | Endpoint | Effect on old links/QR codes |
|---|---|---|
| Change mode | `PUT /galleries/{id}/sharing {mode}` | `restricted`: view links stop working; link editors suspended. |
| Rotate links | `POST /galleries/{id}/sharing/rotate {links: view|edit|both}` | Old tokens (and every QR printed from them) stop working; phones using them lose access; link editors suspended on edit rotation. |
| Grant/change role | `PUT /galleries/{id}/members/{userId} {role}` | Membership becomes explicit. Downgrade removes write capability at once. |
| Revoke | `DELETE /galleries/{id}/members/{userId}` | Access ends at once (members may also leave themselves). |
| Invite | `POST /galleries/{id}/invitations {email, role}` | Returns a link `PUBLIC_WEB_URL/invite/{token}`; single use; expires (7 days); only the invited email can accept (`POST /invitations/accept`). No email is sent by the backend. |
| Editor limit | `LIMIT_EDITORS_PER_GALLERY` (5) | `LIMIT_EXCEEDED` when granting more editors. |

`GET /v1/galleries/{id}/capabilities` returns your effective role, how it was granted and
which actions to enable in the UI.

## Links, QR codes and the iPhone flow

Canonical link shapes (HTTPS, handled by the iOS app as Universal Links, by the website
otherwise):

| Link | Shape |
|---|---|
| Gallery (members) | `{DEEP_LINK_BASE_URL}/g/{galleryId}` |
| Gallery via view link | `{DEEP_LINK_BASE_URL}/g/{galleryId}?link={viewToken}` |
| Edit join link (website) | `{PUBLIC_WEB_URL}/g/{galleryId}/join?link={editToken}` |
| Phone pairing (preview) | `{DEEP_LINK_BASE_URL}/p/{pairingCode}` |
| Invitation (website) | `{PUBLIC_WEB_URL}/invite/{token}` |

QR images: `GET /v1/galleries/{id}/qr?format=png|svg&target=gallery|edit` and
`GET /v1/pairings/qr?code=...`; the encoded URL is in the `X-Link-Url` header. A QR code is
an **entry link**, not an authorization grant: access is decided when it is resolved, so
rotating links or restricting the gallery invalidates printed codes immediately.

**Phone flow:** scan -> `GET /v1/links/resolve?url=<scanned URL>` (with the app's token if
it has one) -> follow `next`:

| `next` | Do |
|---|---|
| `open` | `POST /v1/galleries/{id}/viewer-sessions` (send `X-Gallery-Link: <linkToken>` if returned) -> `vs_` token -> `GET /scene` -> view ticket -> WebSocket. |
| `sign_in` | Authenticate (email/password), then resolve again. The response reveals nothing about restricted galleries. |
| `claim_pairing` | `POST /v1/pairings/claim {code}` -> `vs_` token (single use, 10 min). |
| `join_as_editor` / `accept_invitation` | Website flows; the phone should open the website. |

Errors: `410 LINK_DISABLED` (rotated/disabled link), `404` (signed in but no access).

**Website preview -> phone:** the editor calls `POST /viewer-sessions {kind: "preview"}` and
shows `qrSvgPath` as a QR code; the phone scans it, claims the code and gets its own
read-only token. The token never appears on screen. Revoke with `DELETE /v1/viewer-sessions/{id}`.

### iOS Universal Link / app-install handoff (client team)

The backend only produces HTTPS links; it does not install apps. The website/iOS team must:
1. Serve `https://<DEEP_LINK_BASE_URL host>/.well-known/apple-app-site-association` listing
   the app ID with paths `/g/*` and `/p/*`, and add the Associated Domains entitlement
   `applinks:<host>` to the app.
2. Implement the same paths as a **web landing page** fallback: it shows the gallery name
   (via `GET /v1/links/resolve`), an App Store / TestFlight link, and a web preview.
3. In the app, pass the full incoming URL to `GET /v1/links/resolve`.

Old QR codes keep working as entry links; whether they still grant access follows the
current sharing mode and link tokens.

## Assets

- Upload: `POST /v1/galleries/{id}/assets` (multipart: `title`, `description`,
  `attribution` text fields first, then `file`). JPEG/PNG/WebP, detected from the bytes,
  max `LIMIT_MAX_UPLOAD_BYTES` (20 MB) and `LIMIT_MAX_IMAGE_PIXELS` (40 MP). The original is
  re-encoded without metadata (EXIF orientation applied) and `thumb`/`medium`/`large`
  variants are generated (WebP, plus JPEG/PNG for engines without WebP). Object keys are random.
- Manifest: `GET /v1/assets/{id}` or batch `POST /v1/assets/manifests {assetIds}`: dimensions,
  formats, byte sizes and **signed URLs valid for `SIGNED_URL_TTL_SEC` (15 min)**
  (`urlsExpireAt`). Refresh by fetching the manifest again; cache image bytes by
  `assetId + variant` (they are immutable).
- Authorized proxy alternative: `GET /v1/assets/{id}/variants/{name}.{format}` with the
  Authorization header.
- After access is revoked, previously issued signed URLs keep working until they expire
  (at most `SIGNED_URL_TTL_SEC`); the proxy stops immediately.
- Scenes reference `assetId`s only. Placing the same asset again never re-uploads it.
- Uploaded titles/descriptions are untrusted text: render them as text, never as HTML, and
  the assistant treats them as data, not instructions.

## Pagination

Cursor-based: gallery list (`cursor`/`nextCursor`), history (`beforeRevision` /
`nextBeforeRevision`), assets and assistant history (`before`/`nextBefore`).
