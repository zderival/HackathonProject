import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { action, addMember, createGallery, registerUser, startServer, testImage, upload, type TestServer } from './helpers.js';

let srv: TestServer;

const testLimits = (c: Parameters<Parameters<typeof startServer>[0] & {}>[0]) => {
  c.limits.maxUploadBytes = 2 * 1024 * 1024;
  c.limits.maxImagePixels = 30_000_000;
};

beforeAll(async () => {
  srv = await startServer(testLimits);
});
afterAll(async () => srv?.close());

describe('core path: upload -> place -> save -> reload after restart', () => {
  it('persists placed artwork across a service restart', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api, 'Persistence');

    const up = await upload(owner.api, g.id, await testImage(1200, 800, 'jpeg'), 'photo.jpg', 'Harbor');
    expect(up.status).toBe(201);
    expect(up.body.width).toBe(1200);
    expect(up.body.originalFormat).toBe('jpeg');
    const names = up.body.variants.map((v: any) => `${v.name}.${v.format}`);
    expect(names).toEqual(expect.arrayContaining(['original.jpeg', 'thumb.webp', 'medium.webp', 'medium.jpeg', 'large.webp', 'large.jpeg']));

    const r = await owner.api.post(
      `/v1/galleries/${g.id}/actions`,
      action(0, [
        { op: 'artwork.place', nodeId: 'art-harbor', assetId: up.body.id, parentId: 'wall-north', width: 1.5 },
        { op: 'artwork.setFrame', nodeId: 'art-harbor', frame: { color: '#000000', style: 'modern' } },
      ]),
    );
    expect(r.status).toBe(200);
    expect(r.body.revision).toBe(1);

    // Restart: close the whole service (HTTP server + pool), start a new instance.
    await srv.close();
    srv = await startServer(testLimits);
    const owner2 = (await import('./helpers.js')).client(srv.base, owner.tokens.accessToken);

    const scene = await owner2.get(`/v1/galleries/${g.id}/scene`);
    expect(scene.status).toBe(200);
    expect(scene.body.revision).toBe(1);
    const art = scene.body.scene.nodes['art-harbor'];
    expect(art.parentId).toBe('wall-north');
    expect(art.props).toMatchObject({ assetId: up.body.id, width: 1.5, height: 1, frame: { color: '#000000', style: 'modern' } });

    // The asset is still retrievable through fresh signed URLs.
    const manifest = await owner2.get(`/v1/assets/${up.body.id}`);
    expect(manifest.status).toBe(200);
    const medium = manifest.body.variants.find((v: any) => v.name === 'medium' && v.format === 'jpeg');
    const img = await fetch(medium.url);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
  });
});

