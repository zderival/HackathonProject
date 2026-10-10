import { Type } from 'typebox';
import type { App } from '../app.js';
import { requireAccess } from '../galleries/access.js';
import { principalFor, requireUser } from '../http/context.js';
import { AppError } from '../lib/errors.js';
import { ErrorResponse, GalleryIdParams } from '../schemas/api.js';
import { publicAsset, SUPPORTED_IMAGE_FORMATS, type AssetRow } from './service.js';

const AssetIdParams = Type.Object({ assetId: Type.String({ format: 'uuid' }) });

const AssetMeta = Type.Object({
  id: Type.String({ format: 'uuid' }),
  galleryId: Type.String({ format: 'uuid' }),
  kind: Type.Literal('image'),
  originalFormat: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
  aspectRatio: Type.Number({ description: 'width / height' }),
  bytes: Type.Integer(),
  title: Type.String(),
  description: Type.String(),
  attribution: Type.String(),
  uploadedBy: Type.String(),
  createdAt: Type.String({ format: 'date-time' }),
});

const AssetManifest = Type.Intersect([
  AssetMeta,
  Type.Object({
    urlsExpireAt: Type.String({ format: 'date-time', description: 'Signed URLs stop working after this; GET the manifest again to refresh.' }),
    variants: Type.Array(
      Type.Object({
        name: Type.String({ description: 'original | thumb | medium | large' }),
        format: Type.String({ description: 'webp | jpeg | png' }),
        mimeType: Type.String(),
        width: Type.Integer(),
        height: Type.Integer(),
        bytes: Type.Integer(),
        url: Type.String({ description: 'Short-lived signed HTTPS URL (no auth header needed).' }),
        proxyPath: Type.String({ description: 'Authorized proxy path on this API (send the Authorization header).' }),
      }),
    ),
  }),
]);

