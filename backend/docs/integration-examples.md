# Integration examples

Client guidance only: the endpoints these call are the real backend. Types come from
`contracts/types/gallery-api.d.ts`.

## Browser / TypeScript (website editor)

```ts
import type { Scene, Operation, ServerMessage, AssistantCommand } from './contracts/types/gallery-api';

const API = 'https://api.example.com';
let tokens: { accessToken: string; refreshToken: string };

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens.accessToken}`, 'accept-language': navigator.language };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + path, { method, headers, body: payload });
  if (res.status === 401 && path !== '/v1/auth/refresh') { await refresh(); return api(method, path, body); }
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok && res.status !== 202) throw Object.assign(new Error(json.error.message), json.error, { status: res.status });
  return json;
}

// 1. Login
const login = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }) }).then((r) => r.json());
tokens = login.tokens;
async function refresh() {
  const r = await fetch(`${API}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }) }).then((r) => r.json());
  tokens = r.tokens;
}

// 2. Capabilities (build property panels from capabilities.nodeTypes[type].fields) and scene
const caps = await api('GET', '/v1/capabilities');
const me = await api('GET', `/v1/galleries/${galleryId}/capabilities`);   // enable/disable UI by role
let { scene, revision } = await api<{ scene: Scene; revision: number }>('GET', `/v1/galleries/${galleryId}/scene`);

// 3. Upload artwork, then place it (one atomic action = one undo step)
const fd = new FormData();
fd.append('title', 'My painting');      // text fields before the file
fd.append('file', fileInput.files[0]);
const asset = await api('POST', `/v1/galleries/${galleryId}/assets`, fd);
await submit([
  { op: 'artwork.place', assetId: asset.id, nodeId: 'art-new', parentId: 'wall-north' },
  { op: 'artwork.hangOnWall', nodeId: 'art-new', wallId: 'wall-north', x: 0, centerHeight: 1.6 },
], 'Add painting');

// 4. Manual edits with idempotent retries and conflict handling
async function submit(ops: Operation[], label: string, conflictMode: 'strict' | 'merge' = 'merge') {
  const requestId = crypto.randomUUID();                 // reuse on retry
  for (let attempt = 0; ; attempt++) {
    try {
      return await api('POST', `/v1/galleries/${galleryId}/actions`, { requestId, baseRevision: revision, ops, label, conflictMode });
    } catch (e: any) {
      if (e.code === 'REVISION_CONFLICT') { await catchUp(); throw e; } // re-evaluate intent, resubmit with a NEW requestId
      if ((e.status === undefined || e.status >= 500) && attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
      throw e;
    }
  }
}

// Dragging: coalesce to one batch per 50 ms, latest value wins
let pending: Operation | null = null;
function onDrag(nodeId: string, position: [number, number, number]) {
  applyLocally(nodeId, position);                       // instant local feedback
  const first = !pending;
  pending = { op: 'node.setTransform', nodeId, position };
  if (first) setTimeout(() => { const op = pending!; pending = null; submit([op], 'Move', 'merge'); }, 50);
}

// 5. Live subscription with ordering, gap detection and reconnect
let ws: WebSocket; let backoff = 500;
async function connect() {
  const t = await api('POST', `/v1/galleries/${galleryId}/realtime-tickets`, { capability: 'edit' });
  ws = new WebSocket(t.url);
  ws.onopen = () => (backoff = 500);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data) as ServerMessage;
    switch (m.type) {
      case 'snapshot': scene = m.scene as Scene; revision = m.revision; render(); break;
      case 'ops':
        if (m.revision <= revision) break;                                   // duplicate
        if (m.revision !== revision + 1) { ws.send(JSON.stringify({ type: 'resync', fromRevision: revision })); break; } // gap
        for (const c of m.changes) applyChange(scene, c);                    // node.add / node.remove / node.set / scene.set
        revision = m.revision; render(); break;
      case 'permissions': setEditable(m.canEdit); break;
      case 'assistant': onAssistant(m.command as AssistantCommand); break;
      case 'error': if (m.fatal) console.warn(m.message); break;
    }
  };
  ws.onclose = (ev) => {
    if (ev.code === 4403) return showAccessLost();                           // do not reconnect
    setTimeout(connect, backoff + Math.random() * 250);                      // fresh ticket each time
    backoff = Math.min(backoff * 2, 15000);
  };
}
async function catchUp() {
  const r = await api('GET', `/v1/galleries/${galleryId}/events?after=${revision}`);
  if (!r.complete) ({ scene, revision } = await api('GET', `/v1/galleries/${galleryId}/scene`));
  else for (const e of r.events) { for (const c of e.changes) applyChange(scene, c); revision = e.revision; }
}

// 6. Assistant: text or push-to-talk, with a mute toggle
let muted = false;
const conv = await api('POST', `/v1/galleries/${galleryId}/assistant/conversations`, { language: 'ht' });
await api('POST', `/v1/assistant/conversations/${conv.id}/commands`,
  { requestId: crypto.randomUUID(), text: 'Mete mi yo blan.', audioEnabled: !muted, selectedNodeIds: selection });
// Voice: MediaRecorder -> Blob (audio/webm in Chrome, audio/mp4 in Safari)
async function sendClip(blob: Blob, durationMs: number) {
  const f = new FormData();
  f.append('requestId', crypto.randomUUID()); f.append('audioEnabled', String(!muted));
  f.append('selectedNodeIds', JSON.stringify(selection)); f.append('durationMs', String(durationMs));
  f.append('audio', blob, 'clip');
  return api('POST', `/v1/assistant/conversations/${conv.id}/voice-commands`, f);
}
async function onAssistant(cmd: AssistantCommand) {
  showReply(cmd.transcript, cmd.reply, cmd.question, cmd.suggestions, cmd.status);  // written reply first
  if (cmd.speech.status === 'ready' && !muted) {
    const s = await api('GET', cmd.speech.path!);
    new Audio(s.url).play();                                                   // stop it when the user mutes
  }
}

function applyChange(scene: any, c: any) {
  const set = (obj: any, path: string, v: unknown) => { const k = path.split('.'); const last = k.pop()!;
    for (const p of k) obj = obj[p] ??= {}; if (v === undefined) delete obj[last]; else obj[last] = v; };
  if (c.kind === 'node.add') scene.nodes[c.node.id] = c.node;
  else if (c.kind === 'node.remove') delete scene.nodes[c.nodeId];
  else if (c.kind === 'node.set') set(scene.nodes[c.nodeId], c.path, c.value);
  else set(scene, c.path, c.value);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

## iPhone viewer (Swift-flavoured pseudocode; renderer-neutral)

```swift
// 1. Scan QR / open Universal Link
func handle(url: URL) async throws {
    let r = try await get("/v1/links/resolve?url=\(url.absoluteString.urlEncoded)", token: savedToken)
    switch r.next {
    case "open":
        var headers: [String: String] = [:]
        if let link = r.linkToken { headers["X-Gallery-Link"] = link }
        let vs = try await post("/v1/galleries/\(r.galleryId!)/viewer-sessions", body: [:], token: savedToken, headers: headers)
        try await startViewing(galleryId: r.galleryId!, viewerToken: vs.viewerToken)
    case "claim_pairing":
        let code = url.lastPathComponent                        // /p/{code}
        let s = try await post("/v1/pairings/claim", body: ["code": code])
        try await startViewing(galleryId: s.galleryId, viewerToken: s.viewerToken)
    case "sign_in":
        presentLogin { token in savedToken = token; Task { try await handle(url: url) } }
    default:
        openInBrowser(url)                                      // join_as_editor / accept_invitation are website flows
    }
}

// 2. Load scene + assets, 3. subscribe, 4. apply ordered updates
func startViewing(galleryId: String, viewerToken: String) async throws {
    let snap = try await get("/v1/galleries/\(galleryId)/scene", token: viewerToken)
    scene = snap.scene; revision = snap.revision
    try await loadAssets(for: scene, token: viewerToken)
    try await connect(galleryId: galleryId, token: viewerToken)
}

func loadAssets(for scene: Scene, token: String) async throws {
    let ids = scene.nodes.values.compactMap { $0.props.assetId ?? $0.props.material?.textureAssetId }
    guard !ids.isEmpty else { return }
    let m = try await post("/v1/assets/manifests", body: ["assetIds": Array(Set(ids))], token: token)
    for a in m.items {
        // Prefer "large" (or "medium" on older phones) in jpeg/png if the engine lacks WebP.
        let v = a.variants.first { $0.name == "large" && $0.format != "webp" } ?? a.variants.first { $0.name == "medium" && $0.format != "webp" }!
        cache[a.id] = try await download(v.url)                 // signed URL, no auth header; refresh manifest after urlsExpireAt
    }
}

func connect(galleryId: String, token: String) async throws {
    let t = try await post("/v1/galleries/\(galleryId)/realtime-tickets", body: ["capability": "view"], token: token)
    socket = WebSocket(url: t.url)
    socket.onMessage { msg in
        switch msg.type {
        case "snapshot": scene = msg.scene; revision = msg.revision; rebuildAll()
        case "ops":
            if msg.revision <= revision { return }                         // duplicate
            if msg.revision != revision + 1 { socket.send(["type": "resync", "fromRevision": revision]); return }
            for c in msg.changes { apply(c) }                              // may reference new assetIds -> loadAssets
            revision = msg.revision
            if msg.changes.contains(where: { $0.path == "viewerAnchor" }) { beginAnchorTransition(to: scene.viewerAnchor) }
        default: break
        }
    }
    socket.onClose { code in
        if code == 4403 { showAccessEnded(); return }                     // revoked: resolve the link again
        reconnectWithBackoff { try await connect(galleryId: galleryId, token: token) }  // new ticket each time
    }
}

// 5. Combine the shared anchor with LOCAL head tracking (never sent to the server)
func cameraPose(head: simd_quatf) -> (position: SIMD3<Float>, rotation: simd_quatf) {
    let a = currentAnchorPose()                                            // eased toward scene.viewerAnchor
    return (a.position, simd_normalize(a.rotation * head))                 // world = anchor * head
}
// Per eye: offset the camera along the rotated +X/-X by half the IPD; lens distortion per Cardboard SDK.
```

### Unity notes

Convert every local transform once when building the hierarchy (see docs/scene-model.md):
`position (x, y, -z)`, `rotation (-x, -y, z, w)`, scale unchanged; build front faces toward
Unity's local -Z (or rotate meshes 180 deg about Y). `Texture2D.LoadImage` does not decode
WebP: use the JPEG/PNG variants. Compose the camera as `anchorRotation * headRotation`
in Unity space.
