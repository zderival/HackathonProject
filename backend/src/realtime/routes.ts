import { Type } from 'typebox';
import type { App } from '../app.js';
import type { ActionSource } from '../actions/service.js';
import { capabilitiesFor, requireAccess, resolveAccess } from '../galleries/access.js';
import { principalFor, requireUser } from '../http/context.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError, localizedMessage } from '../lib/errors.js';
import { ErrorResponse, GalleryIdParams } from '../schemas/api.js';
import { ActionRequest } from '../schemas/operations.js';
import { ajv } from '../scene/validate.js';
import { CLOSE, type Connection } from './hub.js';

const ClientMessage = Type.Union([
  Type.Object({ type: Type.Literal('ping'), t: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal('resync'), fromRevision: Type.Optional(Type.Integer({ minimum: 0 })) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('submit'),
      clientMsgId: Type.String({ maxLength: 100 }),
      action: ActionRequest,
    },
    { additionalProperties: false },
  ),
]);
const validateClientMessage = ajv.compile(ClientMessage);

export async function realtimeRoutes(app: App) {
  const { db, hub, actions, config } = app.deps;

  app.post(
    '/v1/galleries/:galleryId/viewer-sessions',
    {
      schema: {
        tags: ['realtime'],
        summary: 'Create a read-only viewer session (phone / preview)',
        description:
          'Returns a vs_ token usable only for reading this gallery (scene, assets, events, view tickets). It can never write, use the assistant or manage permissions, even if the account is an editor. Access is re-evaluated on every use.',
        params: GalleryIdParams,
        body: Type.Optional(
          Type.Object({ kind: Type.Optional(Type.Union([Type.Literal('viewer'), Type.Literal('preview')])) }, { additionalProperties: false }),
        ),
        response: {
          201: Type.Object({
            viewerToken: Type.String(),
            galleryId: Type.String(),
            kind: Type.String(),
            expiresAt: Type.String({ format: 'date-time' }),
          }),
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const galleryId = req.params.galleryId;
      const p = principalFor(req, galleryId);
      await requireAccess(db, galleryId, p, 'view');
      const kind = req.body?.kind ?? 'viewer';
      if (kind === 'preview' && req.caller.kind !== 'user') throw new AppError('FORBIDDEN');
      const token = randomToken('vs');
      const expiresAt = new Date(Date.now() + config.auth.viewerSessionTtlSec * 1000);
      await db.query(
        `INSERT INTO viewer_sessions (token_hash, gallery_id, user_id, link_token, kind, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sha256(token), galleryId, p.userId, p.linkToken ?? null, kind, req.caller.kind === 'user' ? req.caller.userId : null, expiresAt],
      );
      reply.code(201);
      return { viewerToken: token, galleryId, kind, expiresAt: expiresAt.toISOString() };
    },
  );

  app.post(
    '/v1/galleries/:galleryId/realtime-tickets',
    {
      schema: {
        tags: ['realtime'],
        summary: 'Get a single-use ticket for the gallery WebSocket',
        description: `Tickets expire after ${config.auth.wsTicketTtlSec}s and work once. capability "edit" requires editor access and a user session; viewer sessions always get "view".`,
        params: GalleryIdParams,
        body: Type.Object({ capability: Type.Union([Type.Literal('edit'), Type.Literal('view')]) }, { additionalProperties: false }),
        response: {
          201: Type.Object({ ticket: Type.String(), url: Type.String(), capability: Type.String(), expiresAt: Type.String({ format: 'date-time' }) }),
          403: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const galleryId = req.params.galleryId;
      const p = principalFor(req, galleryId);
      const capability = req.body.capability;
      if (capability === 'edit') requireUser(req);
      await requireAccess(db, galleryId, p, capability === 'edit' ? 'edit' : 'view');
      const ticket = randomToken('wst', 24);
      const expiresAt = new Date(Date.now() + config.auth.wsTicketTtlSec * 1000);
      await db.query(
        `INSERT INTO ws_tickets (ticket_hash, gallery_id, user_id, viewer_session_id, capability, link_token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sha256(ticket), galleryId, p.userId, req.caller.kind === 'viewer' ? req.caller.viewerSessionId : null, capability, p.linkToken ?? null, expiresAt],
      );
      const wsBase = config.publicApiUrl.replace(/^http/, 'ws');
      reply.code(201);
      return { ticket, url: `${wsBase}/v1/ws?ticket=${encodeURIComponent(ticket)}`, capability, expiresAt: expiresAt.toISOString() };
    },
  );

  app.get(
    '/v1/ws',
    {
      websocket: true,
      schema: {
        tags: ['realtime'],
        summary: 'Gallery WebSocket (see docs/websocket-protocol.md)',
        querystring: Type.Object({ ticket: Type.String({ maxLength: 200 }) }),
      },
    },
    async (socket, req) => {
      const ticket = (req.query as { ticket: string }).ticket;
      // Ticket is consumed atomically: single use even under concurrent connects.
      const { rows } = await db.query(
        `UPDATE ws_tickets SET used_at = now()
         WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING gallery_id, user_id, viewer_session_id, capability, link_token`,
        [sha256(ticket)],
      );
      const t = rows[0];
      if (!t) {
        socket.send(JSON.stringify({ type: 'error', code: 'TICKET_INVALID', message: localizedMessage('TICKET_INVALID', req.lang), fatal: true }));
        socket.close(CLOSE.TICKET_INVALID, 'ticket invalid');
        return;
      }
      // A revoked/expired viewer session resolves to no access below.
      const principal = {
        userId: t.user_id as string | null,
        linkToken: t.link_token as string | null,
        readOnly: t.capability === 'view',
        viewerSessionId: t.viewer_session_id as string | null,
      };
      const access = await resolveAccess(db, t.gallery_id, principal).catch(() => null);
      const caps = capabilitiesFor(access?.role ?? null, principal.readOnly);
      if (!access?.role || (t.capability === 'edit' && !caps.canEdit)) {
        socket.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: localizedMessage('FORBIDDEN', req.lang), fatal: true }));
        socket.close(CLOSE.ACCESS_REVOKED, 'access denied');
        return;
      }
      const limit = t.capability === 'edit' ? config.limits.maxEditorConnectionsPerGallery : config.limits.maxViewerConnectionsPerGallery;
      if (hub.countByCapability(t.gallery_id, t.capability) >= limit) {
        socket.send(JSON.stringify({ type: 'error', code: 'LIMIT_EXCEEDED', message: localizedMessage('LIMIT_EXCEEDED', req.lang), fatal: true, details: { limit } }));
        socket.close(CLOSE.TOO_MANY_CONNECTIONS, 'too many connections');
        return;
      }

      // Register BEFORE reading the snapshot: anything committed after this point is
      // buffered, anything before it is in the snapshot (no lost changes).
      const conn: Connection = hub.register({ ws: socket, galleryId: t.gallery_id, principal, capability: t.capability, role: access.role, lang: req.lang });
      socket.on('pong', () => (conn.alive = true));
      socket.on('close', () => hub.unregister(conn));
      socket.on('error', () => hub.unregister(conn));
      socket.on('message', (raw, isBinary) => {
        conn.alive = true;
        void handleMessage(conn, raw.toString(), isBinary);
      });

      hub.send(conn, {
        type: 'hello',
        connectionId: conn.id,
        galleryId: conn.galleryId,
        role: conn.role,
        capability: conn.capability,
        ...caps,
        canEdit: conn.capability === 'edit',
        heartbeatMs: config.heartbeatMs,
        serverTime: new Date().toISOString(),
        protocolVersion: 1,
      });
      await hub.resyncSnapshot(conn, 'initial');
    },
  );

  async function handleMessage(conn: Connection, raw: string, isBinary: boolean) {
    let msg: any;
    try {
      if (isBinary) throw new Error('binary');
      msg = JSON.parse(raw);
    } catch {
      hub.send(conn, { type: 'error', code: 'VALIDATION_FAILED', message: 'messages must be JSON text' });
      return;
    }
    if (!validateClientMessage(msg)) {
      hub.send(conn, {
        type: 'error',
        code: 'VALIDATION_FAILED',
        clientMsgId: typeof msg?.clientMsgId === 'string' ? msg.clientMsgId : undefined,
        message: 'invalid message',
        details: { errors: validateClientMessage.errors?.slice(0, 5).map((e) => `${e.instancePath} ${e.message}`) },
      });
      return;
    }
    const m = msg as any;
    switch (m.type) {
      case 'ping':
        hub.send(conn, { type: 'pong', t: m.t, serverTime: new Date().toISOString(), revision: conn.lastRevision });
        return;
      case 'resync':
        if (m.fromRevision !== undefined && conn.state === 'live') {
          // Client says it has fromRevision; send everything after it (or a snapshot).
          conn.lastRevision = Math.min(conn.lastRevision, m.fromRevision);
          await hub.replay(conn);
        } else {
          await hub.resyncSnapshot(conn, 'requested');
        }
        return;
      case 'submit': {
        if (conn.capability !== 'edit' || !conn.principal.userId) {
          hub.send(conn, { type: 'error', code: 'FORBIDDEN', clientMsgId: msg.clientMsgId, message: localizedMessage('FORBIDDEN', conn.lang) });
          return;
        }
        try {
          const r = await actions.submit(conn.galleryId, { ...conn.principal, userId: conn.principal.userId }, msg.action, 'manual' as ActionSource);
          hub.send(conn, {
            type: 'ack',
            clientMsgId: msg.clientMsgId,
            requestId: r.requestId,
            actionId: r.actionId,
            revision: r.revision,
            duplicate: r.duplicate,
            noop: r.noop,
          });
        } catch (err) {
          const e = err instanceof AppError ? err : new AppError('INTERNAL');
          if (!(err instanceof AppError)) app.log.error({ err }, 'ws submit failed');
          hub.send(conn, {
            type: 'error',
            clientMsgId: msg.clientMsgId,
            requestId: msg.action.requestId,
            code: e.code,
            message: localizedMessage(e.code, conn.lang),
            details: e.details,
          });
          // A permission failure means our cached capability is stale.
          if (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND') await hub.recheckConnection(conn);
        }
        return;
      }
    }
  }
}
