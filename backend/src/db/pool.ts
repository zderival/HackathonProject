import pg from 'pg';

// Return bigint revisions (int8) as JS numbers; revisions stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

export function createPool(databaseUrl: string, ssl: boolean): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
