import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';
import { withTx } from './db.ts';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
// 任意固定值：串行化并发部署时的迁移。
const MIGRATION_LOCK_KEY = 4_420_901;

/** 按文件名顺序应用尚未执行的 SQL 迁移，每个文件一个事务。返回本次应用的文件名。 */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  return withTx(pool, async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await tx.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const { rows } = await tx.query<{ name: string }>('select name from schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.query(await readFile(new URL(file, MIGRATIONS_DIR), 'utf8'));
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
      applied.push(file);
    }
    return applied;
  });
}