export async function assetRoutes(app: App) {
  const { db, assets, storage } = app.deps;

  async function assetForRead(req: any): Promise<AssetRow> {
    const asset = await assets.get(req.params.assetId);
    if (!asset) throw new AppError('NOT_FOUND', { what: 'asset' });
    await requireAccess(db, asset.gallery_id, principalFor(req, asset.gallery_id), 'view');
    return asset;
  }

  app.post(
    '/v1/galleries/:galleryId/assets',
    {
      schema: {
        tags: ['assets'],
        summary: 'Upload an image (multipart/form-data)',
        description: `Fields: "file" (required, ${SUPPORTED_IMAGE_FORMATS.join('/')}, validated by decoding), optional "title", "description", "attribution". Text fields must come before the file part. Returns the asset manifest.`,
        consumes: ['multipart/form-data'],
        params: GalleryIdParams,
        response: { 201: AssetManifest, 413: ErrorResponse, 415: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { userId } = requireUser(req);
      const galleryId = (req.params as any).galleryId as string;
      await requireAccess(db, galleryId, principalFor(req, galleryId), 'edit');
      if (!req.isMultipart()) throw new AppError('UNSUPPORTED_MEDIA_TYPE', { expected: 'multipart/form-data' });

      const meta: Record<string, string> = {};
      let file: Buffer | null = null;
      for await (const part of req.parts({ limits: { fileSize: app.deps.config.limits.maxUploadBytes, files: 1, fields: 10, fieldSize: 4000 } })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') {
            part.file.resume();
            continue;
          }
          file = await part.toBuffer();
          if (part.file.truncated) throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: app.deps.config.limits.maxUploadBytes });
        } else if (['title', 'description', 'attribution'].includes(part.fieldname)) {
          meta[part.fieldname] = String(part.value);
        }
      }
      if (!file) throw new AppError('VALIDATION_FAILED', { field: 'file', reason: 'missing file part' });
      // Re-check: a long upload must not land after the uploader lost edit access.
      await requireAccess(db, galleryId, principalFor(req, galleryId), 'edit');
      const row = await assets.upload(galleryId, userId, file, meta);
      reply.code(201);
      return assets.manifest(row);
    },
  );

  app.get(
    '/v1/galleries/:galleryId/assets',
    {
      schema: {
        tags: ['assets'],
        summary: 'List assets of a gallery (newest first)',
        params: GalleryIdParams,
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
          before: Type.Optional(Type.String({ format: 'date-time', description: 'createdAt of the last item from the previous page.' })),
        }),
        response: { 200: Type.Object({ items: Type.Array(AssetMeta), nextBefore: Type.Union([Type.String(), Type.Null()]) }) },
      },
    },
    async (req) => {
      await requireAccess(db, req.params.galleryId, principalFor(req, req.params.galleryId), 'view');
      const { rows, hasMore } = await assets.list(req.params.galleryId, { limit: req.query.limit ?? 50, before: req.query.before });
      const items = rows.map(publicAsset);
      return { items, nextBefore: hasMore ? items[items.length - 1].createdAt : null };
    },
  );

  app.get(
    '/v1/assets/:assetId',
    {
      schema: {
        tags: ['assets'],
        summary: 'Asset manifest with fresh signed variant URLs',
        params: AssetIdParams,
        response: { 200: AssetManifest, 404: ErrorResponse },
      },
    },
    async (req) => assets.manifest(await assetForRead(req)),
  );

  app.post(
    '/v1/assets/manifests',
    {
      schema: {
        tags: ['assets'],
        summary: 'Batch manifests (e.g. every asset referenced by a scene)',
        body: Type.Object({ assetIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 200 }) }, { additionalProperties: false }),
        response: { 200: Type.Object({ items: Type.Array(AssetManifest), missing: Type.Array(Type.String()) }) },
      },
    },
    async (req) => {
      const items = [];
      const missing: string[] = [];
      const checked = new Map<string, boolean>();
      for (const id of new Set(req.body.assetIds)) {
        const asset = await assets.get(id);
        let ok = false;
        if (asset) {
          if (!checked.has(asset.gallery_id)) {
            ok = await requireAccess(db, asset.gallery_id, principalFor(req, asset.gallery_id), 'view').then(
              () => true,
              () => false,
            );
            checked.set(asset.gallery_id, ok);
          } else ok = checked.get(asset.gallery_id)!;
        }
        if (asset && ok) items.push(await assets.manifest(asset));
        else missing.push(id);
      }
      return { items, missing };
    },
  );

  app.patch(
    '/v1/assets/:assetId',
    {
      schema: {
        tags: ['assets'],
        summary: 'Update asset title/description/attribution',
        params: AssetIdParams,
        body: Type.Object(
          {
            title: Type.Optional(Type.String({ maxLength: 200 })),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
            attribution: Type.Optional(Type.String({ maxLength: 300 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: AssetMeta },
      },
    },
    async (req) => {
      requireUser(req);
      const asset = await assets.get(req.params.assetId);
      if (!asset) throw new AppError('NOT_FOUND', { what: 'asset' });
      await requireAccess(db, asset.gallery_id, principalFor(req, asset.gallery_id), 'edit');
      return publicAsset((await assets.updateMeta(asset.id, req.body))!);
    },
  );

  app.delete(
    '/v1/assets/:assetId',
    { schema: { tags: ['assets'], summary: 'Delete an asset not used in the scene', params: AssetIdParams, response: { 204: Type.Null() } } },
    async (req, reply) => {
      requireUser(req);
      const asset = await assets.get(req.params.assetId);
      if (!asset) throw new AppError('NOT_FOUND', { what: 'asset' });
      await requireAccess(db, asset.gallery_id, principalFor(req, asset.gallery_id), 'edit');
      await assets.delete(asset);
      reply.code(204);
      return null;
    },
  );

  // Authorized proxy: for clients that cannot use the signed URLs (e.g. storage not
  // reachable from the client network). Authorization is checked on every request.
  app.get(
    '/v1/assets/:assetId/variants/:file',
    {
      schema: {
        tags: ['assets'],
        summary: 'Stream an asset variant through the API (authorized proxy)',
        params: Type.Object({ assetId: Type.String({ format: 'uuid' }), file: Type.String({ pattern: '^[a-z]+\\.(webp|jpeg|png)$' }) }),
      },
    },
    async (req, reply) => {
      const asset = await assetForRead(req);
      const [name, format] = req.params.file.split('.');
      const v = assets.variantKey(asset, name, format);
      if (!v) throw new AppError('NOT_FOUND', { what: 'variant' });
      const obj = await storage.getStream(v.key);
      reply.header('content-type', v.mimeType).header('cache-control', 'private, max-age=300');
      if (obj.contentLength) reply.header('content-length', obj.contentLength);
      return reply.send(obj.body);
    },
  );
}
