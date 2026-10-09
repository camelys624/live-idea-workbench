import type pg from 'pg';
import type { IdeaRow } from '../mappers.ts';

/** 按 id 排序加行锁，避免并发合并/归属时死锁。返回存在的创意。 */
export async function lockIdeas(tx: pg.PoolClient, ids: string[]): Promise<Map<string, IdeaRow>> {
  const { rows } = await tx.query<IdeaRow>(
    'select * from ideas where id = any($1::uuid[]) order by id for update',
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}
