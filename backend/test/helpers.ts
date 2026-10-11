import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import WebSocket from 'ws';
import { buildApp, type App } from '../src/app.js';
import { S3Storage } from '../src/assets/storage.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { setPath } from '../src/scene/engine.js';
import type { AssistantProvider } from '../src/assistant/provider.js';
import type { SolanaGateway } from '../src/donations/gateway.js';

try {
  process.loadEnvFile('.env');
} catch {
  /* environment provided externally */
}

export interface TestServer {
  app: App;
  db: Db;
  config: Config;
  base: string;
  close(): Promise<void>;
}

export async function startServer(overrides: (c: Config) => void = () => {}, opts: { assistantProvider?: AssistantProvider | null; solanaGateway?: SolanaGateway | null } = {}): Promise<TestServer> {
  process.env.NODE_ENV = 'test';
  const config = loadConfig();
  config.databaseUrl = process.env.TEST_DATABASE_URL!;
  config.s3.bucket = process.env.TEST_S3_BUCKET ?? 'gallery-test';
  config.port = 0;
  config.limits.authAttemptsPerMinute = 10_000;
  config.logLevel = process.env.TEST_LOG_LEVEL ?? "warn";
  config.host = '127.0.0.1';
  overrides(config);
  const db = createPool(config.databaseUrl, false);
  const storage = new S3Storage(config.s3);
  await storage.ensureBucket();
  const app = await buildApp({ config, db, storage, assistantProvider: opts.assistantProvider ?? null, solanaGateway: opts.solanaGateway ?? null });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  config.publicApiUrl = base;
  return {
    app,
    db,
    config,
    base,
    async close() {
      await app.close();
      await db.end();
    },
  };
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export function client(base: string, token?: string, extraHeaders: Record<string, string> = {}) {
  const call = async <T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> => {
    const h: Record<string, string> = { ...extraHeaders, ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload: any;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed };
  };
  return {
    get: <T = any>(p: string, headers?: Record<string, string>) => call<T>('GET', p, undefined, headers),
    post: <T = any>(p: string, b?: unknown, headers?: Record<string, string>) => call<T>('POST', p, b ?? {}, headers),
    patch: <T = any>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    put: <T = any>(p: string, b?: unknown) => call<T>('PUT', p, b),
    del: <T = any>(p: string) => call<T>('DELETE', p),
    token,
  };
}

export type Client = ReturnType<typeof client>;

export async function registerUser(base: string, name = 'User') {
  const username = `${name.toLowerCase().replace(/\W/g, '').slice(0, 16)}-${randomUUID().slice(0, 8)}`;
  const r = await client(base).post('/v1/auth/register', { username, password: 'correct-horse-1', displayName: name });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body.user, username, api: client(base, r.body.tokens.accessToken), tokens: r.body.tokens };
}

export async function createGallery(api: Client, title = 'Test gallery') {
  const r = await api.post('/v1/galleries', { title });
  if (r.status !== 201) throw new Error(`create gallery failed: ${r.status}`);
  return r.body as { id: string; revision: number };
}

export async function addMember(db: Db, galleryId: string, userId: string, role: 'editor' | 'viewer') {
  await db.query(
    `INSERT INTO gallery_members (gallery_id, user_id, role, source) VALUES ($1, $2, $3, 'direct')
     ON CONFLICT (gallery_id, user_id) DO UPDATE SET role = EXCLUDED.role, source = 'direct'`,
    [galleryId, userId, role],
  );
}

export async function testImage(width = 800, height = 600, format: 'png' | 'jpeg' | 'webp' = 'png', color = '#3366cc') {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .toFormat(format)
    .toBuffer();
}

export async function upload(api: Client, galleryId: string, file: Buffer, filename = 'art.png', title = 'Artwork') {
  const fd = new FormData();
  fd.append('title', title);
  fd.append('file', new Blob([new Uint8Array(file)]), filename);
  return api.post(`/v1/galleries/${galleryId}/assets`, fd);
}

export function action(baseRevision: number, ops: unknown[], extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), baseRevision, ops, ...extra };
}

// ---------------------------------------------------------------------------
// A WebSocket client that behaves like a renderer: keeps a local scene copy,
// applies ordered ops, detects gaps and records receipt times.

export function applyWire(scene: any, changes: any[]) {
  for (const c of changes) {
    if (c.kind === 'node.add') scene.nodes[c.node.id] = structuredClone(c.node);
    else if (c.kind === 'node.remove') delete scene.nodes[c.nodeId];
    else if (c.kind === 'node.set') setPath(scene.nodes[c.nodeId], c.path, c.value);
    else if (c.kind === 'scene.set') setPath(scene, c.path, c.value);
  }
}

export class LiveClient {
  messages: any[] = [];
  scene: any = null;
  revision = -1;
  gaps = 0;
  received = new Map<number, number>(); // revision -> receipt time (ms, performance.now)
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      if (msg.type === 'snapshot') {
        this.scene = msg.scene;
        this.revision = msg.revision;
      } else if (msg.type === 'ops') {
        this.received.set(msg.revision, performance.now());
        if (msg.revision <= this.revision) {
          /* duplicate: ignore */
        } else if (msg.revision !== this.revision + 1) {
          this.gaps++;
          this.send({ type: 'resync', fromRevision: this.revision });
        } else {
          applyWire(this.scene, msg.changes);
          this.revision = msg.revision;
        }
      }
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of [...this.waiters]) if (w.pred({ type: '__closed', code })) w.resolve({ type: '__closed', code });
    });
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred: (m: any) => boolean, timeoutMs = 5000, includePast = true): Promise<any> {
    if (includePast) {
      const found = this.messages.find(pred);
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for message; got ${JSON.stringify(this.messages.slice(-3)).slice(0, 500)}`)), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  waitForRevision(rev: number, timeoutMs = 5000) {
    if (this.revision >= rev) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (this.revision >= rev) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for revision ${rev}; at ${this.revision}`));
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  waitClosed(timeoutMs = 5000) {
    if (this.closed) return Promise.resolve(this.closed);
    return this.waitFor((m) => m.type === '__closed', timeoutMs, false).then(() => this.closed!);
  }

  close() {
    this.ws.close();
  }
}

export async function connectLive(api: Client, galleryId: string, capability: 'edit' | 'view' = 'view'): Promise<LiveClient> {
  const t = await api.post(`/v1/galleries/${galleryId}/realtime-tickets`, { capability });
  if (t.status !== 201) throw new Error(`ticket failed: ${t.status} ${JSON.stringify(t.body)}`);
  return openLive(t.body.url);
}

export async function openLive(url: string): Promise<LiveClient> {
  const ws = new WebSocket(url);
  const live = new LiveClient(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return live;
}

export async function connectAndSync(api: Client, galleryId: string, capability: 'edit' | 'view' = 'view') {
  const live = await connectLive(api, galleryId, capability);
  await live.waitFor((m) => m.type === 'snapshot');
  return live;
}

export function percentile(values: number[], p: number) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
