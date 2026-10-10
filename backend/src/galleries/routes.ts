import { Type } from 'typebox';
import type { App } from '../app.js';
import { principalFor, requireUser } from '../http/context.js';
import { randomToken } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { ErrorResponse, GalleryIdParams, GallerySummary } from '../schemas/api.js';
import { Scene, SCENE_SCHEMA_VERSION } from '../schemas/scene.js';
import { emptyScene, starterScene } from '../scene/defaults.js';
import { capabilitiesFor, requireAccess, resolveAccess, type Role } from './access.js';

function summary(row: any, role: Role, readOnly = false) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ownerId: row.owner_id,
    role,
    capabilities: capabilitiesFor(role, readOnly),
    sharingMode: row.sharing_mode,
    revision: row.revision,
    schemaVersion: row.schema_version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const COLS = 'id, title, description, owner_id, sharing_mode, revision, schema_version, created_at, updated_at';

export async function galleryRoutes(app: App) {
  const { db } = app.deps;

  app.post(
    '/v1/galleries',
    {
      schema: {
        tags: ['galleries'],
        summary: 'Create a gallery',
        body: Type.Object(
          {
            title: Type.String({ minLength: 1, maxLength: 120 }),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
            template: Type.Optional(Type.Union([Type.Literal('starter'), Type.Literal('blank')], { description: 'Default "starter": a furnished room.' })),
          },
          { additionalProperties: false },
        ),
        response: { 201: GallerySummary },
      },
    },
    async (req, reply) => {
      const { userId } = requireUser(req);
      const scene = req.body.template === 'blank' ? emptyScene() : starterScene({ title: req.body.title });
      const { rows } = await db.query(
        `INSERT INTO galleries (owner_id, title, description, scene, schema_version, view_link_token, edit_link_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
        [userId, req.body.title, req.body.description ?? '', scene, SCENE_SCHEMA_VERSION, randomToken('gv', 18), randomToken('ge', 18)],
      );
      reply.code(201);
      return summary(rows[0], 'owner');
    },
  );

  app.get(
    '/v1/galleries',
    {
      schema: {
        tags: ['galleries'],
        summary: 'List galleries the caller owns or is a member of (most recently updated first)',
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
          cursor: Type.Optional(Type.String({ description: 'nextCursor from the previous page.' })),
        }),
        response: { 200: Type.Object({ items: Type.Array(GallerySummary), nextCursor: Type.Union([Type.String(), Type.Null()]) }) },
      },
    },
    async (req) => {
      const { userId } = requireUser(req);
      const limit = req.query.limit ?? 20;
      let cursorTime: string | null = null;
      let cursorId: string | null = null;
      if (req.query.cursor) {
        try {
          [cursorTime, cursorId] = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString());
        } catch {
          throw new AppError('VALIDATION_FAILED', { cursor: 'invalid' });
        }
      }
      // Link-derived memberships only count while the edit link they came from is active.
      const { rows } = await db.query(
        `SELECT g.id, g.title, g.description, g.owner_id, g.sharing_mode, g.revision, g.schema_version, g.created_at, g.updated_at,
                CASE WHEN g.owner_id = $1 THEN 'owner' ELSE m.role END AS role
         FROM galleries g
         LEFT JOIN gallery_members m ON m.gallery_id = g.id AND m.user_id = $1
         WHERE g.deleted_at IS NULL
           AND (g.owner_id = $1 OR (m.user_id IS NOT NULL AND (m.source <> 'link'
                OR (g.sharing_mode = 'edit_link' AND m.link_version = g.link_version))))
           AND ($2::timestamptz IS NULL OR (g.updated_at, g.id) < ($2::timestamptz, $3::uuid))
         ORDER BY g.updated_at DESC, g.id DESC LIMIT $4`,
        [userId, cursorTime, cursorId, limit + 1],
      );
      const items = rows.slice(0, limit).map((r) => summary(r, r.role));
      const last = rows.length > limit ? rows[limit - 1] : null;
      return {
        items,
        nextCursor: last ? Buffer.from(JSON.stringify([new Date(last.updated_at).toISOString(), last.id])).toString('base64url') : null,
      };
    },
  );

  app.get(
    '/v1/galleries/:galleryId',
    {
      schema: {
        tags: ['galleries'],
        summary: 'Gallery metadata with the caller\'s effective role and capabilities',
        params: GalleryIdParams,
        response: { 200: GallerySummary, 404: ErrorResponse },
      },
    },
    async (req) => {
      const p = principalFor(req, req.params.galleryId);
      const access = await requireAccess(db, req.params.galleryId, p, 'view');
      const { rows } = await db.query(`SELECT ${COLS} FROM galleries WHERE id = $1`, [req.params.galleryId]);
      return summary(rows[0], access.role!, p.readOnly);
    },
  );

  app.patch(
    '/v1/galleries/:galleryId',
    {
      schema: {
        tags: ['galleries'],
        summary: 'Update title/description (editors and owner)',
        params: GalleryIdParams,
        body: Type.Object(
          { title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), description: Type.Optional(Type.String({ maxLength: 2000 })) },
          { additionalProperties: false },
        ),
        response: { 200: GallerySummary },
      },
    },
    async (req) => {
      requireUser(req);
      const p = principalFor(req, req.params.galleryId);
      const access = await requireAccess(db, req.params.galleryId, p, 'edit');
      const { rows } = await db.query(
        `UPDATE galleries SET title = COALESCE($2, title), description = COALESCE($3, description), updated_at = now()
         WHERE id = $1 RETURNING ${COLS}`,
        [req.params.galleryId, req.body.title ?? null, req.body.description ?? null],
      );
      return summary(rows[0], access.role!);
    },
  );

  app.delete(
    '/v1/galleries/:galleryId',
    { schema: { tags: ['galleries'], summary: 'Delete a gallery (owner only)', params: GalleryIdParams, response: { 204: Type.Null() } } },
    async (req, reply) => {
      requireUser(req);
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'manage');
      await db.query(`UPDATE galleries SET deleted_at = now(), access_version = access_version + 1 WHERE id = $1`, [req.params.galleryId]);
      await app.deps.hub.recheckGallery(req.params.galleryId);
      reply.code(204);
      return null;
    },
  );

  app.get(
    '/v1/galleries/:galleryId/scene',
    {
      // The schema documents the response; plain JSON.stringify avoids re-validating
      // the large node union during serialization.
      serializerCompiler: () => (data) => JSON.stringify(data),
      schema: {
        tags: ['scene'],
        summary: 'Authoritative scene snapshot with its revision',
        params: GalleryIdParams,
        response: {
          200: Type.Object({
            galleryId: Type.String(),
            revision: Type.Integer(),
            schemaVersion: Type.Integer(),
            scene: Scene,
          }),
        },
      },
    },
    async (req) => {
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'view');
      const { rows } = await db.query(`SELECT scene, revision, schema_version FROM galleries WHERE id = $1`, [req.params.galleryId]);
      return { galleryId: req.params.galleryId, revision: rows[0].revision, schemaVersion: rows[0].schema_version, scene: rows[0].scene };
    },
  );

  // Exposed for tests/tools that need the raw access decision.
  app.get(
    '/v1/galleries/:galleryId/access',
    {
      schema: {
        tags: ['galleries'],
        summary: "The caller's effective access (role, how it was granted, capabilities)",
        params: GalleryIdParams,
      },
    },
    async (req) => {
      const p = principalFor(req, req.params.galleryId);
      const a = await resolveAccess(db, req.params.galleryId, p);
      if (!a.role) throw new AppError('NOT_FOUND', { what: 'gallery' });
      return { role: a.role, via: a.via, sharingMode: a.sharingMode, readOnlySession: !!p.readOnly, capabilities: capabilitiesFor(a.role, p.readOnly) };
    },
  );
}
