import { Type } from 'typebox';
import type { App } from '../app.js';
import { requireUser } from '../http/context.js';
import { AppError } from '../lib/errors.js';
import { LangSchema as Lang } from '../lib/i18n.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { ErrorResponse } from '../schemas/api.js';

const Email = Type.String({ format: 'email', maxLength: 254 });
const Password = Type.String({ minLength: 8, maxLength: 200 });

const User = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String(),
  displayName: Type.String(),
  preferredLanguage: Lang,
  createdAt: Type.String({ format: 'date-time' }),
});

const Tokens = Type.Object({
  accessToken: Type.String({ description: 'Send as "Authorization: Bearer <token>".' }),
  refreshToken: Type.String(),
  accessExpiresAt: Type.String({ format: 'date-time' }),
  refreshExpiresAt: Type.String({ format: 'date-time' }),
  tokenType: Type.Literal('Bearer'),
});

const AuthResult = Type.Object({ user: User, tokens: Tokens });

export async function authRoutes(app: App) {
  const { auth } = app.deps;
  // Per-IP+email login throttle (in-memory; single instance).
  const loginLimiter = new RateLimiter(10, 60_000);

  app.post(
    '/v1/auth/register',
    {
      schema: {
        tags: ['auth'],
        summary: 'Create an account (email/password)',
        body: Type.Object(
          { email: Email, password: Password, displayName: Type.String({ minLength: 1, maxLength: 80 }), preferredLanguage: Type.Optional(Lang) },
          { additionalProperties: false },
        ),
        response: { 201: AuthResult, 409: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!loginLimiter.take(`reg:${req.ip}`)) throw new AppError('RATE_LIMITED');
      const result = await auth.register(req.body, req.headers['user-agent']);
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/v1/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sign in',
        body: Type.Object({ email: Email, password: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
        response: { 200: AuthResult, 401: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (req) => {
      if (!loginLimiter.take(`login:${req.ip}:${req.body.email.toLowerCase()}`)) throw new AppError('RATE_LIMITED');
      return auth.login(req.body.email, req.body.password, req.headers['user-agent']);
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotate tokens using a refresh token (single use)',
        body: Type.Object({ refreshToken: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
        response: { 200: Type.Object({ tokens: Tokens }), 401: ErrorResponse },
      },
    },
    async (req) => ({ tokens: await auth.refresh(req.body.refreshToken) }),
  );

  app.post(
    '/v1/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke the current session (or all sessions)',
        body: Type.Optional(Type.Object({ allSessions: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      if (req.body?.allSessions) await auth.revokeAllSessions(u.userId);
      else await auth.revokeSession(u.sessionId);
      reply.code(204);
      return null;
    },
  );

  app.get('/v1/auth/me', { schema: { tags: ['auth'], summary: 'Current user', response: { 200: User } } }, async (req) =>
    auth.getUser(requireUser(req).userId),
  );

  app.patch(
    '/v1/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Update profile (display name, preferred language)',
        body: Type.Object(
          { displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), preferredLanguage: Type.Optional(Lang) },
          { additionalProperties: false },
        ),
        response: { 200: User },
      },
    },
    async (req) => auth.updateProfile(requireUser(req).userId, req.body),
  );
}
