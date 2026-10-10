import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, createGallery, registerUser, startServer, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => srv?.close());

describe('contracts and capabilities', () => {
  it('describes node types, fields with bounds, operations and languages', async () => {
    const r = await client(srv.base).get('/v1/capabilities');
    expect(r.status).toBe(200);
    const c = r.body;
    expect(Object.keys(c.nodeTypes)).toEqual(['room', 'wall', 'floor', 'ceiling', 'primitive', 'artwork', 'text', 'group', 'light']);
    const roomWidth = c.nodeTypes.room.fields.find((f: any) => f.path === 'props.width');
    expect(roomWidth).toMatchObject({ type: 'number', min: 1, max: 200 });
    const frameColor = c.nodeTypes.artwork.fields.find((f: any) => f.path === 'props.frame.color');
    expect(frameColor.type).toBe('color');
    const lightType = c.nodeTypes.light.fields.find((f: any) => f.path === 'props.lightType');
    expect(lightType).toMatchObject({ type: 'enum', enum: ['ambient', 'directional', 'point', 'spot'] });
    expect(c.operations.map((o: any) => o.name)).toContain('scene.setViewerAnchor');
    expect(c.languages).toEqual(['en', 'ht', 'fr', 'es', 'ko']);
    // Without a live smoke test nothing is claimed as verified.
    expect(c.assistant.languages.ht.spokenReplies).toBe('unverified');
    expect(c.assistant.enabled).toBe(false);
    expect(c.roles.viewerSession.canEdit).toBe(false);
  });

  it('reports the caller role and allowed operations per gallery', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const r = await owner.api.get(`/v1/galleries/${g.id}/capabilities`);
    expect(r.body).toMatchObject({ role: 'owner', canEdit: true, canManage: true, canUseAssistant: false });
    expect(r.body.allowedOperations.length).toBeGreaterThan(10);
  });

  it('serves JSON Schemas and a complete OpenAPI document', async () => {
    const anon = client(srv.base);
    expect((await anon.get('/v1/schemas/scene')).body.properties.nodes).toBeTruthy();
    expect((await anon.get('/v1/schemas/node/artwork')).body.properties.props).toBeTruthy();
    const oa = await anon.get('/openapi.json');
    expect(oa.status).toBe(200);
    const paths = Object.keys(oa.body.paths);
    for (const p of ['/v1/galleries/{galleryId}/actions', '/v1/galleries/{galleryId}/undo', '/v1/links/resolve', '/v1/assistant/conversations/{conversationId}/voice-commands', '/v1/capabilities'])
      expect(paths).toContain(p);
  });
});
