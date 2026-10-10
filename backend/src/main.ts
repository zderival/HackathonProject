import { buildApp } from './app.js';
import { S3Storage } from './assets/storage.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
const db = createPool(config.databaseUrl, config.databaseSsl);
const storage = new S3Storage(config.s3);

if (process.env.MIGRATE_ON_START !== 'false') await migrate(config.databaseUrl, config.databaseSsl, () => {});
if (config.s3.createBucket) await storage.ensureBucket();

const app = await buildApp({ config, db, storage });
await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.end();
    process.exit(0);
  });
}
