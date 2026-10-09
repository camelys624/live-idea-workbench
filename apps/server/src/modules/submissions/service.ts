import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  CreateSubmissionResponse,
  ListSubmissionsQuery,
  Page,
  ReattributeSubmissionRequest,
  SubmissionDetailDto,
  SubmissionDto,
  SubmissionFields,
  SubmissionSource,
  UpdateSubmissionFieldsRequest,
  WorkbenchEvent,
} from '@workbench/contracts';
import { ListSubmissionsQuerySchema } from '@workbench/contracts';
import { withTx } from '../../db.ts';
import { AppError } from '../../errors.ts';
import type { EventHub } from '../../events.ts';
import { lockIdeas } from '../ideas/repo.ts';
import { toAttributionDto, toSubmissionDto, type SubmissionRow } from '../mappers.ts';
import { parseSubmissionText } from './template.ts';

export interface IngestSubmissionInput {
  source: SubmissionSource;
  rawText: string;
  authorName?: string | null | undefined;
  sourceMessageId?: string | null | undefined;
  receivedAt?: string | undefined;
  fields?: Partial<SubmissionFields> | undefined;
}

const IDEA_TITLE_FALLBACK_LENGTH = 60;

export class SubmissionService {
  readonly #pool: pg.Pool;
  readonly #events: EventHub;

  constructor(pool: pg.Pool, events: EventHub) {
    this.#pool = pool;
    this.#events = events;
  }

  /**
   * 保存一条投稿并为其创建新创意（relation=origin）。
   * 原文原样保存；按 (source, sourceMessageId) 消息级去重，重复推送返回已有投稿而不新增。
   * 人工接口只允许 manual/sample；douyin 来源仅供获准后的接入模块调用。
   */
  async ingest(input: IngestSubmissionInput, actor: string): Promise<CreateSubmissionResponse> {
    const parsed = parseSubmissionText(input.rawText);
    const fields: SubmissionFields = { ...parsed.fields, ...input.fields };
    const sourceMessageId = input.sourceMessageId ?? null;

    const result = await withTx(this.#pool, async (tx) => {
      if (sourceMessageId !== null) {
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
          input.source,
          sourceMessageId,
        ]);
        const existing = await tx.query<SubmissionRow>(
          'select * from submissions where source = $1 and source_message_id = $2',
          [input.source, sourceMessageId],
        );
        if (existing.rows[0]) return { row: existing.rows[0], deduplicated: true };
      }

