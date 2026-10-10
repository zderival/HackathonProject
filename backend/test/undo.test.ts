import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { action, addMember, connectAndSync, createGallery, registerUser, startServer, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => srv?.close());

const scene = async (api: any, id: string) => (await api.get(`/v1/galleries/${id}/scene`)).body;
const undo = (api: any, id: string, extra: Record<string, unknown> = {}) => api.post(`/v1/galleries/${id}/undo`, { requestId: randomUUID(), ...extra });
const redo = (api: any, id: string) => api.post(`/v1/galleries/${id}/redo`, { requestId: randomUUID() });

async function setup() {
  const owner = await registerUser(srv.base, 'Owner');
  const editor = await registerUser(srv.base, 'Editor');
  const g = await createGallery(owner.api);
  await addMember(srv.db, g.id, editor.id, 'editor');
  return { owner, editor, g };
}

describe('undo / redo', () => {
  it('undoes a multi-op batch as one step and redoes it, each as a broadcast revision', async () => {
    const { owner, g } = await setup();
    const viewer = await connectAndSync(owner.api, g.id, 'view');
    const r1 = await owner.api.post(
      `/v1/galleries/${g.id}/actions`,
      action(0, [
        { op: 'node.add', node: { id: 'box1', type: 'primitive', parentId: 'room-main', transform: { position: [1, 0.5, 0] } } },
        { op: 'node.setMaterial', nodeId: 'wall-north', material: { color: '#000000' } },
      ], { label: 'Add box, paint wall' }),
    );
    expect(r1.status).toBe(200);

    const u = await undo(owner.api, g.id);
    expect(u.status).toBe(200);
    expect(u.body.revision).toBe(2);
    let s = await scene(owner.api, g.id);
    expect(s.scene.nodes.box1).toBeUndefined();
    expect(s.scene.nodes['wall-north'].props.material.color).toBe('#f2f0eb');

    await viewer.waitForRevision(2);
    const ev = viewer.messages.find((m) => m.type === 'ops' && m.revision === 2);
    expect(ev).toMatchObject({ source: 'undo', undoOf: 1, label: 'Undo: Add box, paint wall' });
    expect(viewer.scene.nodes.box1).toBeUndefined();

    const rd = await redo(owner.api, g.id);
    expect(rd.status).toBe(200);
    s = await scene(owner.api, g.id);
    expect(s.scene.nodes.box1).toBeTruthy();
    expect(s.scene.nodes['wall-north'].props.material.color).toBe('#000000');
    await viewer.waitForRevision(3);
    expect(viewer.scene.nodes.box1.transform.position).toEqual([1, 0.5, 0]);

    // Undo history is per actor and an empty stack is reported, not ignored.
    expect((await undo(owner.api, g.id)).status).toBe(200); // undoes the redo
    expect((await undo(owner.api, g.id)).body.error.code).toBe('NOTHING_TO_UNDO');
    viewer.close();
  });

  it('a new edit clears the redo stack; retried undo requests apply once', async () => {
    const { owner, g } = await setup();
    await owner.api.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setVisibility', nodeId: 'light-key', visible: false }]));
    const requestId = randomUUID();
    const a = await owner.api.post(`/v1/galleries/${g.id}/undo`, { requestId });
    const b = await owner.api.post(`/v1/galleries/${g.id}/undo`, { requestId });
    expect(a.body.revision).toBe(2);
    expect(b.body).toMatchObject({ duplicate: true, revision: 2 });
    await owner.api.post(`/v1/galleries/${g.id}/actions`, action(2, [{ op: 'node.setText', nodeId: 'label-welcome', text: 'Hi' }]));
    expect((await redo(owner.api, g.id)).body.error.code).toBe('NOTHING_TO_REDO');
  });

  it("preserves an unrelated collaborator change and refuses an unsafe undo", async () => {
    const { owner, editor, g } = await setup();
    // Owner paints the north wall; editor then changes the floor (unrelated).
    await owner.api.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setMaterial', nodeId: 'wall-north', material: { color: '#112233' } }]));
    await editor.api.post(`/v1/galleries/${g.id}/actions`, action(1, [{ op: 'node.setMaterial', nodeId: 'floor-main', material: { color: '#445566' } }]));

    const u = await undo(owner.api, g.id);
    expect(u.status).toBe(200);
    let s = (await scene(owner.api, g.id)).scene;
    expect(s.nodes['wall-north'].props.material.color).toBe('#f2f0eb');
    expect(s.nodes['floor-main'].props.material.color).toBe('#445566'); // kept

    // Owner moves the light; the editor then moves the same light. Undo would overwrite it.
    await owner.api.post(`/v1/galleries/${g.id}/actions`, action(3, [{ op: 'node.setTransform', nodeId: 'light-key', position: [1, 3, 1] }]));
    await editor.api.post(`/v1/galleries/${g.id}/actions`, action(4, [{ op: 'node.setTransform', nodeId: 'light-key', position: [2, 3, 2] }]));
    const conflict = await undo(owner.api, g.id);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('UNDO_CONFLICT');
    expect(conflict.body.error.details.key).toBe('node/light-key/transform.position');
    s = (await scene(owner.api, g.id)).scene;
    expect(s.nodes['light-key'].transform.position).toEqual([2, 3, 2]);
    expect((await scene(owner.api, g.id)).revision).toBe(5);

    // The editor's own undo is safe and restores the owner's position.
    expect((await undo(editor.api, g.id)).status).toBe(200);
    expect((await scene(owner.api, g.id)).scene.nodes['light-key'].transform.position).toEqual([1, 3, 1]);
  });

  it('refuses to undo the addition of a node someone else has since edited', async () => {
    const { owner, editor, g } = await setup();
    await owner.api.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.add', node: { id: 'lbl', type: 'text', props: { text: 'A' } } }]));
    await editor.api.post(`/v1/galleries/${g.id}/actions`, action(1, [{ op: 'node.setText', nodeId: 'lbl', text: 'B' }]));
    const r = await undo(owner.api, g.id);
    expect(r.body.error.code).toBe('UNDO_CONFLICT');
    expect((await scene(owner.api, g.id)).scene.nodes.lbl.props.text).toBe('B');
  });

  it('viewers cannot undo', async () => {
    const { owner, g } = await setup();
    const viewer = await registerUser(srv.base, 'Viewer');
    await addMember(srv.db, g.id, viewer.id, 'viewer');
    await owner.api.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setVisibility', nodeId: 'light-key', visible: false }]));
    expect((await undo(viewer.api, g.id)).status).toBe(403);
  });
});
