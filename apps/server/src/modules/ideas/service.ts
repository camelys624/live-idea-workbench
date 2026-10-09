import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  IdeaDetailDto,
  IdeaStatus,
  IdeaSummaryDto,
  LaunchReadinessDto,
  ListIdeasQuery,
  MergeIdeaRequest,
  Page,
  ProposeScopeRequest,
  ReviewDecision,
  ReviewRequest,
  ReviewResponse,
  ScopeVersionDto,
  WorkbenchEvent,
} from '@workbench/contracts';
import { ListIdeasQuerySchema } from '@workbench/contracts';
import { withTx, type Queryable } from '../../db.ts';
import { AppError } from '../../errors.ts';
import type { EventHub } from '../../events.ts';
import {
  toIdeaSummaryDto,
  toMergeDto,
  toReviewDto,
  toScopeVersionDto,
  toSubmissionDto,
  type IdeaRow,
  type IdeaSummaryRow,
  type ScopeVersionRow,
  type SubmissionRow,
} from '../mappers.ts';
import { parseCursor } from '../submissions/service.ts';
import { lockIdeas } from './repo.ts';

const SUMMARY_SELECT = `
  select i.*,
         (select count(*)::int from submissions s where s.idea_id = i.id and s.relation <> 'feedback') as submission_count,
         (select count(*)::int from submissions s where s.idea_id = i.id and s.relation = 'feedback') as feedback_count,
         exists (select 1 from submissions s where s.idea_id = i.id and s.source <> 'douyin') as has_simulated
    from ideas i`;

/** 可以提交新范围版本的创意状态。 */
const SCOPE_EDITABLE: Record<IdeaStatus, boolean> = {
  open: true,
  pending_review: true,
  returned: true,
  approved: true,
  rejected: false,
  merged: false,
};

/** 审核决定对应的版本与创意状态（两者同名）。 */
const STATUS_BY_DECISION: Record<ReviewDecision, 'approved' | 'returned' | 'rejected'> = {
  approve: 'approved',
  return: 'returned',
  reject: 'rejected',
};

/** 可以被合并到其他创意的状态。已批准的创意可能已立项，不允许合并走。 */
const MERGEABLE_SOURCE: Record<IdeaStatus, boolean> = {
  open: true,
  pending_review: true,
  returned: true,
  approved: false,
  rejected: false,
  merged: false,
};

export class IdeaService {
  readonly #pool: pg.Pool;
  readonly #events: EventHub;

  constructor(pool: pg.Pool, events: EventHub) {
    this.#pool = pool;
    this.#events = events;
  }

