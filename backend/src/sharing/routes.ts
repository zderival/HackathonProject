// Owner-controlled permissions: members, email invitations, sharing modes, share-link
// rotation, edit-link joining, link/QR resolution and phone pairing.
//
// Every change bumps galleries.access_version and re-evaluates open WebSockets, so a
// downgrade removes write capability immediately and a revocation stops live data.
import { Type } from 'typebox';
import type { App } from '../app.js';
import { withTransaction } from '../db/pool.js';
import { capabilitiesFor, countEditors, requireAccess, resolveAccess } from '../galleries/access.js';
import { principalFor, requireUser } from '../http/context.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { ErrorResponse, GalleryIdParams, SharingMode } from '../schemas/api.js';
import { editJoinLink, galleryLink, invitationLink, pairingLink, parseLink, renderQr } from './links.js';

const MemberRole = Type.Union([Type.Literal('editor'), Type.Literal('viewer')]);
const UserIdParams = Type.Object({ galleryId: Type.String({ format: 'uuid' }), userId: Type.String({ format: 'uuid' }) });

const SharingInfo = Type.Object({
  galleryId: Type.String(),
  sharingMode: SharingMode,
  linkVersion: Type.Integer({ description: 'Incremented whenever the edit link is rotated.' }),
  galleryUrl: Type.String({ description: 'Canonical deep link without a share token. Works only for signed-in members.' }),
  viewUrl: Type.Union([Type.String(), Type.Null()], { description: 'Link that grants view access (null in restricted mode).' }),
  editJoinUrl: Type.Union([Type.String(), Type.Null()], { description: 'Website link that lets signed-in users join as editors (edit_link mode only).' }),
});

const Member = Type.Object({
  userId: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  role: Type.Union([Type.Literal('owner'), MemberRole]),
  source: Type.Union([Type.Literal('owner'), Type.Literal('invite'), Type.Literal('direct'), Type.Literal('link')]),
  active: Type.Boolean({ description: 'False for link-derived members whose edit link was rotated or disabled.' }),
  createdAt: Type.String({ format: 'date-time' }),
});

const Invitation = Type.Object({
  id: Type.String(),
  email: Type.String(),
  role: MemberRole,
  expiresAt: Type.String({ format: 'date-time' }),
  createdAt: Type.String({ format: 'date-time' }),
});

