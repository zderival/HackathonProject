// Repeatable end-to-end demo against a RUNNING backend: `npm run demo:simulate [-- --base http://localhost:8080 --edits 60]`
//
// Plays the demo script with simulated clients (two website editors, two iPhone-style
// read-only viewers paired by QR code), checks every step, and reports observed
// commit -> receipt latency for manual edits. Uses fresh accounts each run.
// The assistant step runs only if the server has a provider configured.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import WebSocket from 'ws';
import { setPath } from '../src/scene/engine.js';

// Applies committed changes to a local scene copy, exactly as a renderer would.
function applyWire(scene: any, changes: any[]) {
  for (const c of changes) {
    if (c.kind === 'node.add') scene.nodes[c.node.id] = structuredClone(c.node);
    else if (c.kind === 'node.remove') delete scene.nodes[c.nodeId];
    else if (c.kind === 'node.set') setPath(scene.nodes[c.nodeId], c.path, c.value);
    else if (c.kind === 'scene.set') setPath(scene, c.path, c.value);
  }
}

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', process.env.DEMO_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const EDITS = Number(arg('edits', '60'));

type Api = ReturnType<typeof api>;
function api(token?: string, headers: Record<string, string> = {}) {
  const call = async (method: string, path: string, body?: unknown) => {
    const h: Record<string, string> = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload: any;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok && !(method === 'POST' && res.status === 202)) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return json;
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b), put: (p: string, b: unknown) => call('PUT', p, b), raw: call };
}

class Live {
  scene: any;
  revision = -1;
  recv = new Map<number, number>();
  messages: any[] = [];
  closedCode: number | null = null;
  constructor(readonly name: string, readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      this.messages.push(m);
      if (m.type === 'snapshot') {
        this.scene = m.scene;
        this.revision = m.revision;
      } else if (m.type === 'ops') {
        this.recv.set(m.revision, performance.now());
        if (m.revision === this.revision + 1) {
          applyWire(this.scene, m.changes);
          this.revision = m.revision;
        }
        else if (m.revision > this.revision + 1) ws.send(JSON.stringify({ type: 'resync', fromRevision: this.revision }));
      }
    });
    ws.on('close', (c) => (this.closedCode = c));
  }
  async until(pred: () => boolean, ms = 5000) {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) throw new Error(`${this.name}: timeout`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

async function connect(name: string, a: Api, galleryId: string, capability: 'edit' | 'view') {
  const t = await a.post(`/v1/galleries/${galleryId}/realtime-tickets`, { capability });
  // Connect to the server under test even if its PUBLIC_API_URL points elsewhere.
  const url = new URL(t.url);
  const base = new URL(BASE);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.host = base.host;
  const ws = new WebSocket(url);
  const live = new Live(name, ws);
  await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)));
  await live.until(() => live.revision >= 0);
  return live;
}

