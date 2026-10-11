import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, createGallery, registerUser, startServer, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => srv?.close());

describe('username + password accounts', () => {
  it('registers with only a username and password; login is case-insensitive', async () => {
    const anon = client(srv.base);
    const username = `Ada_${Date.now().toString(36)}`;
    const r = await anon.post('/v1/auth/register', { username, password: 'correct-horse-1' });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ username, displayName: username });
    expect(r.body.user).not.toHaveProperty('email');

    const login = await anon.post('/v1/auth/login', { username: username.toUpperCase(), password: 'correct-horse-1' });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe(username);
    const me = await client(srv.base, login.body.tokens.accessToken).get('/v1/auth/me');
    expect(me.body.username).toBe(username);
  });

  it('rejects duplicate (case-insensitive), malformed and email-style input', async () => {
    const anon = client(srv.base);
    const username = `dup-${Date.now().toString(36)}`;
    expect((await anon.post('/v1/auth/register', { username, password: 'correct-horse-1' })).status).toBe(201);
    const dup = await anon.post('/v1/auth/register', { username: username.toUpperCase(), password: 'correct-horse-1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('USERNAME_TAKEN');
    for (const bad of ['ab', 'has space', 'x'.repeat(31), 'emoji😀', 'a@b.com'])
      expect((await anon.post('/v1/auth/register', { username: bad, password: 'correct-horse-1' })).status).toBe(400);
    expect((await anon.post('/v1/auth/register', { username: 'okname', password: 'short' })).status).toBe(400);
    expect((await anon.post('/v1/auth/register', { email: 'a@b.com', password: 'correct-horse-1' })).status).toBe(400);
  });

  it('gives the same error for an unknown user and a wrong password', async () => {
    const u = await registerUser(srv.base, 'Bob');
    const wrong = await client(srv.base).post('/v1/auth/login', { username: u.username, password: 'wrong-password' });
    const unknown = await client(srv.base).post('/v1/auth/login', { username: 'nobody-here-xyz', password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: wrong.body.error.message });
    expect(wrong.body.error.message).toBe('Username or password is incorrect.');
  });

  it('changes the password, keeps this session and signs out the others', async () => {
    const u = await registerUser(srv.base, 'Cara');
    const other = await client(srv.base).post('/v1/auth/login', { username: u.username, password: 'correct-horse-1' });
    const otherApi = client(srv.base, other.body.tokens.accessToken);

    expect((await u.api.post('/v1/auth/password', { currentPassword: 'nope-nope-1', newPassword: 'new-horse-22' })).status).toBe(401);
    expect((await u.api.post('/v1/auth/password', { currentPassword: 'correct-horse-1', newPassword: 'new-horse-22' })).status).toBe(204);
    expect((await u.api.get('/v1/auth/me')).status).toBe(200);
    expect((await otherApi.get('/v1/auth/me')).status).toBe(401);
    expect((await client(srv.base).post('/v1/auth/login', { username: u.username, password: 'correct-horse-1' })).status).toBe(401);
    expect((await client(srv.base).post('/v1/auth/login', { username: u.username, password: 'new-horse-22' })).status).toBe(200);
  });

  it('owners add members by username', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const friend = await registerUser(srv.base, 'Friend');
    const g = await createGallery(owner.api);
    const r = await owner.api.post(`/v1/galleries/${g.id}/members`, { username: friend.username.toUpperCase(), role: 'editor' });
    expect(r.body).toMatchObject({ userId: friend.id, username: friend.username, role: 'editor', source: 'direct' });
    expect((await owner.api.post(`/v1/galleries/${g.id}/members`, { username: 'no-such-user-xyz', role: 'viewer' })).status).toBe(404);
    const members = (await owner.api.get(`/v1/galleries/${g.id}/members`)).body.items;
    expect(members.map((m: any) => m.username)).toEqual([owner.username, friend.username]);
  });
});

describe('migration 004 (email -> username)', () => {
  it('derives unique usernames from existing email accounts and drops email', async () => {
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    const dbName = `gallery_test_mig_${Date.now().toString(36)}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: url.toString() });
    try {
      await db.connect();
      for (const f of ['001_init.sql', '002_sharing_assistant.sql', '003_donations.sql']) await db.query(await readFile(`migrations/${f}`, 'utf8'));
      await db.query(
        // The oldest account keeps the plain username; later duplicates get a suffix.
        `INSERT INTO users (email, password_hash, display_name, created_at) VALUES
           ('Jean.Pierre@example.com', 'x', 'a', now() - interval '2 days'), ('jean.pierre@other.org', 'x', 'b', now() - interval '1 day'),
           ('ab@x.io', 'x', 'c', now()), ('min+ji@x.io', 'x', 'd', now())`,
      );
      await db.query(await readFile('migrations/004_usernames.sql', 'utf8'));
      const { rows } = await db.query(`SELECT display_name, username FROM users ORDER BY display_name`);
      const names = Object.fromEntries(rows.map((r) => [r.display_name, r.username]));
      expect(names.a).toBe('jean.pierre');
      expect(names.b).toMatch(/^jean\.pierre-[0-9a-f]{6}$/);
      expect(names.c).toBe('userab');
      expect(names.d).toBe('minji');
      const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`);
      expect(cols.rows.map((r) => r.column_name)).not.toContain('email');
    } finally {
      await db.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });
});
