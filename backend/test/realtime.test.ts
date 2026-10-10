import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeHub } from '../src/realtime/hub.js';
import {
  action,
  addMember,
  client,
  connectAndSync,
  connectLive,
  createGallery,
  openLive,
  percentile,
  registerUser,
  startServer,
  type TestServer,
} from './helpers.js';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => srv?.close());

const sceneOf = async (api: any, id: string) => (await api.get(`/v1/galleries/${id}/scene`)).body;

describe('live synchronization', () => {
  it('delivers a manual edit to two viewers without a refresh', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    // Viewer 1: phone flow (read-only viewer session). Viewer 2: another account.
    const vs = await owner.api.post(`/v1/galleries/${g.id}/viewer-sessions`, {});
    const phone = client(srv.base, vs.body.viewerToken);
    const other = await registerUser(srv.base, 'Viewer');
    await addMember(srv.db, g.id, other.id, 'viewer');

    const v1 = await connectAndSync(phone, g.id, 'view');
    const v2 = await connectAndSync(other.api, g.id, 'view');
    const hello = v1.messages.find((m) => m.type === 'hello');
    expect(hello).toMatchObject({ capability: 'view', canEdit: false, protocolVersion: 1 });
    expect(v1.revision).toBe(0);

    const r = await owner.api.post(
      `/v1/galleries/${g.id}/actions`,
      action(0, [{ op: 'scene.setViewerAnchor', position: [1, 1.6, 2], rotation: [0, 0.7071068, 0, 0.7071068] }]),
    );
    expect(r.status).toBe(200);
    await Promise.all([v1.waitForRevision(1), v2.waitForRevision(1)]);
    for (const v of [v1, v2]) {
      const ev = v.messages.find((m) => m.type === 'ops');
      expect(ev).toMatchObject({ galleryId: g.id, revision: 1, actionId: r.body.actionId, requestId: r.body.requestId, source: 'manual' });
      expect(ev.actor.userId).toBe(owner.id);
      expect(v.scene.viewerAnchor.position).toEqual([1, 1.6, 2]);
    }
    v1.close();
    v2.close();
  });

  it('measures commit-to-receipt latency for two viewers (demo target: p95 < 300 ms)', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const editor = await connectAndSync(owner.api, g.id, 'edit');
    const viewers = [await connectAndSync(owner.api, g.id, 'view'), await connectAndSync(owner.api, g.id, 'view')];

    // Submit over the editor's WebSocket; measure from the ack (commit done) and from
    // send time to receipt on each viewer.
    const sendToReceipt: number[] = [];
    const ackToReceipt: number[] = [];
    const N = 60;
    for (let i = 1; i <= N; i++) {
      const sent = performance.now();
      editor.send({
        type: 'submit',
        clientMsgId: `m${i}`,
        action: action(i - 1, [{ op: 'node.setTransform', nodeId: 'label-welcome', position: [i / 100, 1.1, 0.085] }]),
      });
      const ack = await editor.waitFor((m) => m.type === 'ack' && m.clientMsgId === `m${i}`);
      const ackAt = performance.now();
      expect(ack.revision).toBe(i);
      await Promise.all(viewers.map((v) => v.waitForRevision(i)));
      for (const v of viewers) {
        sendToReceipt.push(v.received.get(i)! - sent);
        ackToReceipt.push(Math.max(0, v.received.get(i)! - ackAt));
      }
    }
    const p95 = percentile(sendToReceipt, 95);
    const report = {
      samples: sendToReceipt.length,
      submitToViewerReceipt: { p50: +percentile(sendToReceipt, 50).toFixed(1), p95: +p95.toFixed(1), max: +Math.max(...sendToReceipt).toFixed(1) },
      ackToViewerReceipt: { p50: +percentile(ackToReceipt, 50).toFixed(1), p95: +percentile(ackToReceipt, 95).toFixed(1) },
    };
    console.log('[latency, localhost, ms]', JSON.stringify(report));
    expect(p95).toBeLessThan(300);
    for (const v of viewers) {
      expect(v.gaps).toBe(0);
      expect(v.scene).toEqual((await sceneOf(owner.api, g.id)).scene);
    }
    [editor, ...viewers].forEach((c) => c.close());
  });

  it('loses no changes when clients subscribe while edits are committing', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    let stop = false;
    let committed = 0;
    const writer = (async () => {
      let rev = 0;
      while (!stop) {
        const r = await owner.api.post(
          `/v1/galleries/${g.id}/actions`,
          action(rev, [{ op: 'node.setTransform', nodeId: 'label-welcome', position: [(rev % 50) / 10, 1.1, 0.085] }]),
        );
        if (r.status === 200) {
          rev = r.body.revision;
          committed = rev;
        }
      }
    })();
    const clients = [];
    for (let i = 0; i < 8; i++) {
      clients.push(await connectAndSync(owner.api, g.id, 'view'));
      await new Promise((r) => setTimeout(r, 15));
    }
    stop = true;
    await writer;
    const final = await sceneOf(owner.api, g.id);
    expect(final.revision).toBe(committed);
    expect(committed).toBeGreaterThan(5);
    for (const c of clients) {
      await c.waitForRevision(final.revision);
      expect(c.scene).toEqual(final.scene);
      // Every ops event after the snapshot arrived exactly in order.
      const snapRev = c.messages.find((m) => m.type === 'snapshot').revision;
      const revs = c.messages.filter((m) => m.type === 'ops').map((m) => m.revision);
      expect(revs).toEqual(Array.from({ length: final.revision - snapRev }, (_, k) => snapRev + 1 + k));
      c.close();
    }
  });

  it('recovers after a disconnect by replaying retained events or a snapshot', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const live = await connectAndSync(owner.api, g.id, 'view');
    live.close();
    for (let i = 0; i < 3; i++) {
      await owner.api.post(`/v1/galleries/${g.id}/actions`, action(i, [{ op: 'node.setVisibility', nodeId: 'light-key', visible: i % 2 === 1 }]));
    }
    // HTTP replay from the revision the client had.
    const ev = await owner.api.get(`/v1/galleries/${g.id}/events?after=0`);
    expect(ev.body).toMatchObject({ currentRevision: 3, complete: true });
    expect(ev.body.events.map((e: any) => e.revision)).toEqual([1, 2, 3]);

    // WebSocket resync from an older revision replays the missing events.
    const again = await connectAndSync(owner.api, g.id, 'view');
    expect(again.revision).toBe(3);
    const before = again.messages.length;
    again.send({ type: 'resync', fromRevision: 1 });
    await again.waitFor((m) => m.type === 'ops' && m.revision === 3, 3000, false);
    const replayed = again.messages.slice(before).filter((m) => m.type === 'ops').map((m) => m.revision);
    expect(replayed).toEqual([2, 3]);

    // Explicit snapshot request.
    again.send({ type: 'resync' });
    const snap = await again.waitFor((m) => m.type === 'snapshot' && m.reason === 'requested', 3000, false);
    expect(snap.revision).toBe(3);
    again.close();
  });

  it('falls back to a snapshot when the gap is outside the replay window', async () => {
    const small = await startServer((c) => (c.limits.eventReplayWindow = 2));
    try {
      const owner = await registerUser(small.base, 'Owner');
      const g = await createGallery(owner.api);
      for (let i = 0; i < 4; i++)
        await owner.api.post(`/v1/galleries/${g.id}/actions`, action(i, [{ op: 'node.setText', nodeId: 'label-welcome', text: `v${i}` }]));
      const ev = await owner.api.get(`/v1/galleries/${g.id}/events?after=0`);
      expect(ev.body).toMatchObject({ complete: false, currentRevision: 4, events: [] });
    } finally {
      await small.close();
    }
  });
});

