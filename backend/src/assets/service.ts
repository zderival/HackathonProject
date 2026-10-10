import { randomBytes, randomUUID } from 'node:crypto';
import sharp, { type Metadata, type OutputInfo, type Sharp } from 'sharp';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { ObjectStorage } from './storage.js';

export const SUPPORTED_IMAGE_FORMATS = ['jpeg', 'png', 'webp'] as const;
const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

// Variants generated for every image. Each size is produced in WebP (web) and in
// JPEG, or PNG when the image has transparency (Unity's Texture2D.LoadImage and
// older iOS paths do not decode WebP). Never upscaled.
const SIZES = [
  { name: 'thumb', max: 256 },
  { name: 'medium', max: 1024 },
  { name: 'large', max: 2048 },
] as const;

export interface Variant {
  name: string;
  key: string;
  format: 'webp' | 'jpeg' | 'png';
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}

export interface AssetRow {
  id: string;
  gallery_id: string;
  uploaded_by: string;
  status: string;
  original_format: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  variants: Variant[];
  title: string;
  description: string;
  attribution: string;
  created_at: Date;
}

export class AssetService {
  constructor(
    private db: Db,
    private storage: ObjectStorage,
    private config: Config,
  ) {}

  async upload(galleryId: string, userId: string, file: Buffer, meta: { title?: string; description?: string; attribution?: string }) {
    if (file.length > this.config.limits.maxUploadBytes)
      throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: this.config.limits.maxUploadBytes });
    if (file.length === 0) throw new AppError('VALIDATION_FAILED', { reason: 'empty file' });

    // Format is detected from the decoded content, never from the filename or header.
    let info: Metadata;
    try {
      info = await sharp(file, { limitInputPixels: this.config.limits.maxImagePixels, failOn: 'error' }).metadata();
    } catch (err: any) {
      if (/pixel limit/i.test(err.message)) throw new AppError('PAYLOAD_TOO_LARGE', { maxPixels: this.config.limits.maxImagePixels });
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', { supported: SUPPORTED_IMAGE_FORMATS, reason: 'not a decodable image' });
    }
    const format = info.format as string;
    if (!SUPPORTED_IMAGE_FORMATS.includes(format as any))
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', { supported: SUPPORTED_IMAGE_FORMATS, detected: format });
    if (!info.width || !info.height) throw new AppError('UNSUPPORTED_MEDIA_TYPE', { reason: 'missing dimensions' });
    if (info.width * info.height > this.config.limits.maxImagePixels)
      throw new AppError('PAYLOAD_TOO_LARGE', { maxPixels: this.config.limits.maxImagePixels });
    if ((info.pages ?? 1) > 1) throw new AppError('UNSUPPORTED_MEDIA_TYPE', { reason: 'animated images are not supported' });

    // EXIF orientation is applied, so stored dimensions are as displayed.
    const oriented = sharp(file, { limitInputPixels: this.config.limits.maxImagePixels }).rotate();
    const swap = (info.orientation ?? 1) >= 5;
    const width = swap ? info.height : info.width;
    const height = swap ? info.width : info.height;
    const hasAlpha = !!info.hasAlpha;

    const assetId = randomUUID();
    // Random path segment: object keys are not guessable from asset IDs.
    const prefix = `galleries/${galleryId}/assets/${assetId}/${randomBytes(12).toString('hex')}`;
    const uploads: { key: string; body: Buffer; mime: string }[] = [];
    const variants: Variant[] = [];

    // Original, re-encoded in its own format with metadata stripped (sharp drops
    // EXIF/XMP/ICC unless asked to keep them).
    const original = await encode(oriented.clone(), format as Variant['format']);
    uploads.push({ key: `${prefix}/original.${EXT[format]}`, body: original.data, mime: MIME[format] });
    variants.push(variantOf('original', `${prefix}/original.${EXT[format]}`, format as Variant['format'], original));

    const fallback: Variant['format'] = hasAlpha ? 'png' : 'jpeg';
    for (const size of SIZES) {
      // "large" only exists when it differs from "medium".
      if (size.name === 'large' && Math.max(width, height) <= 1024) continue;
      const resized = oriented.clone().resize({ width: size.max, height: size.max, fit: 'inside', withoutEnlargement: true });
      for (const fmt of size.name === 'thumb' ? (['webp'] as const) : (['webp', fallback] as const)) {
        const out = await encode(resized.clone(), fmt);
        const key = `${prefix}/${size.name}.${EXT[fmt]}`;
        uploads.push({ key, body: out.data, mime: MIME[fmt] });
        variants.push(variantOf(size.name, key, fmt, out));
      }
    }

    await Promise.all(uploads.map((u) => this.storage.put(u.key, u.body, u.mime)));
    try {
      const { rows } = await this.db.query<AssetRow>(
        `INSERT INTO assets (id, gallery_id, uploaded_by, status, original_format, width, height, bytes, sha256, variants, title, description, attribution)
         VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING *`,
        [
          assetId,
          galleryId,
          userId,
          format,
          width,
          height,
          file.length,
          sha256(file),
          JSON.stringify(variants),
          (meta.title ?? '').slice(0, 200),
          (meta.description ?? '').slice(0, 2000),
          (meta.attribution ?? '').slice(0, 300),
        ],
      );
      return rows[0];
    } catch (err) {
      await this.storage.deleteMany(uploads.map((u) => u.key)).catch(() => {});
      throw err;
    }
  }

  async get(assetId: string): Promise<AssetRow | null> {
    const { rows } = await this.db.query<AssetRow>(`SELECT * FROM assets WHERE id = $1 AND status = 'ready'`, [assetId]);
    return rows[0] ?? null;
  }

  async list(galleryId: string, opts: { limit: number; before?: string }) {
    const { rows } = await this.db.query<AssetRow>(
      `SELECT * FROM assets WHERE gallery_id = $1 AND status = 'ready' AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC LIMIT $3`,
      [galleryId, opts.before ?? null, opts.limit + 1],
    );
    return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
  }

  async updateMeta(assetId: string, meta: { title?: string; description?: string; attribution?: string }) {
    const { rows } = await this.db.query<AssetRow>(
      `UPDATE assets SET title = COALESCE($2, title), description = COALESCE($3, description), attribution = COALESCE($4, attribution)
       WHERE id = $1 AND status = 'ready' RETURNING *`,
      [assetId, meta.title ?? null, meta.description ?? null, meta.attribution ?? null],
    );
    return rows[0] ?? null;
  }

  // Assets still placed in the scene cannot be deleted (the scene would reference nothing).
  async delete(asset: AssetRow) {
    const { rows } = await this.db.query(
      `SELECT 1 FROM galleries WHERE id = $1 AND (
         jsonb_path_exists(scene, '$.nodes.* ? (@.props.assetId == $a)', jsonb_build_object('a', $2::text)) OR
         jsonb_path_exists(scene, '$.nodes.* ? (@.props.material.textureAssetId == $a)', jsonb_build_object('a', $2::text)))`,
      [asset.gallery_id, asset.id],
    );
    if (rows.length) throw new AppError('VALIDATION_FAILED', { reason: 'asset is still used in the scene', assetId: asset.id });
    await this.db.query(`UPDATE assets SET status = 'deleted', deleted_at = now() WHERE id = $1`, [asset.id]);
    await this.storage.deleteMany(asset.variants.map((v) => v.key)).catch(() => {});
  }

  // Manifest with short-lived signed URLs. URLs remain usable until they expire even if
  // access is revoked afterwards (bounded by SIGNED_URL_TTL_SEC).
  async manifest(asset: AssetRow) {
    const ttl = this.config.signedUrlTtlSec;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const variants = await Promise.all(
      asset.variants.map(async (v) => ({
        name: v.name,
        format: v.format,
        mimeType: v.mimeType,
        width: v.width,
        height: v.height,
        bytes: v.bytes,
        url: await this.storage.signedGetUrl(v.key, ttl, { contentType: v.mimeType }),
        proxyPath: `/v1/assets/${asset.id}/variants/${v.name}.${v.format}`,
      })),
    );
    return {
      ...publicAsset(asset),
      urlsExpireAt: expiresAt,
      variants,
    };
  }

  variantKey(asset: AssetRow, name: string, format: string): Variant | undefined {
    return asset.variants.find((v) => v.name === name && v.format === format);
  }
}

export function publicAsset(a: AssetRow) {
  return {
    id: a.id,
    galleryId: a.gallery_id,
    kind: 'image' as const,
    originalFormat: a.original_format,
    width: a.width,
    height: a.height,
    aspectRatio: Math.round((a.width / a.height) * 10000) / 10000,
    bytes: a.bytes,
    title: a.title,
    description: a.description,
    attribution: a.attribution,
    uploadedBy: a.uploaded_by,
    createdAt: new Date(a.created_at).toISOString(),
  };
}

async function encode(img: Sharp, fmt: Variant['format']) {
  const pipeline =
    fmt === 'webp' ? img.webp({ quality: 82 }) : fmt === 'png' ? img.png({ compressionLevel: 9 }) : img.jpeg({ quality: 85, mozjpeg: true });
  return pipeline.toBuffer({ resolveWithObject: true });
}

function variantOf(name: string, key: string, format: Variant['format'], out: { data: Buffer; info: OutputInfo }): Variant {
  return { name, key, format, mimeType: MIME[format], width: out.info.width, height: out.info.height, bytes: out.data.length };
}