export async function sharingRoutes(app: App) {
  const { db, hub, config } = app.deps;

  async function afterAccessChange(galleryId: string) {
    await db.query(`UPDATE galleries SET access_version = access_version + 1 WHERE id = $1`, [galleryId]);
    await hub.recheckGallery(galleryId);
  }

  async function sharingInfo(galleryId: string) {
    const { rows } = await db.query(
      `SELECT sharing_mode, view_link_token, edit_link_token, link_version FROM galleries WHERE id = $1`,
      [galleryId],
    );
    const g = rows[0];
    return {
      galleryId,
      sharingMode: g.sharing_mode,
      linkVersion: g.link_version,
      galleryUrl: galleryLink(config, galleryId),
      viewUrl: g.sharing_mode === 'restricted' ? null : galleryLink(config, galleryId, g.view_link_token),
      editJoinUrl: g.sharing_mode === 'edit_link' ? editJoinLink(config, galleryId, g.edit_link_token) : null,
    };
  }

  async function assertEditorSlot(galleryId: string, userId: string) {
    if ((await countEditors(db, galleryId, userId)) >= config.limits.maxEditorsPerGallery)
      throw new AppError('LIMIT_EXCEEDED', { maxEditorsPerGallery: config.limits.maxEditorsPerGallery });
  }

  // ---- Sharing mode and links (owner) -------------------------------------

  app.get(
    '/v1/galleries/:galleryId/sharing',
    { schema: { tags: ['sharing'], summary: 'Sharing mode and share links (owner)', params: GalleryIdParams, response: { 200: SharingInfo } } },
    async (req) => {
      requireUser(req);
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'manage');
      return sharingInfo(req.params.galleryId);
    },
  );

  app.put(
    '/v1/galleries/:galleryId/sharing',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Change sharing mode (owner)',
        description:
          'restricted: only the owner and explicit members. view_link: holders of the view link can view. edit_link: additionally, signed-in users who open the edit join link become link editors. Switching away from edit_link suspends every link editor; switching back does not restore them unless the edit link was not rotated meanwhile.',
        params: GalleryIdParams,
        body: Type.Object({ mode: SharingMode }, { additionalProperties: false }),
        response: { 200: SharingInfo },
      },
    },
    async (req) => {
      requireUser(req);
      const id = req.params.galleryId;
      await requireAccess(db, id, principalFor(req, id), 'manage');
      // Leaving edit_link rotates the edit link so old join links and link memberships
      // never silently come back when the mode is re-enabled.
      await db.query(
        `UPDATE galleries SET
           edit_link_token = CASE WHEN sharing_mode = 'edit_link' AND $2 <> 'edit_link' THEN $3 ELSE edit_link_token END,
           link_version = CASE WHEN sharing_mode = 'edit_link' AND $2 <> 'edit_link' THEN link_version + 1 ELSE link_version END,
           sharing_mode = $2, updated_at = now()
         WHERE id = $1`,
        [id, req.body.mode, randomToken('ge', 18)],
      );
      await afterAccessChange(id);
      return sharingInfo(id);
    },
  );

  app.post(
    '/v1/galleries/:galleryId/sharing/rotate',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Rotate share links (owner)',
        description:
          'Old links (and QR codes printed from them) stop granting access immediately; open viewer connections that relied on them are closed. Rotating the edit link also suspends all link editors (link_version changes).',
        params: GalleryIdParams,
        body: Type.Object({ links: Type.Union([Type.Literal('view'), Type.Literal('edit'), Type.Literal('both')]) }, { additionalProperties: false }),
        response: { 200: SharingInfo },
      },
    },
    async (req) => {
      requireUser(req);
      const id = req.params.galleryId;
      await requireAccess(db, id, principalFor(req, id), 'manage');
      const { links } = req.body;
      await db.query(
        `UPDATE galleries SET
           view_link_token = CASE WHEN $2 THEN $4 ELSE view_link_token END,
           edit_link_token = CASE WHEN $3 THEN $5 ELSE edit_link_token END,
           link_version = CASE WHEN $3 THEN link_version + 1 ELSE link_version END,
           updated_at = now()
         WHERE id = $1`,
        [id, links !== 'edit', links !== 'view', randomToken('gv', 18), randomToken('ge', 18)],
      );
      await afterAccessChange(id);
      return sharingInfo(id);
    },
  );

  // ---- Members (owner) ------------------------------------------------------

  app.get(
    '/v1/galleries/:galleryId/members',
    { schema: { tags: ['sharing'], summary: 'Members with roles (owner)', params: GalleryIdParams, response: { 200: Type.Object({ items: Type.Array(Member) }) } } },
    async (req) => {
      requireUser(req);
      const id = req.params.galleryId;
      await requireAccess(db, id, principalFor(req, id), 'manage');
      const { rows } = await db.query(
        `SELECT u.id AS user_id, u.email, u.display_name, 'owner' AS role, 'owner' AS source, true AS active, g.created_at
           FROM galleries g JOIN users u ON u.id = g.owner_id WHERE g.id = $1
         UNION ALL
         SELECT u.id, u.email, u.display_name, m.role, m.source,
                (m.source <> 'link' OR (g.sharing_mode = 'edit_link' AND m.link_version = g.link_version)), m.created_at
           FROM gallery_members m JOIN users u ON u.id = m.user_id JOIN galleries g ON g.id = m.gallery_id
          WHERE m.gallery_id = $1
         ORDER BY created_at`,
        [id],
      );
      return {
        items: rows.map((r) => ({
          userId: r.user_id,
          email: r.email,
          displayName: r.display_name,
          role: r.role,
          source: r.source,
          active: r.active,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    },
  );

  app.put(
    '/v1/galleries/:galleryId/members/:userId',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Grant or change a role directly (owner)',
        description: 'Makes the membership explicit (source "direct"), so it no longer depends on any share link. Takes effect on open connections immediately.',
        params: UserIdParams,
        body: Type.Object({ role: MemberRole }, { additionalProperties: false }),
        response: { 200: Member, 404: ErrorResponse },
      },
    },
    async (req) => {
      requireUser(req);
      const { galleryId, userId } = req.params;
      await requireAccess(db, galleryId, principalFor(req, galleryId), 'manage');
      const { rows: g } = await db.query(`SELECT owner_id FROM galleries WHERE id = $1`, [galleryId]);
      if (g[0].owner_id === userId) throw new AppError('VALIDATION_FAILED', { reason: "the owner's role cannot be changed" });
      const { rows: u } = await db.query(`SELECT id, email, display_name FROM users WHERE id = $1`, [userId]);
      if (!u[0]) throw new AppError('NOT_FOUND', { what: 'user' });
      if (req.body.role === 'editor') await assertEditorSlot(galleryId, userId);
      const { rows } = await db.query(
        `INSERT INTO gallery_members (gallery_id, user_id, role, source) VALUES ($1, $2, $3, 'direct')
         ON CONFLICT (gallery_id, user_id) DO UPDATE SET role = EXCLUDED.role, source = 'direct', link_version = NULL, updated_at = now()
         RETURNING created_at`,
        [galleryId, userId, req.body.role],
      );
      await afterAccessChange(galleryId);
      return {
        userId,
        email: u[0].email,
        displayName: u[0].display_name,
        role: req.body.role,
        source: 'direct' as const,
        active: true,
        createdAt: new Date(rows[0].created_at).toISOString(),
      };
    },
  );

  app.delete(
    '/v1/galleries/:galleryId/members/:userId',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Revoke a member (owner), or leave a gallery (yourself)',
        description: "Open connections of the removed user lose access immediately. Share-link access (view link) is separate: rotate links or switch to restricted to cut that too.",
        params: UserIdParams,
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const { galleryId, userId } = req.params;
      if (me.userId !== userId) await requireAccess(db, galleryId, principalFor(req, galleryId), 'manage');
      else await requireAccess(db, galleryId, principalFor(req, galleryId), 'view');
      const { rowCount } = await db.query(`DELETE FROM gallery_members WHERE gallery_id = $1 AND user_id = $2`, [galleryId, userId]);
      if (!rowCount) throw new AppError('NOT_FOUND', { what: 'member' });
      await afterAccessChange(galleryId);
      reply.code(204);
      return null;
    },
  );

  // ---- Email invitations ----------------------------------------------------

  app.post(
    '/v1/galleries/:galleryId/invitations',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Invite by email (owner)',
        description:
          'Returns a single-use invitation link for the frontend to share (no email is sent by the backend). Only an account with the invited email can accept it. Expires after INVITATION_TTL_HOURS.',
        params: GalleryIdParams,
        body: Type.Object({ email: Type.String({ format: 'email', maxLength: 254 }), role: MemberRole }, { additionalProperties: false }),
        response: { 201: Type.Intersect([Invitation, Type.Object({ url: Type.String(), token: Type.String() })]) },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const id = req.params.galleryId;
      await requireAccess(db, id, principalFor(req, id), 'manage');
      const token = randomToken('inv', 24);
      const expiresAt = new Date(Date.now() + config.auth.invitationTtlHours * 3600_000);
      const { rows } = await db.query(
        `INSERT INTO gallery_invitations (gallery_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [id, req.body.email.trim().toLowerCase(), req.body.role, sha256(token), me.userId, expiresAt],
      );
      reply.code(201);
      return {
        id: rows[0].id,
        email: req.body.email.trim().toLowerCase(),
        role: req.body.role,
        expiresAt: expiresAt.toISOString(),
        createdAt: new Date(rows[0].created_at).toISOString(),
        token,
        url: invitationLink(config, token),
      };
    },
  );

  app.get(
    '/v1/galleries/:galleryId/invitations',
    { schema: { tags: ['sharing'], summary: 'Pending invitations (owner)', params: GalleryIdParams, response: { 200: Type.Object({ items: Type.Array(Invitation) }) } } },
    async (req) => {
      requireUser(req);
      const id = req.params.galleryId;
      await requireAccess(db, id, principalFor(req, id), 'manage');
      const { rows } = await db.query(
        `SELECT id, email, role, expires_at, created_at FROM gallery_invitations
         WHERE gallery_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
        [id],
      );
      return {
        items: rows.map((r) => ({ id: r.id, email: r.email, role: r.role, expiresAt: r.expires_at.toISOString(), createdAt: r.created_at.toISOString() })),
      };
    },
  );

  app.delete(
    '/v1/galleries/:galleryId/invitations/:invitationId',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Revoke a pending invitation (owner)',
        params: Type.Object({ galleryId: Type.String({ format: 'uuid' }), invitationId: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      requireUser(req);
      const { galleryId, invitationId } = req.params;
      await requireAccess(db, galleryId, principalFor(req, galleryId), 'manage');
      await db.query(`UPDATE gallery_invitations SET revoked_at = now() WHERE id = $1 AND gallery_id = $2 AND accepted_at IS NULL`, [invitationId, galleryId]);
      reply.code(204);
      return null;
    },
  );

  app.get(
    '/v1/invitations/:token',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Preview an invitation (for the accept page)',
        params: Type.Object({ token: Type.String({ maxLength: 100 }) }),
        response: {
          200: Type.Object({
            galleryId: Type.String(),
            galleryTitle: Type.String(),
            role: MemberRole,
            email: Type.String(),
            invitedBy: Type.String(),
            expiresAt: Type.String(),
          }),
          410: ErrorResponse,
        },
      },
    },
    async (req) => {
      const { rows } = await db.query(
        `SELECT i.gallery_id, g.title, i.role, i.email, u.display_name, i.expires_at FROM gallery_invitations i
         JOIN galleries g ON g.id = i.gallery_id AND g.deleted_at IS NULL JOIN users u ON u.id = i.invited_by
         WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
        [sha256(req.params.token)],
      );
      const r = rows[0];
      if (!r) throw new AppError('INVITATION_INVALID');
      return { galleryId: r.gallery_id, galleryTitle: r.title, role: r.role, email: r.email, invitedBy: r.display_name, expiresAt: r.expires_at.toISOString() };
    },
  );

  app.post(
    '/v1/invitations/accept',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Accept an invitation (signed in with the invited email)',
        body: Type.Object({ token: Type.String({ maxLength: 100 }) }, { additionalProperties: false }),
        response: { 200: Type.Object({ galleryId: Type.String(), role: Type.String() }), 410: ErrorResponse },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const result = await withTransaction(db, async (client) => {
        const { rows } = await client.query(
          `SELECT i.id, i.gallery_id, i.role, i.email, g.owner_id FROM gallery_invitations i JOIN galleries g ON g.id = i.gallery_id AND g.deleted_at IS NULL
           WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() FOR UPDATE OF i`,
          [sha256(req.body.token)],
        );
        const inv = rows[0];
        if (!inv) throw new AppError('INVITATION_INVALID');
        const { rows: u } = await client.query(`SELECT email FROM users WHERE id = $1`, [me.userId]);
        if (u[0].email.toLowerCase() !== inv.email) throw new AppError('FORBIDDEN', { reason: 'invitation was sent to a different email' });
        await client.query(`UPDATE gallery_invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [inv.id, me.userId]);
        if (inv.owner_id === me.userId) return { galleryId: inv.gallery_id, role: 'owner' };
        if (inv.role === 'editor' && (await countEditors(client, inv.gallery_id, me.userId)) >= config.limits.maxEditorsPerGallery)
          throw new AppError('LIMIT_EXCEEDED', { maxEditorsPerGallery: config.limits.maxEditorsPerGallery });
        await client.query(
          `INSERT INTO gallery_members (gallery_id, user_id, role, source) VALUES ($1, $2, $3, 'invite')
           ON CONFLICT (gallery_id, user_id) DO UPDATE SET role = EXCLUDED.role, source = 'invite', link_version = NULL, updated_at = now()`,
          [inv.gallery_id, me.userId, inv.role],
        );
        return { galleryId: inv.gallery_id, role: inv.role };
      });
      await afterAccessChange(result.galleryId);
      return result;
    },
  );

  // ---- Edit link -------------------------------------------------------------

  app.post(
    '/v1/galleries/:galleryId/join',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Join as an editor through the edit link (signed-in users only)',
        description:
          'Valid only while the gallery is in edit_link mode and the token is the current edit link. Creates a link membership that lasts only while that edit link stays active (rotating or disabling it suspends the membership). Existing explicit memberships are never changed.',
        params: GalleryIdParams,
        body: Type.Object({ link: Type.String({ maxLength: 100 }) }, { additionalProperties: false }),
        response: { 200: Type.Object({ galleryId: Type.String(), role: Type.String(), via: Type.String() }), 410: ErrorResponse },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const id = req.params.galleryId;
      const { rows } = await db.query(
        `SELECT g.owner_id, g.sharing_mode, g.edit_link_token, g.link_version, m.source
         FROM galleries g LEFT JOIN gallery_members m ON m.gallery_id = g.id AND m.user_id = $2
         WHERE g.id = $1 AND g.deleted_at IS NULL`,
        [id, me.userId],
      );
      const g = rows[0];
      if (!g || g.sharing_mode !== 'edit_link' || g.edit_link_token !== req.body.link) throw new AppError('LINK_DISABLED');
      if (g.owner_id !== me.userId && (!g.source || g.source === 'link')) {
        await assertEditorSlot(id, me.userId);
        await db.query(
          `INSERT INTO gallery_members (gallery_id, user_id, role, source, link_version) VALUES ($1, $2, 'editor', 'link', $3)
           ON CONFLICT (gallery_id, user_id) DO UPDATE SET role = 'editor', link_version = EXCLUDED.link_version, updated_at = now()
           WHERE gallery_members.source = 'link'`,
          [id, me.userId, g.link_version],
        );
        await afterAccessChange(id);
      }
      const access = await resolveAccess(db, id, { userId: me.userId });
      return { galleryId: id, role: access.role!, via: access.via! };
    },
  );

  // ---- Link resolution, QR codes, pairing -------------------------------------

  app.get(
    '/v1/links/resolve',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Resolve a scanned QR code / deep link to the next step',
        description:
          'Send the Authorization header if the app has a session. next: "open" (create a viewer session and load the scene), "sign_in" (authenticate, then resolve again), "claim_pairing" (POST /v1/pairings/claim), "accept_invitation", "join_as_editor" (website). A restricted gallery never reveals its title to callers without access. A rotated or disabled share link returns 410 LINK_DISABLED unless the caller has access another way.',
        security: [],
        querystring: Type.Object({ url: Type.String({ maxLength: 2000 }) }),
        response: {
          200: Type.Object({
            kind: Type.Union([Type.Literal('gallery'), Type.Literal('pairing'), Type.Literal('invitation')]),
            next: Type.Union([
              Type.Literal('open'),
              Type.Literal('sign_in'),
              Type.Literal('claim_pairing'),
              Type.Literal('accept_invitation'),
              Type.Literal('join_as_editor'),
            ]),
            galleryId: Type.Union([Type.String(), Type.Null()]),
            linkToken: Type.Union([Type.String(), Type.Null()], { description: 'Send as X-Gallery-Link when creating the viewer session.' }),
            gallery: Type.Union([Type.Object({ title: Type.String(), sharingMode: SharingMode }), Type.Null()]),
            access: Type.Union([Type.Object({ role: Type.String(), via: Type.String(), canEdit: Type.Boolean() }), Type.Null()]),
          }),
          404: ErrorResponse,
          410: ErrorResponse,
        },
      },
    },
    async (req) => {
      const parsed = parseLink(req.query.url);
      if (!parsed) throw new AppError('VALIDATION_FAILED', { reason: 'not a gallery link' });
      if (parsed.kind === 'pairing') return { kind: 'pairing' as const, next: 'claim_pairing' as const, galleryId: null, linkToken: null, gallery: null, access: null };
      if (parsed.kind === 'invitation')
        return { kind: 'invitation' as const, next: 'accept_invitation' as const, galleryId: null, linkToken: null, gallery: null, access: null };

      const userId = req.caller.kind === 'user' ? req.caller.userId : req.caller.kind === 'viewer' ? req.caller.userId : null;
      const { rows } = await db.query(`SELECT title, sharing_mode, edit_link_token FROM galleries WHERE id = $1 AND deleted_at IS NULL`, [parsed.galleryId]);
      const g = rows[0];
      const access = g ? await resolveAccess(db, parsed.galleryId, { userId, linkToken: parsed.linkToken }) : null;

      // The edit join link: website flow for signed-in users.
      if (g && parsed.linkToken && parsed.linkToken === g.edit_link_token && g.sharing_mode === 'edit_link' && access?.role !== 'owner' && access?.role !== 'editor') {
        return {
          kind: 'gallery' as const,
          next: userId ? ('join_as_editor' as const) : ('sign_in' as const),
          galleryId: parsed.galleryId,
          linkToken: parsed.linkToken,
          gallery: { title: g.title, sharingMode: g.sharing_mode },
          access: access?.role ? { role: access.role, via: access.via!, canEdit: false } : null,
        };
      }
      if (access?.role) {
        return {
          kind: 'gallery' as const,
          next: 'open' as const,
          galleryId: parsed.galleryId,
          linkToken: access.via === 'link' ? parsed.linkToken : null,
          gallery: { title: g.title, sharingMode: g.sharing_mode },
          access: { role: access.role, via: access.via!, canEdit: capabilitiesFor(access.role).canEdit },
        };
      }
      if (parsed.linkToken && g) throw new AppError('LINK_DISABLED');
      // No access: anonymous callers are asked to sign in (without learning whether the
      // gallery exists); signed-in callers get 404.
      if (!userId) return { kind: 'gallery' as const, next: 'sign_in' as const, galleryId: parsed.galleryId, linkToken: null, gallery: null, access: null };
      throw new AppError('NOT_FOUND', { what: 'gallery' });
    },
  );

  const QrQuery = Type.Object({
    format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('svg')], { default: 'png' })),
    size: Type.Optional(Type.Integer({ minimum: 128, maximum: 1024, default: 512 })),
  });

  function sendQr(reply: any, url: string, format: 'png' | 'svg', image: Buffer | string) {
    reply.header('x-link-url', url).header('cache-control', 'no-store');
    reply.type(format === 'svg' ? 'image/svg+xml' : 'image/png');
    return reply.send(image);
  }

  app.get(
    '/v1/galleries/:galleryId/qr',
    {
      schema: {
        tags: ['sharing'],
        summary: 'QR code (PNG/SVG) for the gallery deep link',
        description:
          'target "gallery" (default): the view link when the gallery is shared by link (any member), otherwise the token-free gallery link that only works for signed-in members. target "edit": the edit join link (owner only, edit_link mode). The encoded URL is returned in the X-Link-Url header. The QR is an entry link, not an access grant: access is decided when it is resolved.',
        params: GalleryIdParams,
        querystring: Type.Intersect([QrQuery, Type.Object({ target: Type.Optional(Type.Union([Type.Literal('gallery'), Type.Literal('edit')], { default: 'gallery' })) })]),
      },
    },
    async (req, reply) => {
      const id = req.params.galleryId;
      const target = req.query.target ?? 'gallery';
      const access = await requireAccess(db, id, principalFor(req, id), target === 'edit' ? 'manage' : 'view');
      const info = await sharingInfo(id);
      let url: string;
      if (target === 'edit') {
        if (!info.editJoinUrl) throw new AppError('LINK_DISABLED', { reason: 'edit link is not enabled' });
        url = info.editJoinUrl;
      } else {
        url = info.viewUrl && access.role ? info.viewUrl : info.galleryUrl;
      }
      const format = req.query.format ?? 'png';
      return sendQr(reply, url, format, await renderQr(url, format, req.query.size ?? 512));
    },
  );

  app.get(
    '/v1/pairings/qr',
    {
      schema: {
        tags: ['sharing'],
        summary: 'QR code (PNG/SVG) for a preview-session pairing code you created',
        querystring: Type.Intersect([QrQuery, Type.Object({ code: Type.String({ maxLength: 64 }) })]),
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const { rows } = await db.query(
        `SELECT id FROM viewer_sessions WHERE pairing_code_hash = $1 AND created_by = $2 AND claimed_at IS NULL
           AND pairing_expires_at > now() AND revoked_at IS NULL`,
        [sha256(req.query.code), me.userId],
      );
      if (!rows[0]) throw new AppError('LINK_DISABLED', { reason: 'pairing code expired or already used' });
      const url = pairingLink(config, req.query.code);
      const format = req.query.format ?? 'png';
      return sendQr(reply, url, format, await renderQr(url, format, req.query.size ?? 512));
    },
  );

  app.post(
    '/v1/pairings/claim',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Phone claims a preview session by its pairing code (single use)',
        description:
          'Returns the read-only vs_ viewer token for the gallery the website editor was previewing. No account is needed on the phone; the token is limited to reading that one gallery, and its access follows the creating editor\'s access (a downgrade to no access ends it).',
        security: [],
        body: Type.Object({ code: Type.String({ maxLength: 64 }) }, { additionalProperties: false }),
        response: {
          200: Type.Object({ viewerToken: Type.String(), viewerSessionId: Type.String(), galleryId: Type.String(), expiresAt: Type.String() }),
          410: ErrorResponse,
        },
      },
    },
    async (req) => {
      const token = randomToken('vs');
      const { rows } = await db.query(
        `UPDATE viewer_sessions SET claimed_at = now(), token_hash = $2
         WHERE pairing_code_hash = $1 AND claimed_at IS NULL AND pairing_expires_at > now() AND revoked_at IS NULL AND expires_at > now()
         RETURNING id, gallery_id, expires_at`,
        [sha256(req.body.code), sha256(token)],
      );
      if (!rows[0]) throw new AppError('LINK_DISABLED', { reason: 'pairing code expired or already used' });
      return { viewerToken: token, viewerSessionId: rows[0].id, galleryId: rows[0].gallery_id, expiresAt: rows[0].expires_at.toISOString() };
    },
  );

  // ---- Viewer session management ----------------------------------------------

  app.get(
    '/v1/galleries/:galleryId/viewer-sessions',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Active viewer/preview sessions (owner: all; others: the ones they created)',
        params: GalleryIdParams,
      },
    },
    async (req) => {
      const me = requireUser(req);
      const id = req.params.galleryId;
      const access = await requireAccess(db, id, principalFor(req, id), 'view');
      const { rows } = await db.query(
        `SELECT id, kind, user_id, created_by, created_at, expires_at, claimed_at, (link_token IS NOT NULL) AS via_link FROM viewer_sessions
         WHERE gallery_id = $1 AND revoked_at IS NULL AND expires_at > now() AND ($2 OR created_by = $3 OR user_id = $3)
         ORDER BY created_at DESC LIMIT 100`,
        [id, access.role === 'owner', me.userId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          userId: r.user_id,
          createdBy: r.created_by,
          viaLink: r.via_link,
          createdAt: r.created_at.toISOString(),
          expiresAt: r.expires_at.toISOString(),
          claimedAt: r.claimed_at?.toISOString() ?? null,
        })),
        liveConnections: hub.connectionCount(id),
      };
    },
  );

  app.delete(
    '/v1/viewer-sessions/:sessionId',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Revoke a viewer/preview session (its creator or the gallery owner)',
        description: 'The phone loses access immediately; its open WebSocket is closed with code 4403.',
        params: Type.Object({ sessionId: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      const c = req.caller;
      const { rows } = await db.query(`SELECT gallery_id, created_by, user_id FROM viewer_sessions WHERE id = $1`, [req.params.sessionId]);
      const s = rows[0];
      if (!s) throw new AppError('NOT_FOUND', { what: 'viewer session' });
      // A phone may end its own session with its own vs_ token.
      const selfSession = c.kind === 'viewer' && c.viewerSessionId === req.params.sessionId;
      if (!selfSession) {
        const me = requireUser(req);
        if (s.created_by !== me.userId && s.user_id !== me.userId) await requireAccess(db, s.gallery_id, { userId: me.userId }, 'manage');
      }
      await db.query(`UPDATE viewer_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [req.params.sessionId]);
      await hub.recheckGallery(s.gallery_id);
      reply.code(204);
      return null;
    },
  );
}