describe('realtime authorization', () => {
  it('rejects writes on view connections, even from an owner account', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const view = await connectAndSync(owner.api, g.id, 'view');
    view.send({ type: 'submit', clientMsgId: 'x', action: action(0, [{ op: 'node.setVisibility', nodeId: 'wall-north', visible: false }]) });
    const err = await view.waitFor((m) => m.type === 'error' && m.clientMsgId === 'x');
    expect(err.code).toBe('FORBIDDEN');
    expect((await sceneOf(owner.api, g.id)).revision).toBe(0);
    view.close();
  });

  it('viewer members cannot get edit tickets; tickets are single use', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const viewer = await registerUser(srv.base, 'Viewer');
    const g = await createGallery(owner.api);
    await addMember(srv.db, g.id, viewer.id, 'viewer');
    expect((await viewer.api.post(`/v1/galleries/${g.id}/realtime-tickets`, { capability: 'edit' })).status).toBe(403);

    const t = await viewer.api.post(`/v1/galleries/${g.id}/realtime-tickets`, { capability: 'view' });
    const first = await openLive(t.body.url);
    await first.waitFor((m) => m.type === 'snapshot');
    const second = await openLive(t.body.url);
    expect((await second.waitClosed()).code).toBe(4001);
    first.close();
  });

  it('downgrading an editor removes write capability on the open connection immediately', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const editor = await registerUser(srv.base, 'Editor');
    const g = await createGallery(owner.api);
    await addMember(srv.db, g.id, editor.id, 'editor');
    const live = await connectAndSync(editor.api, g.id, 'edit');

    await addMember(srv.db, g.id, editor.id, 'viewer');
    // Even before the hub is told, the commit path rechecks the role in the transaction.
    live.send({ type: 'submit', clientMsgId: 'a', action: action(0, [{ op: 'node.setVisibility', nodeId: 'wall-north', visible: false }]) });
    const err = await live.waitFor((m) => m.type === 'error' && m.clientMsgId === 'a');
    expect(err.code).toBe('FORBIDDEN');
    const perm = await live.waitFor((m) => m.type === 'permissions');
    expect(perm).toMatchObject({ role: 'viewer', capability: 'view', canEdit: false });

    // Revocation closes the connection.
    await srv.db.query(`DELETE FROM gallery_members WHERE gallery_id = $1 AND user_id = $2`, [g.id, editor.id]);
    await srv.app.deps.hub.recheckGallery(g.id);
    expect((await live.waitClosed()).code).toBe(4403);
  });

  it('enforces per-gallery connection limits', async () => {
    const limited = await startServer((c) => (c.limits.maxViewerConnectionsPerGallery = 2));
    try {
      const owner = await registerUser(limited.base, 'Owner');
      const g = await createGallery(owner.api);
      const a = await connectAndSync(owner.api, g.id);
      const b = await connectAndSync(owner.api, g.id);
      const c = await connectLive(owner.api, g.id);
      expect((await c.waitClosed()).code).toBe(4029);
      a.close();
      b.close();
    } finally {
      await limited.close();
    }
  });
});

