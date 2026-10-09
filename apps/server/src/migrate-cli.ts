import { createPool } from './db.ts';
import { migrate } from './migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL 未配置');
const pool = createPool(url, { max: 1 });
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `已应用迁移：${applied.join(', ')}` : '数据库已是最新');
} finally {
  await pool.end();
}