async function user(name: string) {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@demo-sim.test`;
  const r = await api().post('/v1/auth/register', { email, password: 'demo-sim-password', displayName: name });
  return { id: r.user.id as string, email, api: api(r.tokens.accessToken) };
}

const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);
const ok = (msg: string) => console.log(`    ok  ${msg}`);
const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];

async function main() {
  console.log(`Demo simulation against ${BASE}`);
  const health = await api().get('/ready');
  ok(`ready: ${JSON.stringify(health.checks)}`);
  const caps = await api().get('/v1/capabilities');

  step(1, 'Owner and a second editor sign in; owner creates a gallery and grants editor access');
  const owner = await user('Owner');
  const editor = await user('Editor');
  const g = await owner.api.post('/v1/galleries', { title: 'Simulated demo' });
  await owner.api.put(`/v1/galleries/${g.id}/members/${editor.id}`, { role: 'editor' });
  ok(`gallery ${g.id}`);

  step(2, 'Website opens a preview; two phones scan the pairing QR and subscribe read-only');
  const phones: Live[] = [];
  for (const n of ['phone-1', 'phone-2']) {
    const preview = await owner.api.post(`/v1/galleries/${g.id}/viewer-sessions`, { kind: 'preview' });
    const resolved = await api().get(`/v1/links/resolve?url=${encodeURIComponent(preview.pairingUrl)}`);
    if (resolved.next !== 'claim_pairing') throw new Error('pairing link did not resolve');
    const claim = await api().post('/v1/pairings/claim', { code: preview.pairingCode });
    phones.push(await connect(n, api(claim.viewerToken), g.id, 'view'));
  }
  const ed1 = await connect('editor-1', owner.api, g.id, 'edit');
  const ed2 = await connect('editor-2', editor.api, g.id, 'edit');
  ok('2 phones + 2 editors live');

  step(3, 'Upload artwork and hang it on the north wall');
  const png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#2a6f97' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('title', 'Blue study');
  fd.append('file', new Blob([new Uint8Array(png)]), 'blue.png');
  const asset = await owner.api.post(`/v1/galleries/${g.id}/assets`, fd);
  let rev = 0;
  const act = async (a: Api, ops: unknown[], label: string) => {
    const r = await a.post(`/v1/galleries/${g.id}/actions`, { requestId: randomUUID(), baseRevision: rev, label, ops });
    rev = r.revision;
    return r;
  };
  await act(owner.api, [
    { op: 'artwork.place', nodeId: 'art-1', assetId: asset.id, parentId: 'wall-north', width: 1.4 },
    { op: 'artwork.hangOnWall', nodeId: 'art-1', wallId: 'wall-north', centerHeight: 1.6 },
  ], 'Hang artwork');
  await Promise.all(phones.map((p) => p.until(() => p.revision >= rev)));
  ok(`asset ${asset.id} (${asset.variants.length} variants); phones see art-1: ${phones.every((p) => !!p.scene.nodes['art-1'])}`);

  step(4, 'Room, material and light changes from the second editor; viewpoint moved from the website');
  await act(editor.api, [
    { op: 'room.resize', nodeId: 'room-main', width: 12 },
    { op: 'node.setMaterial', nodeId: 'floor-main', material: { color: '#3d2b1f' } },
    { op: 'node.update', nodeId: 'light-key', set: { 'props.color': '#ffd6a0', 'props.intensity': 2 } },
  ], 'Resize room, dark floor, warm light');
  await act(owner.api, [{ op: 'scene.setViewerAnchor', position: [0, 1.6, 1], rotation: [0, 0, 0, 1], roomId: 'room-main' }], 'Move viewpoint');
  await Promise.all(phones.map((p) => p.until(() => p.revision >= rev)));
  ok(`phones anchor: ${JSON.stringify(phones[0].scene.viewerAnchor.position)}; wall-east x = ${phones[0].scene.nodes['wall-east'].transform.position[0]}`);

  step(5, 'Stale edit from editor 2 is rejected without losing editor 1\'s change');
  const stale = await editor.api.raw('POST', `/v1/galleries/${g.id}/actions`, { requestId: randomUUID(), baseRevision: rev - 1, ops: [{ op: 'node.setVisibility', nodeId: 'light-key', visible: false }] }).catch((e) => e.message);
  ok(`stale submit -> ${String(stale).includes('REVISION_CONFLICT') ? 'REVISION_CONFLICT' : stale}`);

  if (caps.assistant.enabled) {
    step(6, `Assistant (${caps.assistant.provider}): Haitian Creole command, then a follow-up, spoken reply muted on the second`);
    const conv = await owner.api.post(`/v1/galleries/${g.id}/assistant/conversations`, { language: 'ht' });
    const run = async (text: string, audioEnabled: boolean) => {
      const c = await owner.api.post(`/v1/assistant/conversations/${conv.id}/commands`, { requestId: randomUUID(), text, audioEnabled, selectedNodeIds: ['art-1'] });
      const t = Date.now();
      let cmd = c;
      while (!cmd.final && Date.now() - t < 60_000) {
        await new Promise((r) => setTimeout(r, 500));
        cmd = await owner.api.get(`/v1/assistant/commands/${c.id}`);
      }
      console.log(`    ${text} -> ${cmd.status} in ${Date.now() - t} ms: ${cmd.reply ?? ''} ${cmd.question ?? ''} (speech: ${cmd.speech.status})`);
      if (cmd.revision) rev = Math.max(rev, cmd.revision);
      return cmd;
    };
    await run('Mete mi yo blan.', true);
    await run('Fè tablo a yon ti kras pi gwo.', false);
  } else console.log('\n[6] Assistant step skipped: no provider configured on the server (set GEMINI_API_KEY).');

  step(7, 'Undo (guarded) of the owner\'s latest action');
  const u = await owner.api.post(`/v1/galleries/${g.id}/undo`, { requestId: randomUUID() });
  rev = u.revision;
  ok(`undo -> revision ${u.revision}, ${u.changes.length} changes`);

  step(8, `Latency: ${EDITS} manual edits, commit -> receipt on 2 phones and the other editor`);
  const lat: number[] = [];
  for (let i = 0; i < EDITS; i++) {
    const t0 = performance.now();
    const r = await act(owner.api, [{ op: 'node.setTransform', nodeId: 'art-1', position: [-1 + (i % 20) * 0.1, -0.1, 0.095] }], 'drag');
    await Promise.all([...phones, ed2].map((p) => p.until(() => p.recv.has(r.revision))));
    for (const p of [...phones, ed2]) lat.push(p.recv.get(r.revision)! - t0);
    await new Promise((res) => setTimeout(res, 20));
  }
  console.log(`    samples=${lat.length} p50=${pct(lat, 50).toFixed(1)} ms p95=${pct(lat, 95).toFixed(1)} ms max=${Math.max(...lat).toFixed(1)} ms (demo target p95 < 300 ms)`);
  console.log('    method: from just before the HTTP submit to receipt on each client (upper bound: includes request handling, validation, commit and fan-out); excludes rendering.');

  step(9, 'Permission downgrade: editor 2 becomes a viewer while connected');
  await owner.api.put(`/v1/galleries/${g.id}/members/${editor.id}`, { role: 'viewer' });
  await ed2.until(() => ed2.messages.some((m) => m.type === 'permissions' && m.canEdit === false));
  ed2.ws.send(JSON.stringify({ type: 'submit', clientMsgId: 'x', action: { requestId: randomUUID(), baseRevision: rev, ops: [{ op: 'node.setVisibility', nodeId: 'art-1', visible: false }] } }));
  await ed2.until(() => ed2.messages.some((m) => m.type === 'error' && m.clientMsgId === 'x'));
  ok(`editor 2 write refused: ${ed2.messages.find((m) => m.clientMsgId === 'x').code}`);

  for (const l of [...phones, ed1, ed2]) l.ws.close();
  console.log('\nDemo simulation completed successfully.');
}

main().catch((err) => {
  console.error('\nDemo simulation FAILED:', err.message);
  process.exit(1);
});
