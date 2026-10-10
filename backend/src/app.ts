import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance, type FastifyBaseLogger, type RawServerDefault, type RawRequestDefaultExpression, type RawReplyDefaultExpression } from 'fastify';
import { Ajv } from 'ajv';
import addFormatsImport from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { actionRoutes } from './actions/routes.js';
import { ActionService } from './actions/service.js';
import { assetRoutes } from './assets/routes.js';
import { AssetService } from './assets/service.js';
import type { ObjectStorage } from './assets/storage.js';
import { authRoutes } from './auth/routes.js';
import { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { galleryRoutes } from './galleries/routes.js';
import { langFor, resolveCaller } from './http/context.js';
import { AppError, ERROR_STATUS, localizedMessage, type ErrorCode } from './lib/errors.js';
import { RealtimeHub } from './realtime/hub.js';
import { realtimeRoutes } from './realtime/routes.js';
import { ajv } from './scene/validate.js';

export interface Deps {
  config: Config;
  db: Db;
  storage: ObjectStorage;
  auth: AuthService;
  actions: ActionService;
  assets: AssetService;
  hub: RealtimeHub;
}

export type App = FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, FastifyBaseLogger, TypeBoxTypeProvider> & {
  deps: Deps;
};

export async function buildApp(opts: { config: Config; db: Db; storage: ObjectStorage }): Promise<App> {
  const { config, db, storage } = opts;
  const fastify = Fastify({
    logger:
      config.nodeEnv === 'development'
        ? { level: config.logLevel, transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : { level: config.logLevel, redact: ['req.headers.authorization', 'req.query.ticket'] },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{8,100}$/.test(incoming) ? incoming : randomUUID();
    },
    ajv: { customOptions: { allErrors: false, coerceTypes: 'array', removeAdditional: false }, plugins: [] },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const app = fastify as unknown as App;
  // Fastify's Ajv adds formats via its own plugin; reuse our configured instance for body validation.
  app.setValidatorCompiler(({ schema, httpPart }) => {
    if (httpPart === 'querystring' || httpPart === 'params') return querystringAjv(schema);
    return ajv.compile(schema);
  });

  const auth = new AuthService(db, config);
  let hubRef: RealtimeHub;
  const actions = new ActionService(db, config, { publish: (e) => hubRef.publish(e) });
  const hub = (hubRef = new RealtimeHub({
    db,
    eventsSince: (g, after) => actions.eventsSince(g, after),
    maxBufferedBytes: config.limits.wsMaxBufferedBytes,
    maxSyncBuffer: 1000,
    log: app.log,
  }));
  const assets = new AssetService(db, storage, config);
  app.decorate('deps', { config, db, storage, auth, actions, assets, hub });

  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: false,
    exposedHeaders: ['x-request-id'],
    allowedHeaders: ['authorization', 'content-type', 'x-gallery-link', 'x-request-id', 'accept-language'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(multipart, { limits: { fileSize: config.limits.maxUploadBytes, files: 1 } });
  await app.register(websocket, { options: { maxPayload: config.limits.wsMaxMessageBytes } });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Virtual Gallery Backend',
        version: '1.0.0',
        description: 'Scene, collaboration, asset and assistant API. Real-time protocol: docs/websocket-protocol.md.',
      },
      servers: [{ url: config.publicApiUrl }],
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', description: 'User access token (at_...) or read-only viewer token (vs_...).' },
        },
      },
      security: [{ bearer: [] }],
    },
  });

  app.decorateRequest('caller', null as any);
  app.decorateRequest('lang', 'en');
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    req.lang = langFor(req);
    const { caller, lang } = await resolveCaller(req, auth, db);
    req.caller = caller;
    req.lang = langFor(req, lang);
  });

  app.setErrorHandler((err: any, req, reply) => {
    let code: ErrorCode;
    let details: Record<string, unknown> | undefined;
    if (err instanceof AppError) {
      code = err.code;
      details = err.details;
    } else if (err.validation) {
      code = 'VALIDATION_FAILED';
      details = {
        context: err.validationContext,
        issues: err.validation.slice(0, 10).map((v: any) => ({ path: v.instancePath, message: v.message, params: v.params })),
      };
    } else if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
      code = 'PAYLOAD_TOO_LARGE';
    } else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.statusCode === 415) {
      code = 'UNSUPPORTED_MEDIA_TYPE';
    } else if (err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      code = 'VALIDATION_FAILED';
      details = { reason: err.message };
    } else if (err.statusCode === 404) {
      code = 'NOT_FOUND';
    } else {
      code = 'INTERNAL';
      req.log.error({ err }, 'unhandled error');
    }
    reply.status(ERROR_STATUS[code]).send({ error: { code, message: localizedMessage(code, req.lang ?? 'en'), details, requestId: req.id } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: localizedMessage('NOT_FOUND', req.lang ?? 'en'), requestId: req.id } });
  });

  app.get('/health', { schema: { tags: ['ops'], summary: 'Liveness', security: [] } }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: { tags: ['ops'], summary: 'Readiness: database and object storage reachable', security: [] } }, async (_req, reply) => {
    const checks: Record<string, string> = {};
    await db.query('SELECT 1').then(
      () => (checks.database = 'ok'),
      (e) => (checks.database = `error: ${e.message}`),
    );
    await storage.ready().then(
      () => (checks.storage = 'ok'),
      (e) => (checks.storage = `error: ${e.name ?? e.message}`),
    );
    const ok = Object.values(checks).every((v) => v === 'ok');
    reply.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'not_ready', checks, realtimeConnections: hub.connectionCount() };
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  await app.register(async (scope) => {
    const s = scope as unknown as App;
    s.deps = app.deps;
    await authRoutes(s);
    await galleryRoutes(s);
    await actionRoutes(s);
    await assetRoutes(s);
    await realtimeRoutes(s);
  });

  const heartbeat = setInterval(() => hub.heartbeat(), config.heartbeatMs);
  heartbeat.unref();
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    hub.closeAll(1001, 'server shutting down');
  });

  return app;
}

// Query strings/params arrive as strings; coerce them to the declared types.
const addFormats = ((addFormatsImport as any).default ?? addFormatsImport) as (a: Ajv) => Ajv;
const qsAjv = addFormats(new Ajv({ coerceTypes: 'array', useDefaults: true, removeAdditional: false, strict: false }));
const querystringAjv = (schema: object) => qsAjv.compile(schema);
