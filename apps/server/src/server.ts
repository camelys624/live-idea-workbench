import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { migrate } from './migrate.ts';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await migrate(pool);
const app = buildApp({ config, pool });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