describe('hub backpressure (unit)', () => {
  it('closes a slow consumer instead of buffering without bound', () => {
    const closed: number[] = [];
    const fakeWs: any = { OPEN: 1, readyState: 1, bufferedAmount: 10_000_000, send() {}, close: (code: number) => closed.push(code), terminate() {} };
    const hub = new RealtimeHub({
      db: {} as any,
      eventsSince: async () => ({ currentRevision: 0, events: [], complete: true }),
      maxBufferedBytes: 1024,
      maxSyncBuffer: 3,
      log: { warn() {}, info() {} },
    });
    const conn = hub.register({ ws: fakeWs, galleryId: 'g', principal: { userId: null }, capability: 'view', role: 'viewer', lang: 'en' });
    conn.state = 'live';
    conn.lastRevision = 0;
    hub.publish({ type: 'ops', galleryId: 'g', revision: 1 } as any);
    expect(closed).toEqual([4008]);
    expect(hub.connectionCount('g')).toBe(0);

    // A connection still syncing has a bounded event buffer too.
    const conn2 = hub.register({ ws: { ...fakeWs, bufferedAmount: 0 }, galleryId: 'g', principal: { userId: null }, capability: 'view', role: 'viewer', lang: 'en' });
    for (let r = 1; r <= 4; r++) hub.publish({ type: 'ops', galleryId: 'g', revision: r } as any);
    expect(conn2.state).toBe('closed');
  });
});