  async list(query: ListIdeasQuery): Promise<Page<IdeaSummaryDto>> {
    const q = ListIdeasQuerySchema.parse(query);
    const { rows } = await this.#pool.query<IdeaSummaryRow>(
      `${SUMMARY_SELECT}
        where ($1::text[] is null or i.status = any($1))
          and ($2::bigint is null or i.seq < $2)
        order by i.seq desc
        limit $3`,
      [q.status ?? null, parseCursor(q.cursor), q.limit + 1],
    );
    const items = rows.slice(0, q.limit);
    return { items: items.map(toIdeaSummaryDto), nextCursor: rows.length > q.limit ? items.at(-1)!.seq : null };
  }

  async get(id: string, db: Queryable = this.#pool): Promise<IdeaDetailDto> {
    const summary = await db.query<IdeaSummaryRow>(`${SUMMARY_SELECT} where i.id = $1`, [id]);
    const idea = summary.rows[0];
    if (!idea) throw new AppError('NOT_FOUND', '创意不存在');

    // 可能在事务连接上执行：单个连接上的查询须顺序发出。
    const subs = await db.query<SubmissionRow>('select * from submissions where idea_id = $1 order by seq', [id]);
    const versions = await db.query<ScopeVersionRow>(
      'select * from scope_versions where idea_id = $1 order by version_no',
      [id],
    );
    const reviews = await db.query('select * from reviews where idea_id = $1 order by created_at, id', [id]);
    const merges = await db.query(
      'select * from idea_merges where target_idea_id = $1 or source_idea_id = $1 order by created_at, id',
      [id],
    );

    const submissions = subs.rows.filter((s) => s.relation !== 'feedback').map(toSubmissionDto);
    const scopeVersions = versions.rows.map(toScopeVersionDto);
    const mergeDtos = merges.rows.map(toMergeDto);
    return {
      ...toIdeaSummaryDto(idea),
      submissions,
      feedback: subs.rows.filter((s) => s.relation === 'feedback').map(toSubmissionDto),
      desiredFeatures: submissions.flatMap((s) =>
        s.fields.desiredFeatures.map((text) => ({ text, submissionId: s.id, relation: s.relation })),
      ),
      scopeVersions,
      reviews: reviews.rows.map(toReviewDto),
      mergesIn: mergeDtos.filter((m) => m.targetIdeaId === id),
      mergeOut: mergeDtos.find((m) => m.sourceIdeaId === id) ?? null,
      launch: launchReadiness(idea, scopeVersions),
    };
  }

  /**
   * 把 source 创意作为重复创意整体合并到 target。
   * 来源投稿全部保留并迁移（origin→duplicate，feedback 保持 feedback），每条留归属记录；
   * source 的待审范围失效，source 标记为 merged。target 的范围与审核状态不变。
   */
  async merge(sourceId: string, input: MergeIdeaRequest, actor: string): Promise<IdeaDetailDto> {
    const targetId = input.targetIdeaId;
    if (sourceId === targetId) throw new AppError('MERGE_INVALID', '不能合并到自身');

    const detail = await withTx(this.#pool, async (tx) => {
      const ideas = await lockIdeas(tx, [sourceId, targetId]);
      const source = ideas.get(sourceId);
      const target = ideas.get(targetId);
      if (!source) throw new AppError('NOT_FOUND', '创意不存在');
      if (!target) throw new AppError('NOT_FOUND', '目标创意不存在');
      if (!MERGEABLE_SOURCE[source.status]) {
        throw new AppError('MERGE_INVALID', `创意状态为 ${source.status}，不能合并到其他创意`);
      }
      if (target.status === 'merged' || target.status === 'rejected') {
        throw new AppError('MERGE_INVALID', `目标创意状态为 ${target.status}，不能接收合并`, {
          mergedIntoId: target.merged_into_id,
        });
      }

      const mergeId = randomUUID();
      await tx.query(
        `insert into idea_merges (id, source_idea_id, target_idea_id, reason, actor)
         values ($1, $2, $3, $4, $5)`,
        [mergeId, sourceId, targetId, input.reason, actor],
      );
      await tx.query(
        `with moved as (
           select id, relation as from_relation,
                  case when relation = 'feedback' then 'feedback' else 'duplicate' end as to_relation
             from submissions where idea_id = $1 for update
         ), log as (
           insert into submission_attributions
             (id, submission_id, from_idea_id, to_idea_id, from_relation, to_relation, reason, actor, merge_id)
           select gen_random_uuid(), id, $1, $2, from_relation, to_relation, $3, $4, $5 from moved
         )
         update submissions s
            set idea_id = $2, relation = moved.to_relation, updated_at = now()
           from moved where s.id = moved.id`,
        [sourceId, targetId, input.reason, actor, mergeId],
      );
      await tx.query(
        `update scope_versions set status = 'superseded', status_changed_at = now()
          where idea_id = $1 and status in ('pending_review', 'approved')`,
        [sourceId],
      );
      await tx.query(
        `update ideas set status = 'merged', merged_into_id = $2, approved_scope_version_id = null, updated_at = now()
          where id = $1`,
        [sourceId, targetId],
      );
      await tx.query('update ideas set updated_at = now() where id = $1', [targetId]);
      return this.get(targetId, tx);
    });
    this.#publishIdeas([sourceId, targetId]);
    return detail;
  }

  /**
   * 提交本次范围：恰好三个功能及各自完成标准。
   * 基于过期版本提交会被拒绝；新版本使此前待审或已批准的版本失效，原批准不得用于新范围。
   */
  async proposeScope(ideaId: string, input: ProposeScopeRequest, actor: string): Promise<ScopeVersionDto> {
    const version = await withTx(this.#pool, async (tx) => {
      const idea = (await lockIdeas(tx, [ideaId])).get(ideaId);
      if (!idea) throw new AppError('NOT_FOUND', '创意不存在');
      if (!SCOPE_EDITABLE[idea.status]) {
        throw new AppError('INVALID_STATE', `创意状态为 ${idea.status}，不能提交范围`);
      }
      assertLatest(idea, input.baseVersionId);

      await tx.query(
        `update scope_versions set status = 'superseded', status_changed_at = now()
          where idea_id = $1 and status in ('pending_review', 'approved')`,
        [ideaId],
      );
      const { rows } = await tx.query<ScopeVersionRow>(
        `insert into scope_versions (id, idea_id, version_no, features, page_scope, style, notes, proposed_by)
         values ($1, $2,
                 (select coalesce(max(version_no), 0) + 1 from scope_versions where idea_id = $2),
                 $3, $4, $5, $6, $7)
         returning *`,
        [
          randomUUID(),
          ideaId,
          JSON.stringify(input.features),
          input.pageScope,
          input.style ?? null,
          input.notes ?? null,
          actor,
        ],
      );
      const created = rows[0]!;
      await tx.query(
        `update ideas set status = 'pending_review', current_scope_version_id = $2,
                          approved_scope_version_id = null, updated_at = now()
          where id = $1`,
        [ideaId, created.id],
      );
      return created;
    });
    this.#publishIdeas([ideaId]);
    return toScopeVersionDto(version);
  }

  /**
   * 人工审核最新范围版本。
   * approve/return 仅针对待审的最新版本；reject 可在任何未合并、未拒绝的状态下执行。
   */
  async review(ideaId: string, input: ReviewRequest, reviewer: string): Promise<ReviewResponse> {
    const result = await withTx(this.#pool, async (tx) => {
      const idea = (await lockIdeas(tx, [ideaId])).get(ideaId);
      if (!idea) throw new AppError('NOT_FOUND', '创意不存在');
      if (idea.status === 'merged' || idea.status === 'rejected') {
        throw new AppError('INVALID_STATE', `创意状态为 ${idea.status}，不能审核`);
      }
      assertLatest(idea, input.scopeVersionId);

      if (input.decision !== 'reject' && idea.status !== 'pending_review') {
        throw new AppError('INVALID_STATE', `创意状态为 ${idea.status}，没有待审核的范围`);
      }

      const nextStatus = STATUS_BY_DECISION[input.decision];
      if (idea.current_scope_version_id !== null) {
        await tx.query(
          `update scope_versions set status = $2, status_changed_at = now()
            where id = $1 and status in ('pending_review', 'approved')`,
          [idea.current_scope_version_id, nextStatus],
        );
      }
      await tx.query(
        `update ideas set status = $2, approved_scope_version_id = $3, updated_at = now() where id = $1`,
        [ideaId, nextStatus, input.decision === 'approve' ? idea.current_scope_version_id : null],
      );
      const { rows } = await tx.query(
        `insert into reviews (id, idea_id, scope_version_id, decision, reason, reviewer)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [randomUUID(), ideaId, input.scopeVersionId, input.decision, input.reason ?? null, reviewer],
      );
      return { review: toReviewDto(rows[0]), idea: await this.get(ideaId, tx) };
    });
    this.#publishIdeas([ideaId]);
    return result;
  }

  /**
   * 立项前置校验（供后续 Multica 立项模块在其事务内调用）：
   * 锁定创意行，确认最新范围已人工批准且为恰好三个功能，返回该批准版本。
   * 拒绝、退回、待审、已合并或范围修改后的旧批准一律不可立项。
   */
  async requireLaunchableScope(tx: pg.PoolClient, ideaId: string): Promise<ScopeVersionDto> {
    const idea = (await lockIdeas(tx, [ideaId])).get(ideaId);
    if (!idea) throw new AppError('NOT_FOUND', '创意不存在');
    const versions = await tx.query<ScopeVersionRow>('select * from scope_versions where idea_id = $1', [ideaId]);
    const readiness = launchReadiness(idea, versions.rows.map(toScopeVersionDto));
    if (!readiness.launchable) throw new AppError('NOT_LAUNCHABLE', readiness.reason ?? '不可立项');
    return readiness.approvedScope!;
  }

  #publishIdeas(ids: string[]): void {
    this.#events.publish(ids.map((ideaId): WorkbenchEvent => ({ type: 'idea.updated', ideaId })));
  }
}

function assertLatest(idea: IdeaRow, versionId: string | null): void {
  if (versionId !== idea.current_scope_version_id) {
    throw new AppError('STALE_SCOPE_VERSION', '范围版本已不是最新，请刷新后重试', {
      currentScopeVersionId: idea.current_scope_version_id,
    });
  }
}

export function launchReadiness(idea: IdeaRow, versions: ScopeVersionDto[]): LaunchReadinessDto {
  const notReady = (reason: string): LaunchReadinessDto => ({ launchable: false, approvedScope: null, reason });
  if (idea.status !== 'approved') return notReady(`创意状态为 ${idea.status}，未获人工批准`);
  const approved = versions.find((v) => v.id === idea.approved_scope_version_id);
  if (!approved || idea.approved_scope_version_id !== idea.current_scope_version_id) {
    return notReady('批准的范围不是最新版本');
  }
  if (approved.status !== 'approved') return notReady(`范围版本状态为 ${approved.status}`);
  if (approved.features.length !== 3) return notReady('本次范围不是恰好三个功能');
  return { launchable: true, approvedScope: approved, reason: null };
}
