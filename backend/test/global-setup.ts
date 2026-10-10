// Resets the test database and applies migrations once per `npm test` run.
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

export default async function setup() {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* rely on the environment */
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
  if (!/test/i.test(url)) throw new Error('Refusing to reset a database whose URL does not contain "test"');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await migrate(url, false, () => {});
}
