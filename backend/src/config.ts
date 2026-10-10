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
      invitationTtlHours: int('INVITATION_TTL_HOURS', 7 * 24),
      pairingTtlSec: int('PAIRING_TTL_SEC', 600),
    },

    limits: {
      authAttemptsPerMinute: int('LIMIT_AUTH_ATTEMPTS_PER_MINUTE', 10),
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

    assistant: assistantConfig(nodeEnv),
    solana: solanaConfig(),
  };
}

// Optional donation wallets (custodial: the server holds each gallery wallet's key,
// encrypted with SOLANA_WALLET_ENCRYPTION_KEY). Off unless SOLANA_ENABLED=true.
function solanaConfig() {
  const enabled = bool('SOLANA_ENABLED', false);
  const cluster = str('SOLANA_CLUSTER', 'devnet') as 'devnet' | 'testnet' | 'mainnet-beta';
  if (!['devnet', 'testnet', 'mainnet-beta'].includes(cluster)) throw new Error('SOLANA_CLUSTER must be devnet, testnet or mainnet-beta');
  const allowMainnet = bool('SOLANA_ALLOW_MAINNET', false);
  if (enabled && cluster === 'mainnet-beta' && !allowMainnet)
    throw new Error('SOLANA_CLUSTER=mainnet-beta moves real money: set SOLANA_ALLOW_MAINNET=true only after reviewing docs/donations.md');
  const rawKey = process.env.SOLANA_WALLET_ENCRYPTION_KEY ?? '';
  let encryptionKey: Buffer | null = null;
  if (rawKey) {
    encryptionKey = /^[0-9a-fA-F]{64}$/.test(rawKey) ? Buffer.from(rawKey, 'hex') : Buffer.from(rawKey, 'base64');
    if (encryptionKey.length !== 32) throw new Error('SOLANA_WALLET_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  }
  if (enabled && !encryptionKey) throw new Error('SOLANA_ENABLED=true requires SOLANA_WALLET_ENCRYPTION_KEY (generate: npm run solana:keygen)');
  const defaultRpc = { devnet: 'https://api.devnet.solana.com', testnet: 'https://api.testnet.solana.com', 'mainnet-beta': 'https://api.mainnet-beta.solana.com' }[cluster];
  return {
    enabled,
    cluster,
    rpcUrl: str('SOLANA_RPC_URL', defaultRpc),
    encryptionKey,
    minDonationLamports: int('SOLANA_MIN_DONATION_LAMPORTS', 10_000),
    intentTtlSec: int('SOLANA_INTENT_TTL_SEC', 1800),
    pollIntervalMs: int('SOLANA_POLL_INTERVAL_MS', 15_000),
    withdrawalsPerHour: int('SOLANA_WITHDRAWALS_PER_HOUR', 5),
  };
}

function assistantConfig(nodeEnv: string) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  // "fake" is a deterministic test double; it is refused in production.
  const provider = str('ASSISTANT_PROVIDER', apiKey ? 'gemini' : 'disabled') as 'gemini' | 'fake' | 'disabled';
  if (!['gemini', 'fake', 'disabled'].includes(provider)) throw new Error('ASSISTANT_PROVIDER must be gemini, fake or disabled');
  if (provider === 'fake' && nodeEnv === 'production') throw new Error('ASSISTANT_PROVIDER=fake is not allowed in production');
  if (provider === 'gemini' && !apiKey) throw new Error('ASSISTANT_PROVIDER=gemini requires GEMINI_API_KEY');
  return {
    provider,
    geminiApiKey: apiKey,
    // Model names change often: keep them configurable and verify with `npm run smoke:gemini`.
    planModel: str('GEMINI_MODEL', 'gemini-3.8-flash'),
    ttsModel: str('GEMINI_TTS_MODEL', 'gemini-3.8-flash-tts'),
    ttsVoice: str('GEMINI_TTS_VOICE', 'Kore'),
    timeoutMs: int('ASSISTANT_TIMEOUT_MS', 25_000),
    ttsTimeoutMs: int('ASSISTANT_TTS_TIMEOUT_MS', 30_000),
    maxRetries: int('ASSISTANT_MAX_RETRIES', 2),
    concurrency: int('ASSISTANT_CONCURRENCY', 4),
    commandsPerMinute: int('ASSISTANT_COMMANDS_PER_MINUTE', 12),
    maxInputChars: int('ASSISTANT_MAX_INPUT_CHARS', 1000),
    maxHistoryTurns: int('ASSISTANT_MAX_HISTORY_TURNS', 8),
    maxContextNodes: int('ASSISTANT_MAX_CONTEXT_NODES', 200),
    maxAudioBytes: int('ASSISTANT_MAX_AUDIO_BYTES', 4 * 1024 * 1024),
    maxAudioSeconds: int('ASSISTANT_MAX_AUDIO_SECONDS', 30),
    maxSpeechChars: int('ASSISTANT_MAX_SPEECH_CHARS', 600),
  };
}

export type Config = ReturnType<typeof loadConfig>;
