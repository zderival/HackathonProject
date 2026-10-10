// Reads configuration from environment variables. Every limit here is a demo starting
// assumption, not a measured capacity guarantee.

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export function loadConfig() {
  const nodeEnv = str('NODE_ENV', 'development');
  return {
    nodeEnv,
    port: int('PORT', 8080),
    host: str('HOST', '0.0.0.0'),
    logLevel: str('LOG_LEVEL', nodeEnv === 'test' ? 'warn' : 'info'),
    databaseUrl: str('DATABASE_URL'),
    databaseSsl: bool('DATABASE_SSL', false),

    publicApiUrl: str('PUBLIC_API_URL', 'http://localhost:8080'),
    publicWebUrl: str('PUBLIC_WEB_URL', 'http://localhost:5173'),
    // Universal-link base handled by the iOS app (falls back to the web landing page).
    deepLinkBaseUrl: str('DEEP_LINK_BASE_URL', 'http://localhost:5173'),
    corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: bool('TRUST_PROXY', false),

    s3: {
      endpoint: process.env.S3_ENDPOINT || undefined,
      // Endpoint used when signing URLs handed to browsers/phones.
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || undefined,
      region: str('S3_REGION', 'us-east-1'),
      bucket: str('S3_BUCKET', 'gallery-assets'),
      accessKeyId: str('S3_ACCESS_KEY_ID'),
      secretAccessKey: str('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
      createBucket: bool('S3_CREATE_BUCKET', nodeEnv !== 'production'),
    },
    signedUrlTtlSec: int('SIGNED_URL_TTL_SEC', 900),

    auth: {
      accessTtlSec: int('ACCESS_TOKEN_TTL_SEC', 900),
      refreshTtlSec: int('REFRESH_TOKEN_TTL_SEC', 30 * 24 * 3600),
      wsTicketTtlSec: int('WS_TICKET_TTL_SEC', 60),
      viewerSessionTtlSec: int('VIEWER_SESSION_TTL_SEC', 12 * 3600),
    },

    limits: {
      maxEditorsPerGallery: int('LIMIT_EDITORS_PER_GALLERY', 5),
      maxViewerConnectionsPerGallery: int('LIMIT_VIEWER_CONNECTIONS_PER_GALLERY', 10),
      maxEditorConnectionsPerGallery: int('LIMIT_EDITOR_CONNECTIONS_PER_GALLERY', 10),
      maxNodes: int('LIMIT_MAX_NODES', 2000),
      maxOpsPerBatch: int('LIMIT_MAX_OPS_PER_BATCH', 200),
      maxSceneBytes: int('LIMIT_MAX_SCENE_BYTES', 2_000_000),
      maxUploadBytes: int('LIMIT_MAX_UPLOAD_BYTES', 20 * 1024 * 1024),
      maxImagePixels: int('LIMIT_MAX_IMAGE_PIXELS', 40_000_000),
      eventReplayWindow: int('LIMIT_EVENT_REPLAY_WINDOW', 500),
      wsMaxBufferedBytes: int('LIMIT_WS_MAX_BUFFERED_BYTES', 4 * 1024 * 1024),
      wsMaxMessageBytes: int('LIMIT_WS_MAX_MESSAGE_BYTES', 256 * 1024),
    },
    heartbeatMs: int('WS_HEARTBEAT_MS', 25_000),
  };
}

export type Config = ReturnType<typeof loadConfig>;
