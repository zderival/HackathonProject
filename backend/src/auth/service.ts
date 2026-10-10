import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { Lang } from '../lib/i18n.js';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  preferred_language: Lang;
  created_at: Date;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    preferredLanguage: u.preferred_language,
    createdAt: u.created_at.toISOString(),
  };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  tokenType: 'Bearer';
}

export class AuthService {
  constructor(
    private db: Db,
    private config: Config,
  ) {}

  async register(input: { email: string; password: string; displayName: string; preferredLanguage?: Lang }, userAgent?: string) {
    const email = input.email.trim().toLowerCase();
    const hash = await hashPassword(input.password);
    try {
      const { rows } = await this.db.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name, preferred_language)
         VALUES ($1, $2, $3, $4) RETURNING id, email, display_name, preferred_language, created_at`,
        [email, hash, input.displayName.trim(), input.preferredLanguage ?? 'en'],
      );
      const tokens = await this.createSession(rows[0].id, userAgent);
      return { user: publicUser(rows[0]), tokens };
    } catch (err: any) {
      if (err.code === '23505') throw new AppError('EMAIL_TAKEN');
      throw err;
    }
  }

  async login(emailRaw: string, password: string, userAgent?: string) {
    const email = emailRaw.trim().toLowerCase();
    const { rows } = await this.db.query<UserRow & { password_hash: string }>(
      `SELECT id, email, display_name, preferred_language, created_at, password_hash FROM users WHERE lower(email) = $1`,
      [email],
    );
    const user = rows[0];
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new AppError('INVALID_CREDENTIALS');
    const tokens = await this.createSession(user.id, userAgent);
    return { user: publicUser(user), tokens };
  }

  async createSession(userId: string, userAgent?: string): Promise<TokenPair> {
    const accessToken = randomToken('at');
    const refreshToken = randomToken('rt');
    const now = Date.now();
    const accessExpiresAt = new Date(now + this.config.auth.accessTtlSec * 1000);
    const refreshExpiresAt = new Date(now + this.config.auth.refreshTtlSec * 1000);
    await this.db.query(
      `INSERT INTO auth_sessions (user_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, sha256(accessToken), sha256(refreshToken), accessExpiresAt, refreshExpiresAt, userAgent?.slice(0, 300) ?? null],
    );
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshExpiresAt: refreshExpiresAt.toISOString(),
      tokenType: 'Bearer',
    };
  }

  // Rotates both tokens. A refresh token can be used exactly once.
  async refresh(refreshToken: string): Promise<TokenPair> {
    const accessToken = randomToken('at');
    const newRefresh = randomToken('rt');
    const now = Date.now();
    const accessExpiresAt = new Date(now + this.config.auth.accessTtlSec * 1000);
    const refreshExpiresAt = new Date(now + this.config.auth.refreshTtlSec * 1000);
    const { rowCount } = await this.db.query(
      `UPDATE auth_sessions SET access_hash = $2, refresh_hash = $3, access_expires_at = $4, refresh_expires_at = $5
       WHERE refresh_hash = $1 AND revoked_at IS NULL AND refresh_expires_at > now()`,
      [sha256(refreshToken), sha256(accessToken), sha256(newRefresh), accessExpiresAt, refreshExpiresAt],
    );
    if (!rowCount) throw new AppError('UNAUTHENTICATED');
    return {
      accessToken,
      refreshToken: newRefresh,
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshExpiresAt: refreshExpiresAt.toISOString(),
      tokenType: 'Bearer',
    };
  }

  async authenticateAccessToken(token: string): Promise<{ userId: string; sessionId: string; lang: Lang } | null> {
    const { rows } = await this.db.query(
      `SELECT s.id, s.user_id, u.preferred_language FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.access_hash = $1 AND s.revoked_at IS NULL AND s.access_expires_at > now()`,
      [sha256(token)],
    );
    if (!rows[0]) return null;
    return { userId: rows[0].user_id, sessionId: rows[0].id, lang: rows[0].preferred_language };
  }

  async revokeSession(sessionId: string) {
    await this.db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
  }

  async revokeAllSessions(userId: string) {
    await this.db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }

  async getUser(userId: string) {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id, email, display_name, preferred_language, created_at FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND');
    return publicUser(rows[0]);
  }

  async updateProfile(userId: string, patch: { displayName?: string; preferredLanguage?: Lang }) {
    await this.db.query(
      `UPDATE users SET display_name = COALESCE($2, display_name), preferred_language = COALESCE($3, preferred_language) WHERE id = $1`,
      [userId, patch.displayName?.trim() ?? null, patch.preferredLanguage ?? null],
    );
    return this.getUser(userId);
  }
}

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