      const ideaId = randomUUID();
      const title = fields.title ?? input.rawText.trim().slice(0, IDEA_TITLE_FALLBACK_LENGTH);
      await tx.query('insert into ideas (id, title) values ($1, $2)', [ideaId, title]);
      const { rows } = await tx.query<SubmissionRow>(
        `insert into submissions
           (id, source, source_message_id, author_name, raw_text, received_at,
            parse_status, parsed_fields, fields, idea_id, relation, created_by)
         values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7, $8, $9, $10, 'origin', $11)
         returning *`,
        [
          randomUUID(),
          input.source,
          sourceMessageId,
          input.authorName ?? null,
          input.rawText,
          input.receivedAt ?? null,
          parsed.parseStatus,
          JSON.stringify(parsed.fields),
          JSON.stringify(fields),
          ideaId,
          actor,
        ],
      );
      return { row: rows[0]!, deduplicated: false };
    });

    const submission = toSubmissionDto(result.row);
    if (!result.deduplicated) {
      this.#events.publish([
        { type: 'submission.created', submissionId: submission.id, ideaId: submission.ideaId },
        { type: 'idea.updated', ideaId: submission.ideaId },
      ]);
    }
    return { submission, deduplicated: result.deduplicated };
  }

  async get(id: string): Promise<SubmissionDetailDto> {
    const { rows } = await this.#pool.query<SubmissionRow>('select * from submissions where id = $1', [id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', '投稿不存在');
    const attributions = await this.#pool.query(
      'select * from submission_attributions where submission_id = $1 order by created_at, id',
      [id],
    );
    return { ...toSubmissionDto(rows[0]), attributions: attributions.rows.map(toAttributionDto) };
  }

  async list(query: ListSubmissionsQuery): Promise<Page<SubmissionDto>> {
    const q = ListSubmissionsQuerySchema.parse(query);
    const { rows } = await this.#pool.query<SubmissionRow>(
      `select * from submissions
        where ($1::text is null or source = $1)
          and ($2::uuid is null or idea_id = $2)
          and ($3::bigint is null or seq < $3)
        order by seq desc
        limit $4`,
      [q.source ?? null, q.ideaId ?? null, parseCursor(q.cursor), q.limit + 1],
    );
    const items = rows.slice(0, q.limit);
    return {
      items: items.map(toSubmissionDto),
      nextCursor: rows.length > q.limit ? items.at(-1)!.seq : null,
    };
  }

  /** 人工整理字段。原文与解析结果不变，每次修改留痕。 */
  async updateFields(id: string, patch: UpdateSubmissionFieldsRequest, actor: string): Promise<SubmissionDto> {
    const row = await withTx(this.#pool, async (tx) => {
      const { rows } = await tx.query<SubmissionRow>('select * from submissions where id = $1 for update', [id]);
      const current = rows[0];
      if (!current) throw new AppError('NOT_FOUND', '投稿不存在');
      const next: SubmissionFields = { ...current.fields, ...patch };
      await tx.query(
        `insert into submission_field_edits (id, submission_id, before_fields, after_fields, actor)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), id, JSON.stringify(current.fields), JSON.stringify(next), actor],
      );
      const updated = await tx.query<SubmissionRow>(
        'update submissions set fields = $2, updated_at = now() where id = $1 returning *',
        [id, JSON.stringify(next)],
      );
      // 创意标题跟随其首条投稿的“想做啥”。
      if (current.relation === 'origin' && patch.title) {
        await tx.query('update ideas set title = $2, updated_at = now() where id = $1', [
          current.idea_id,
          patch.title,
        ]);
      }
      return updated.rows[0]!;
    });
    this.#events.publish([
      { type: 'submission.updated', submissionId: row.id, ideaId: row.idea_id },
      { type: 'idea.updated', ideaId: row.idea_id },
    ]);
    return toSubmissionDto(row);
  }

  /**
   * 把单条投稿作为重复创意或补充反馈归入另一创意，记录归属历史。
   * 创意的首条投稿（origin）代表该创意本身，不能单独移走：应改用创意合并。
   * 归入不改变目标创意的本次范围或审核状态。
   */
  async reattribute(id: string, input: ReattributeSubmissionRequest, actor: string): Promise<SubmissionDto> {
    const { row, events } = await withTx(this.#pool, async (tx) => {
      const { rows } = await tx.query<SubmissionRow>('select * from submissions where id = $1 for update', [id]);
      const current = rows[0];
      if (!current) throw new AppError('NOT_FOUND', '投稿不存在');
      if (current.idea_id === input.targetIdeaId) {
        throw new AppError('MERGE_INVALID', '投稿已属于目标创意');
      }
      if (current.relation === 'origin') {
        throw new AppError('USE_IDEA_MERGE', '首条投稿代表该创意本身，请使用创意合并');
      }
      const ideas = await lockIdeas(tx, [current.idea_id, input.targetIdeaId]);
      const target = ideas.get(input.targetIdeaId);
      if (!target) throw new AppError('NOT_FOUND', '目标创意不存在');
      if (target.status === 'merged' || target.status === 'rejected') {
        throw new AppError('MERGE_INVALID', `目标创意状态为 ${target.status}，不能接收投稿`, {
          mergedIntoId: target.merged_into_id,
        });
      }
      await tx.query(
        `insert into submission_attributions
           (id, submission_id, from_idea_id, to_idea_id, from_relation, to_relation, reason, actor)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), id, current.idea_id, input.targetIdeaId, current.relation, input.relation, input.reason, actor],
      );
      const updated = await tx.query<SubmissionRow>(
        'update submissions set idea_id = $2, relation = $3, updated_at = now() where id = $1 returning *',
        [id, input.targetIdeaId, input.relation],
      );
      await tx.query('update ideas set updated_at = now() where id = any($1::uuid[])', [
        [current.idea_id, input.targetIdeaId],
      ]);
      const events: WorkbenchEvent[] = [
        { type: 'submission.updated', submissionId: id, ideaId: input.targetIdeaId },
        { type: 'idea.updated', ideaId: current.idea_id },
        { type: 'idea.updated', ideaId: input.targetIdeaId },
      ];
      return { row: updated.rows[0]!, events };
    });
    this.#events.publish(events);
    return toSubmissionDto(row);
  }
}

export function parseCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  if (!/^\d{1,18}$/.test(cursor)) throw new AppError('VALIDATION_FAILED', 'cursor 无效');
  return cursor;
}
