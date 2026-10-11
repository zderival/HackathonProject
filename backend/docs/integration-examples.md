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
  body: JSON.stringify({ username, password }) }).then((r) => r.json());   // no email anywhere
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

## Phone viewer in the mobile browser (TypeScript + three.js)

The QR code opens `{VIEWER_BASE_URL}/view/{galleryId}?link=...` (or `/p/{code}` for a
website preview) in the phone's normal browser. This page is read-only: it never needs an
editor account. Requires HTTPS.

```ts
import * as THREE from 'three';
import { StereoEffect } from 'three/examples/jsm/effects/StereoEffect.js';

const API = 'https://api.example.com';
let viewerToken = sessionStorage.getItem('vs') ?? '';
let scene: any; let revision = -1;

// 1. Resolve the URL the phone opened
async function start() {
  const r = await get(`/v1/links/resolve?url=${encodeURIComponent(location.href)}`, userToken());
  if (r.next === 'claim_pairing') {
    const code = location.pathname.split('/').pop()!;
    const s = await post('/v1/pairings/claim', { code });             // single use
    viewerToken = s.viewerToken; await view(s.galleryId);
  } else if (r.next === 'open') {
    const headers: Record<string, string> = r.linkToken ? { 'x-gallery-link': r.linkToken } : {};
    const vs = await post(`/v1/galleries/${r.galleryId}/viewer-sessions`, {}, userToken(), headers);
    viewerToken = vs.viewerToken; await view(r.galleryId);
  } else if (r.next === 'sign_in') {
    showLoginForm();                                                     // username + password, then start() again
  } else {
    location.href = r.galleryId ? `/g/${r.galleryId}` : '/';             // editor flows belong on the website
  }
  sessionStorage.setItem('vs', viewerToken);
}

// 2. Load scene + textures, 3. subscribe
async function view(galleryId: string) {
  ({ scene, revision } = await get(`/v1/galleries/${galleryId}/scene`, viewerToken));
  await loadTextures();                                                  // POST /v1/assets/manifests, use "medium" webp on phones
  buildThreeScene(scene);
  connect(galleryId);
}

function connect(galleryId: string, backoff = 500) {
  post(`/v1/galleries/${galleryId}/realtime-tickets`, { capability: 'view' }, viewerToken).then((t) => {
    const ws = new WebSocket(t.url);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'snapshot') { scene = m.scene; revision = m.revision; buildThreeScene(scene); }
      else if (m.type === 'ops') {
        if (m.revision <= revision) return;                                       // duplicate
        if (m.revision !== revision + 1) return ws.send(JSON.stringify({ type: 'resync', fromRevision: revision }));
        for (const c of m.changes) applyChange(scene, c);                         // same helper as the editor
        revision = m.revision; updateThreeScene(m.changes);                       // anchor changes: ease over ~400 ms
      }
    };
    ws.onclose = (e) => {
      if (e.code === 4403) return showMessage('This gallery is no longer shared with you.');
      setTimeout(() => connect(galleryId, Math.min(backoff * 2, 15000)), backoff + Math.random() * 250);
    };
  });
}

// 4. "Enter VR" button: permissions, fullscreen, stereo, head tracking
const renderer = new THREE.WebGLRenderer({ antialias: true });
const camera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.05, 200);
const stereo = new StereoEffect(renderer);
let head = new THREE.Quaternion();                                        // LOCAL head orientation only

enterVrButton.onclick = async () => {
  // Android Chrome: prefer real WebXR when available.
  if (await (navigator as any).xr?.isSessionSupported?.('immersive-vr')) return startWebXR();
  // iPhone Safari: motion sensors need permission from a user gesture.
  const DOE = DeviceOrientationEvent as any;
  if (typeof DOE.requestPermission === 'function' && (await DOE.requestPermission()) !== 'granted')
    return showMessage('Motion access is needed to look around.');
  // Android: real fullscreen. iPhone Safari ignores this; there, fullscreen comes from
  // launching the viewer from the Home Screen (see the iPhone checklist in api-guide.md).
  await document.documentElement.requestFullscreen?.().catch(() => {});
  await (navigator as any).wakeLock?.request('screen').catch(() => {});
  watchOrientation();                                                     // "Turn your phone sideways" overlay while portrait
  addEventListener('deviceorientation', (e) => { head = deviceOrientationToQuaternion(e.alpha!, e.beta!, e.gamma!, screen.orientation?.angle ?? 0); });
  renderer.setAnimationLoop(render);
};

// 5. Shared anchor x local head (head movement is never sent to the server)
function render() {
  const a = currentAnchor();                                              // eased toward scene.viewerAnchor
  camera.position.set(a.position[0], a.position[1], a.position[2]);
  camera.quaternion.set(a.rotation[0], a.rotation[1], a.rotation[2], a.rotation[3]).multiply(head);
  stereo.setSize(innerWidth, innerHeight);
  stereo.render(threeScene, camera);                                      // side-by-side for a phone headset
}
// deviceOrientationToQuaternion: the standard conversion used by three.js DeviceOrientationControls
// (ZXY Euler from alpha/beta/gamma, then rotate -90 deg about X and by the screen orientation).
```

Notes:
- The scene uses the same conventions as three.js (right-handed, +Y up, -Z forward), so
  transforms copy directly; colors are sRGB.
- `watchOrientation()`: show an overlay while `innerHeight > innerWidth`; iPhone cannot lock
  landscape from a web page.
- Let users "recenter": store the current head yaw as an offset and remove it from `head`.
- A phone headset's lenses need barrel-distortion correction for comfort; `StereoEffect` does
  not do it. Acceptable for a demo; add a distortion pass if time allows.
- Keep textures modest on phones (`medium` variants, 1024 px) to stay within GPU memory.
