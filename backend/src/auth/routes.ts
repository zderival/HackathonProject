import { Type } from 'typebox';
import type { App } from '../app.js';
import { requireUser } from '../http/context.js';
import { AppError } from '../lib/errors.js';
import { LangSchema as Lang } from '../lib/i18n.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { ErrorResponse } from '../schemas/api.js';

export const Username = Type.String({
  pattern: '^[A-Za-z0-9_.-]{3,30}$',
  description: '3-30 characters: letters, digits, "_", ".", "-". Unique, case-insensitive.',
});
const Password = Type.String({ minLength: 8, maxLength: 200 });

const User = Type.Object({
  id: Type.String({ format: 'uuid' }),
  username: Type.String(),
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
  // Per-IP+username login throttle (in-memory; single instance).
  const loginLimiter = new RateLimiter(app.deps.config.limits.authAttemptsPerMinute, 60_000);

  app.post(
    '/v1/auth/register',
    {
      schema: {
        tags: ['auth'],
        summary: 'Create an account (username + password)',
        description: 'There is no email and therefore no password recovery: a forgotten password cannot be reset. Users can change their password while signed in.',
        body: Type.Object(
          {
            username: Username,
            password: Password,
            displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'Defaults to the username.' })),
            preferredLanguage: Type.Optional(Lang),
          },
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
        body: Type.Object({ username: Type.String({ minLength: 1, maxLength: 30 }), password: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
        response: { 200: AuthResult, 401: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (req) => {
      if (!loginLimiter.take(`login:${req.ip}:${req.body.username.trim().toLowerCase()}`)) throw new AppError('RATE_LIMITED');
      return auth.login(req.body.username, req.body.password, req.headers['user-agent']);
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

  app.post(
    '/v1/auth/password',
    {
      schema: {
        tags: ['auth'],
        summary: 'Change your password (signs out your other sessions)',
        body: Type.Object({ currentPassword: Type.String({ maxLength: 200 }), newPassword: Password }, { additionalProperties: false }),
        response: { 204: Type.Null(), 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      if (!loginLimiter.take(`pw:${u.userId}`)) throw new AppError('RATE_LIMITED');
      await auth.changePassword(u.userId, u.sessionId, req.body.currentPassword, req.body.newPassword);
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
