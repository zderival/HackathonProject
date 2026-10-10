// Minimal forward-only migration runner: applies migrations/*.sql in filename order,
// each inside its own transaction, and records them in schema_migrations.
import { existsSync as fsExists } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

function findMigrationsDir(): string {
  // Works from src/db (tsx) and dist/src/db (compiled).
  const candidates = [path.resolve(here, '../../migrations'), path.resolve(here, '../../../migrations')];
  return candidates.find((p) => p.endsWith('migrations') && fsExists(p)) ?? candidates[0];
}


export async function migrate(databaseUrl: string, ssl = false, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent runners (e.g. two instances booting).
    await client.query('SELECT pg_advisory_lock(728134)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = findMigrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(728134)').catch(() => {});
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url, process.env.DATABASE_SSL === 'true')
    .then((applied) => console.log(applied.length ? `done (${applied.length} applied)` : 'up to date'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
