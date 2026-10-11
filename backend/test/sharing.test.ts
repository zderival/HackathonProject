import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { action, addMember, client, connectAndSync, createGallery, registerUser, startServer, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => srv?.close());

const linkOf = (url: string) => new URL(url).searchParams.get('link')!;

describe('sharing modes and links', () => {
  it('view link: link holders can read but not write; restricted mode cuts them off', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const anon = client(srv.base);

    let share = await owner.api.get(`/v1/galleries/${g.id}/sharing`);
    expect(share.body).toMatchObject({ sharingMode: 'restricted', viewUrl: null, editJoinUrl: null });
    // Phones open the mobile-browser viewer; the editor lives at /g/.
    expect(share.body.galleryUrl).toMatch(new RegExp(`/view/${g.id}$`));
    expect(share.body.editorUrl).toMatch(new RegExp(`/g/${g.id}$`));
    // Restricted: the gallery deep link alone grants nothing.
    const plain = await anon.get(`/v1/links/resolve?url=${encodeURIComponent(share.body.galleryUrl)}`);
    expect(plain.body).toMatchObject({ next: 'sign_in', gallery: null });

    share = await owner.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'view_link' });
    const viewUrl = share.body.viewUrl as string;
    expect(viewUrl).toMatch(new RegExp(`/view/${g.id}\\?link=gv_`));
    // Older /g/{id}?link= links still resolve.
    expect((await anon.get(`/v1/links/resolve?url=${encodeURIComponent(viewUrl.replace('/view/', '/g/'))}`)).body.next).toBe('open');
    const resolved = await anon.get(`/v1/links/resolve?url=${encodeURIComponent(viewUrl)}`);
    expect(resolved.body).toMatchObject({ next: 'open', galleryId: g.id, access: { role: 'viewer', via: 'link', canEdit: false } });

    // Phone flow: anonymous viewer session via the link, then live subscription.
    const link = linkOf(viewUrl);
    const vs = await anon.post(`/v1/galleries/${g.id}/viewer-sessions`, {}, { 'x-gallery-link': link });
    expect(vs.status).toBe(201);
    const phone = client(srv.base, vs.body.viewerToken);
    expect((await phone.get(`/v1/galleries/${g.id}/scene`)).status).toBe(200);
    const live = await connectAndSync(phone, g.id, 'view');
    expect((await client(srv.base, undefined, { 'x-gallery-link': link }).post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setVisibility', nodeId: 'light-key', visible: false }]))).status).toBe(401);

    // Going restricted revokes link-based access immediately, including the open socket.
    await owner.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'restricted' });
    expect((await live.waitClosed()).code).toBe(4403);
    expect((await phone.get(`/v1/galleries/${g.id}/scene`)).status).toBe(404);
    const stale = await anon.get(`/v1/links/resolve?url=${encodeURIComponent(viewUrl)}`);
    expect(stale.status).toBe(410);
    expect(stale.body.error.code).toBe('LINK_DISABLED');
  });

  it('rotating the view link invalidates old QR codes but not explicit members', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const member = await registerUser(srv.base, 'Member');
    const g = await createGallery(owner.api);
    await owner.api.put(`/v1/galleries/${g.id}/members/${member.id}`, { role: 'viewer' });
    const before = (await owner.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'view_link' })).body.viewUrl;
    const after = (await owner.api.post(`/v1/galleries/${g.id}/sharing/rotate`, { links: 'view' })).body.viewUrl;
    expect(after).not.toBe(before);
    const anon = client(srv.base);
    expect((await anon.get(`/v1/links/resolve?url=${encodeURIComponent(before)}`)).status).toBe(410);
    expect((await anon.get(`/v1/links/resolve?url=${encodeURIComponent(after)}`)).body.next).toBe('open');
    // The member still opens the old QR (their access does not come from the link).
    expect((await member.api.get(`/v1/links/resolve?url=${encodeURIComponent(before)}`)).body).toMatchObject({ next: 'open', access: { via: 'member' } });

    const qr = await fetch(`${srv.base}/v1/galleries/${g.id}/qr?format=svg`, { headers: { authorization: `Bearer ${owner.tokens.accessToken}` } });
    expect(qr.headers.get('content-type')).toContain('image/svg+xml');
    expect(qr.headers.get('x-link-url')).toBe(after);
    expect(await qr.text()).toContain('<svg');
    const png = await fetch(`${srv.base}/v1/galleries/${g.id}/qr?format=png`, { headers: { authorization: `Bearer ${owner.tokens.accessToken}` } });
    expect(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
  });

  it('edit link: requires sign-in, grants editor access only while the link stays active', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const joiner = await registerUser(srv.base, 'Joiner');
    const g = await createGallery(owner.api);
    const share = (await owner.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'edit_link' })).body;
    const link = linkOf(share.editJoinUrl);

    expect((await client(srv.base).get(`/v1/links/resolve?url=${encodeURIComponent(share.editJoinUrl)}`)).body.next).toBe('sign_in');
    expect((await client(srv.base).post(`/v1/galleries/${g.id}/join`, { link })).status).toBe(401);
    expect((await joiner.api.get(`/v1/links/resolve?url=${encodeURIComponent(share.editJoinUrl)}`)).body.next).toBe('join_as_editor');

    const joined = await joiner.api.post(`/v1/galleries/${g.id}/join`, { link });
    expect(joined.body).toMatchObject({ role: 'editor', via: 'link_member' });
    const live = await connectAndSync(joiner.api, g.id, 'edit');
    expect((await joiner.api.post(`/v1/galleries/${g.id}/actions`, action(0, [{ op: 'node.setVisibility', nodeId: 'light-key', visible: false }]))).status).toBe(200);

    // Rotating the edit link suspends the link membership at once.
    await owner.api.post(`/v1/galleries/${g.id}/sharing/rotate`, { links: 'edit' });
    expect((await live.waitClosed()).code).toBe(4403);
    expect((await joiner.api.post(`/v1/galleries/${g.id}/actions`, action(1, [{ op: 'node.setVisibility', nodeId: 'light-key', visible: true }]))).status).toBe(404);
    expect((await joiner.api.post(`/v1/galleries/${g.id}/join`, { link })).status).toBe(410);
    const members = (await owner.api.get(`/v1/galleries/${g.id}/members`)).body.items;
    expect(members.find((m: any) => m.userId === joiner.id)).toMatchObject({ source: 'link', active: false });

    // Leaving and re-entering edit_link mode does not resurrect the old membership.
    const fresh = (await owner.api.post(`/v1/galleries/${g.id}/sharing/rotate`, { links: 'edit' })).body;
    await owner.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'restricted' });
    await owner.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'edit_link' });
    expect((await joiner.api.post(`/v1/galleries/${g.id}/join`, { link: linkOf(fresh.editJoinUrl) })).status).toBe(410);
  });

  it('explicit membership outranks link access and survives restriction', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const editor = await registerUser(srv.base, 'Editor');
    const g = await createGallery(owner.api);
    await owner.api.put(`/v1/galleries/${g.id}/members/${editor.id}`, { role: 'editor' });
    await owner.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'restricted' });
    expect((await editor.api.get(`/v1/galleries/${g.id}/access`)).body).toMatchObject({ role: 'editor', via: 'member' });
  });
});

