import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import type { Principal } from '../galleries/access.js';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { pickLanguage, type Lang } from '../lib/i18n.js';
import type { AuthService } from '../auth/service.js';

// Who is calling. Resolved once per request from the Authorization header.
export type Caller =
  | { kind: 'anonymous' }
  | { kind: 'user'; userId: string; sessionId: string }
  // Read-only phone/preview session scoped to one gallery.
  | { kind: 'viewer'; viewerSessionId: string; galleryId: string; userId: string | null; linkToken: string | null };

declare module 'fastify' {
  interface FastifyRequest {
    caller: Caller;
    lang: Lang;
  }
}

export async function resolveCaller(req: FastifyRequest, auth: AuthService, db: Db): Promise<{ caller: Caller; lang?: Lang }> {
  const header = req.headers.authorization;
  if (!header) return { caller: { kind: 'anonymous' } };
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new AppError('UNAUTHENTICATED');
  const token = m[1];
  if (token.startsWith('at_')) {
    const s = await auth.authenticateAccessToken(token);
    if (!s) throw new AppError('UNAUTHENTICATED');
    return { caller: { kind: 'user', userId: s.userId, sessionId: s.sessionId }, lang: s.lang };
  }
  if (token.startsWith('vs_')) {
    const { rows } = await db.query(
      `SELECT id, gallery_id, user_id, link_token FROM viewer_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [sha256(token)],
    );
    if (!rows[0]) throw new AppError('UNAUTHENTICATED');
    const r = rows[0];
    return { caller: { kind: 'viewer', viewerSessionId: r.id, galleryId: r.gallery_id, userId: r.user_id, linkToken: r.link_token } };
  }
  throw new AppError('UNAUTHENTICATED');
}

// Share-link token supplied by clients that opened the gallery through a link.
export function linkTokenOf(req: FastifyRequest): string | null {
  const h = req.headers['x-gallery-link'];
  if (typeof h === 'string' && h) return h;
  const q = (req.query as Record<string, unknown> | undefined)?.link;
  return typeof q === 'string' && q ? q : null;
}

// Principal used for gallery authorization.
export function principalFor(req: FastifyRequest, galleryId: string): Principal {
  const c = req.caller;
  if (c.kind === 'viewer') {
    if (c.galleryId !== galleryId) throw new AppError('NOT_FOUND', { what: 'gallery' });
    return { userId: c.userId, linkToken: c.linkToken, readOnly: true, viewerSessionId: c.viewerSessionId };
  }
  return { userId: c.kind === 'user' ? c.userId : null, linkToken: linkTokenOf(req) };
}

export function requireUser(req: FastifyRequest): { userId: string; sessionId: string } {
  if (req.caller.kind !== 'user') throw new AppError('UNAUTHENTICATED');
  return req.caller;
}

export function langFor(req: FastifyRequest, userLang?: Lang): Lang {
  const header = req.headers['accept-language'];
  return header ? pickLanguage(header, userLang ?? 'en') : (userLang ?? 'en');
}

export type Reply = FastifyReply;