describe('atomic batches, conflicts and idempotency', () => {
  it('rejects a stale revision from a second editor without losing the first edit', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const editor = await registerUser(srv.base, 'Editor');
    const g = await createGallery(owner.api);
    await addMember(srv.db, g.id, editor.id, 'editor');

    const a = await owner.api.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setMaterial', nodeId: 'wall-north', material: { color: '#111111' } }]));
    expect(a.status).toBe(200);
    const b = await editor.api.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setMaterial', nodeId: 'wall-north', material: { color: '#222222' } }]));
    expect(b.status).toBe(409);
    expect(b.body.error).toMatchObject({ code: 'REVISION_CONFLICT', details: { baseRevision: 0, currentRevision: 1 } });

    let scene = (await owner.api.get(`/v1/galleries/${g.id}/scene`)).body;
    expect(scene.scene.nodes['wall-north'].props.material.color).toBe('#111111');

    // Documented recovery: reload, rebase, resubmit with a new requestId.
    const retry = await editor.api.post(`/v1/galleries/${g.id}/actions`, action(scene.revision, [{ op: 'node.setMaterial', nodeId: 'wall-south', material: { color: '#222222' } }]));
    expect(retry.status).toBe(200);
    scene = (await owner.api.get(`/v1/galleries/${g.id}/scene`)).body;
    expect(scene.scene.nodes['wall-north'].props.material.color).toBe('#111111');
    expect(scene.scene.nodes['wall-south'].props.material.color).toBe('#222222');
  });

  it('merge mode accepts stale edits to different properties and rejects overlapping ones', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    await owner.api.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setTransform', nodeId: 'label-welcome', position: [0, 1, 0.1] }]));

    const other = await owner.api.post(
      `/v1/galleries/${g.id}/actions`,
      action(0, [{ op: 'node.setMaterial', nodeId: 'wall-east', material: { color: '#abcdef' } }], { conflictMode: 'merge' }),
    );
    expect(other.status).toBe(200);
    expect(other.body.revision).toBe(2);

    const overlapping = await owner.api.post(
      `/v1/galleries/${g.id}/actions`,
      action(0, [{ op: 'node.setTransform', nodeId: 'label-welcome', position: [1, 1, 0.1] }], { conflictMode: 'merge' }),
    );
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error.details).toMatchObject({ conflictingRevision: 1 });
  });

  it('applies all ops or none', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const r = await owner.api.post(
      `/v1/galleries/${g.id}/actions`,
      action(0, [
        { op: 'node.setMaterial', nodeId: 'wall-north', material: { color: '#000000' } },
        { op: 'node.remove', nodeId: 'does-not-exist' },
      ]),
    );
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'INVALID_REFERENCE', details: { opIndex: 1 } });
    const scene = (await owner.api.get(`/v1/galleries/${g.id}/scene`)).body;
    expect(scene.revision).toBe(0);
    expect(scene.scene.nodes['wall-north'].props.material.color).not.toBe('#000000');
  });

  it('never applies a duplicate request twice, even concurrently', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const req = action(0, [{ op: 'node.duplicate', nodeId: 'label-welcome', offset: [0, -0.3, 0] }]);

    const results = await Promise.all([1, 2, 3].map(() => owner.api.post(`/v1/galleries/${g.id}/actions`, req)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => !r.body.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.revision))).toEqual(new Set([1]));

    const again = await owner.api.post(`/v1/galleries/${g.id}/actions`, req);
    expect(again.body).toMatchObject({ duplicate: true, revision: 1 });

    const scene = (await owner.api.get(`/v1/galleries/${g.id}/scene`)).body;
    const labels = Object.values(scene.scene.nodes).filter((n: any) => n.type === 'text');
    expect(labels).toHaveLength(2);

    const mismatch = await owner.api.post(`/v1/galleries/${g.id}/actions`, { ...req, ops: [{ op: 'node.remove', nodeId: 'label-welcome' }] });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');

    const history = await owner.api.get(`/v1/galleries/${g.id}/actions`);
    expect(history.body.items).toHaveLength(1);
  });

  it('rejects invalid scene graphs and malicious inputs with structured errors', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const post = (ops: any[]) => owner.api.post(`/v1/galleries/${g.id}/actions`, action(0, ops));

    const cycle = await post([{ op: 'node.reparent', nodeId: 'room-main', parentId: 'label-welcome' }]);
    expect(cycle.status).toBe(422);
    expect(cycle.body.error.code).toBe('INVALID_SCENE');
    expect(JSON.stringify(cycle.body.error.details)).toMatch(/cycle/);

    const unknownProp = await post([{ op: 'node.update', nodeId: 'wall-north', set: { 'props.script': 'alert(1)' } }]);
    expect(unknownProp.status).toBe(422);

    const badPath = await post([{ op: 'node.update', nodeId: 'wall-north', set: { 'props.__proto__.x': 1 } }]);
    expect(badPath.status).toBe(400);

    const hugeNumber = await post([{ op: 'node.setTransform', nodeId: 'wall-north', position: [1e300, 0, 0] }]);
    expect(hugeNumber.status).toBe(400);

    const unknownOp = await post([{ op: 'eval', code: 'process.exit()' }]);
    expect(unknownOp.status).toBe(400);

    const badType = await post([{ op: 'node.add', node: { type: 'script' } }]);
    expect(badType.status).toBe(400);

    const tooManyNodes = await post(Array.from({ length: 201 }, () => ({ op: 'node.add', node: { type: 'group' } })));
    expect(tooManyNodes.status).toBe(400);

    const scene = (await owner.api.get(`/v1/galleries/${g.id}/scene`)).body;
    expect(scene.revision).toBe(0);
  });
});