describe('members and invitations', () => {
  it('invites by username; only that account can accept, once, before expiry', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const invitee = await registerUser(srv.base, 'Invitee');
    const stranger = await registerUser(srv.base, 'Stranger');
    const g = await createGallery(owner.api);
    const inv = await owner.api.post(`/v1/galleries/${g.id}/invitations`, { username: invitee.username.toUpperCase(), role: 'editor' });
    expect(inv.status).toBe(201);
    expect(inv.body.url).toContain(`/invite/${inv.body.token}`);
    expect((await client(srv.base).get(`/v1/invitations/${inv.body.token}`)).body).toMatchObject({ galleryId: g.id, role: 'editor' });

    expect((await stranger.api.post('/v1/invitations/accept', { token: inv.body.token })).status).toBe(403);
    const ok = await invitee.api.post('/v1/invitations/accept', { token: inv.body.token });
    expect(ok.body).toMatchObject({ galleryId: g.id, role: 'editor' });
    expect((await invitee.api.post('/v1/invitations/accept', { token: inv.body.token })).status).toBe(410);
    expect((await invitee.api.get('/v1/galleries')).body.items.map((x: any) => x.id)).toContain(g.id);

    const expired = await owner.api.post(`/v1/galleries/${g.id}/invitations`, { username: stranger.username, role: 'viewer' });
    await srv.db.query(`UPDATE gallery_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired.body.id]);
    expect((await stranger.api.post('/v1/invitations/accept', { token: expired.body.token })).status).toBe(410);
  });

  it('only the owner manages permissions; downgrades and revocations apply live', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const editor = await registerUser(srv.base, 'Editor');
    const g = await createGallery(owner.api);
    await owner.api.put(`/v1/galleries/${g.id}/members/${editor.id}`, { role: 'editor' });

    expect((await editor.api.put(`/v1/galleries/${g.id}/members/${editor.id}`, { role: 'editor' })).status).toBe(403);
    expect((await editor.api.put(`/v1/galleries/${g.id}/sharing`, { mode: 'view_link' })).status).toBe(403);
    expect((await editor.api.post(`/v1/galleries/${g.id}/invitations`, { username: 'someone', role: 'editor' })).status).toBe(403);
    expect((await editor.api.post(`/v1/galleries/${g.id}/members`, { username: editor.username, role: 'editor' })).status).toBe(403);

    const live = await connectAndSync(editor.api, g.id, 'edit');
    await owner.api.put(`/v1/galleries/${g.id}/members/${editor.id}`, { role: 'viewer' });
    const perm = await live.waitFor((m) => m.type === 'permissions');
    expect(perm).toMatchObject({ role: 'viewer', canEdit: false });
    live.send({ type: 'submit', clientMsgId: 'x', action: action(0, [{ op: 'node.setVisibility', nodeId: 'light-key', visible: false }]) });
    expect((await live.waitFor((m) => m.type === 'error' && m.clientMsgId === 'x')).code).toBe('FORBIDDEN');

    await owner.api.del(`/v1/galleries/${g.id}/members/${editor.id}`);
    expect((await live.waitClosed()).code).toBe(4403);
    expect((await editor.api.get(`/v1/galleries/${g.id}/scene`)).status).toBe(404);
  });

  it('enforces the editor limit', async () => {
    const limited = await startServer((c) => (c.limits.maxEditorsPerGallery = 1));
    try {
      const owner = await registerUser(limited.base, 'Owner');
      const a = await registerUser(limited.base, 'A');
      const b = await registerUser(limited.base, 'B');
      const g = await createGallery(owner.api);
      expect((await owner.api.put(`/v1/galleries/${g.id}/members/${a.id}`, { role: 'editor' })).status).toBe(200);
      const r = await owner.api.put(`/v1/galleries/${g.id}/members/${b.id}`, { role: 'editor' });
      expect(r.body.error.code).toBe('LIMIT_EXCEEDED');
      expect((await owner.api.put(`/v1/galleries/${g.id}/members/${b.id}`, { role: 'viewer' })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('phone pairing and viewer sessions', () => {
  it('website preview -> QR pairing code -> phone viewer token, single use, revocable', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const g = await createGallery(owner.api);
    const other = await createGallery(owner.api);
    const preview = await owner.api.post(`/v1/galleries/${g.id}/viewer-sessions`, { kind: 'preview' });
    expect(preview.body).toMatchObject({ kind: 'preview', viewerToken: null });
    expect(preview.body.pairingUrl).toContain(`/p/${preview.body.pairingCode}`);

    const qr = await fetch(`${srv.base}${preview.body.qrSvgPath}`, { headers: { authorization: `Bearer ${owner.tokens.accessToken}` } });
    expect(qr.status).toBe(200);
    expect(qr.headers.get('x-link-url')).toBe(preview.body.pairingUrl);

    const anon = client(srv.base);
    expect((await anon.get(`/v1/links/resolve?url=${encodeURIComponent(preview.body.pairingUrl)}`)).body.next).toBe('claim_pairing');
    const claim = await anon.post('/v1/pairings/claim', { code: preview.body.pairingCode });
    expect(claim.status).toBe(200);
    expect((await anon.post('/v1/pairings/claim', { code: preview.body.pairingCode })).status).toBe(410);

    const phone = client(srv.base, claim.body.viewerToken);
    expect((await phone.get(`/v1/galleries/${g.id}/scene`)).status).toBe(200);
    expect((await phone.get(`/v1/galleries/${other.id}/scene`)).status).toBe(404);
    expect((await phone.post(`/v1/galleries/${g.id}/undo`, { requestId: 'phone-undo-1' })).status).toBe(401);

    const live = await connectAndSync(phone, g.id, 'view');
    expect((await owner.api.del(`/v1/viewer-sessions/${claim.body.viewerSessionId}`)).status).toBe(204);
    expect((await live.waitClosed()).code).toBe(4403);
    expect((await phone.get(`/v1/galleries/${g.id}/scene`)).status).toBe(401);
  });
});
