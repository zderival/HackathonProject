// Private S3-compatible object storage. Works with AWS S3, Cloudflare R2, Backblaze B2,
// SeaweedFS (local dev) and other S3-compatible services.
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  signedGetUrl(key: string, ttlSec: number, opts?: { contentType?: string; filename?: string }): Promise<string>;
  getStream(key: string): Promise<{ body: Readable; contentType?: string; contentLength?: number }>;
  deleteMany(keys: string[]): Promise<void>;
  ready(): Promise<void>;
  ensureBucket(): Promise<void>;
}

export class S3Storage implements ObjectStorage {
  private client: S3Client;
  private signer: S3Client;
  private bucket: string;

  constructor(cfg: Config['s3']) {
    const base = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // Checksums on every request are not supported by all S3-compatible servers.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...base, endpoint: cfg.endpoint });
    // Presigned URLs embed the host, so sign with the publicly reachable endpoint.
    this.signer = new S3Client({ ...base, endpoint: cfg.publicEndpoint });
    this.bucket = cfg.bucket;
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'private, max-age=31536000, immutable' }),
    );
  }

  signedGetUrl(key: string, ttlSec: number, opts: { contentType?: string; filename?: string } = {}) {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: opts.filename ? `inline; filename="${opts.filename}"` : undefined,
      }),
      { expiresIn: ttlSec },
    );
  }

  async getStream(key: string) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { body: out.Body as Readable, contentType: out.ContentType, contentLength: out.ContentLength };
  }

  async deleteMany(keys: string[]) {
    if (!keys.length) return;
    await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
  }

  async ready() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async ensureBucket() {
    try {
      await this.ready();
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
}