describe('uploads', () => {
  it('validates real content, formats and limits', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);

    for (const fmt of ['png', 'jpeg', 'webp'] as const) {
      const r = await upload(owner.api, g.id, await testImage(300, 500, fmt), `x.${fmt}`);
      expect(r.status, fmt).toBe(201);
      expect(r.body.aspectRatio).toBe(0.6);
    }

    // Text disguised as a PNG.
    const fake = await upload(owner.api, g.id, Buffer.from('<?php system($_GET["c"]); ?>'), 'evil.png');
    expect(fake.status).toBe(415);

    // GIF is decodable but unsupported.
    const sharp = (await import('sharp')).default;
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
    expect((await upload(owner.api, g.id, gif, 'a.gif')).status).toBe(415);

    // Over the byte limit (2 MiB in this test server).
    const big = Buffer.concat([await testImage(10, 10, 'png'), Buffer.alloc(3 * 1024 * 1024)]);
    expect((await upload(owner.api, g.id, big, 'big.png')).status).toBe(413);

    // Over the pixel limit (30 MP here): small file, huge dimensions.
    const huge = await sharp({ create: { width: 8000, height: 5000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    expect((await upload(owner.api, g.id, huge, 'huge.png')).status).toBe(413);

    const list = await owner.api.get(`/v1/galleries/${g.id}/assets`);
    expect(list.body.items).toHaveLength(3);
  });

  it('does not allow placing an asset from another gallery', async () => {
    const a = await registerUser(srv.base, 'A');
    const ga = await createGallery(a.api);
    const gb = await createGallery(a.api);
    const up = await upload(a.api, ga.id, await testImage());
    const r = await a.api.post(`/v1/galleries/${gb.id}/actions`, action(0, [{ op: 'artwork.place', assetId: up.body.id }]));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_REFERENCE');
    // Setting it directly on an artwork node is caught by reference validation too.
    const r2 = await a.api.post(
      `/v1/galleries/${gb.id}/actions`,
      action(0, [{ op: 'node.add', node: { id: 'p', type: 'artwork', props: { assetId: up.body.id } } }]),
    );
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe('INVALID_REFERENCE');
  });
});

describe('authorization', () => {
  it('blocks viewers and outsiders from writing, and outsiders from reading', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const viewer = await registerUser(srv.base, 'Viewer');
    const outsider = await registerUser(srv.base, 'Outsider');
    const g = await createGallery(owner.api);
    await addMember(srv.db, g.id, viewer.id, 'viewer');
    const ops = action(0, [{ op: 'node.setVisibility', nodeId: 'wall-north', visible: false }]);

    expect((await viewer.api.get(`/v1/galleries/${g.id}/scene`)).status).toBe(200);
    const vw = await viewer.api.post(`/v1/galleries/${g.id}/actions`, ops);
    expect(vw.status).toBe(403);
    expect(vw.body.error.code).toBe('FORBIDDEN');
    expect((await upload(viewer.api, g.id, await testImage())).status).toBe(403);

    // Outsiders get 404 so gallery IDs cannot be probed.
    expect((await outsider.api.get(`/v1/galleries/${g.id}/scene`)).status).toBe(404);
    expect((await outsider.api.post(`/v1/galleries/${g.id}/actions`, ops)).status).toBe(404);
    expect((await outsider.api.get(`/v1/galleries/${g.id}/events?after=0`)).status).toBe(404);

    const anon = (await import('./helpers.js')).client(srv.base);
    expect((await anon.get(`/v1/galleries/${g.id}/scene`)).status).toBe(404);
    expect((await anon.post(`/v1/galleries/${g.id}/actions`, ops)).status).toBe(401);
    expect((await (await import('./helpers.js')).client(srv.base, 'at_forged').get('/v1/auth/me')).status).toBe(401);
  });

  it('a viewer session from an editor account is still read-only', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const other = await createGallery(owner.api);
    const vs = await owner.api.post(`/v1/galleries/${g.id}/viewer-sessions`, { kind: 'viewer' });
    expect(vs.status).toBe(201);
    const phone = (await import('./helpers.js')).client(srv.base, vs.body.viewerToken);

    expect((await phone.get(`/v1/galleries/${g.id}/scene`)).status).toBe(200);
    const access = await phone.get(`/v1/galleries/${g.id}/access`);
    expect(access.body).toMatchObject({ role: 'owner', readOnlySession: true, capabilities: { canEdit: false, canManage: false } });

    expect((await phone.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setVisibility', nodeId: 'wall-north', visible: false }]))).status).toBe(401);
    expect((await phone.post(`/v1/galleries/${g.id}/realtime-tickets`, { capability: 'edit' })).status).toBe(401);
    expect((await upload(phone, g.id, await testImage())).status).toBe(401);
    // Scoped to one gallery.
    expect((await phone.get(`/v1/galleries/${other.id}/scene`)).status).toBe(404);
  });

  it('localizes error messages', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const stale = action(5, [{ op: 'node.setVisibility', nodeId: 'wall-north', visible: false }]);
    for (const [lang, expected] of [
      ['ht', 'Demann lan pa valab.'],
      ['ko', '요청이 올바르지 않습니다.'],
      ['fr-CA', "La requête n'est pas valide."],
    ]) {
      const r = await owner.api.post(`/v1/galleries/${g.id}/actions`, stale, { 'accept-language': lang });
      expect(r.body.error.message).toBe(expected);
      expect(r.body.error.requestId).toBeTruthy();
    }
  });
});

it('refresh tokens rotate and logout revokes', async () => {
  const u = await registerUser(srv.base, 'Rotator');
  const anon = (await import('./helpers.js')).client(srv.base);
  const r1 = await anon.post('/v1/auth/refresh', { refreshToken: u.tokens.refreshToken });
  expect(r1.status).toBe(200);
  expect((await anon.post('/v1/auth/refresh', { refreshToken: u.tokens.refreshToken })).status).toBe(401);
  const api = (await import('./helpers.js')).client(srv.base, r1.body.tokens.accessToken);
  expect((await api.get('/v1/auth/me')).status).toBe(200);
  expect((await api.post('/v1/auth/logout')).status).toBe(204);
  expect((await api.get('/v1/auth/me')).status).toBe(401);
  expect(randomUUID()).toBeTruthy();
});
