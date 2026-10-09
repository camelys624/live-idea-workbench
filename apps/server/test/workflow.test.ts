import { describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  CreateSubmissionResponse,
  IdeaDetailDto,
  ReviewResponse,
  ScopeVersionDto,
  SubmissionDetailDto,
  SubmissionDto,
  WorkbenchEvent,
} from '@workbench/contracts';
import { IdeaService } from '../src/modules/ideas/service.ts';
import { THREE_FEATURES, TEMPLATE_SAMPLE, useTestApp } from './helpers.ts';

const ctx = useTestApp();

const OPERATOR = { 'x-workbench-user': 'op', 'x-workbench-roles': 'operator' };
const REVIEWER = { 'x-workbench-user': 'host', 'x-workbench-roles': 'reviewer' };

async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers = OPERATOR) {
  const res = await ctx.app.inject({ method, url, payload: payload as object, headers });
  return { status: res.statusCode, body: res.json() as T };
}

async function submit(rawText = TEMPLATE_SAMPLE, extra: Record<string, unknown> = {}) {
  const res = await call<CreateSubmissionResponse>('POST', '/api/submissions', { source: 'sample', rawText, ...extra });
  expect(res.status).toBe(201);
  return res.body.submission;
}

async function propose(ideaId: string, baseVersionId: string | null, features = THREE_FEATURES) {
  return call<ScopeVersionDto | ApiErrorBody>('POST', `/api/ideas/${ideaId}/scope-versions`, {
    baseVersionId,
    features,
    pageScope: '首页、预约页、个人页',
  });
}

async function review(ideaId: string, body: Record<string, unknown>) {
  return call<ReviewResponse | ApiErrorBody>('POST', `/api/ideas/${ideaId}/reviews`, body, REVIEWER);
}

const idea = async (id: string) => (await call<IdeaDetailDto>('GET', `/api/ideas/${id}`)).body;
const errCode = (body: unknown) => (body as ApiErrorBody).error.code;

describe('投稿保存', () => {
  it('原文、来源与全部期望功能完整保存；观众优先项与本次范围分开', async () => {
    const s = await submit(TEMPLATE_SAMPLE, { authorName: '观众甲' });
    expect(s.rawText).toBe(TEMPLATE_SAMPLE);
    expect(s.source).toBe('sample');
    expect(s.isSimulated).toBe(true);
    expect(s.relation).toBe('origin');
    expect(s.fields.desiredFeatures).toHaveLength(5);
    expect(s.fields.viewerPriorities).toEqual(['查看空位', '预约座位', '签到']);

    const detail = await idea(s.ideaId);
    expect(detail.status).toBe('open');
    expect(detail.hasSimulatedSubmissions).toBe(true);
    expect(detail.desiredFeatures.map((f) => f.text)).toEqual(['查看空位', '预约座位', '签到', '排行榜', '暗黑模式']);
    expect(detail.scopeVersions).toEqual([]);
    expect(detail.launch.launchable).toBe(false);
  });

  it('人工接口不能伪造抖音来源', async () => {
    const res = await call<ApiErrorBody>('POST', '/api/submissions', { source: 'douyin', rawText: 'x' });
    expect(res.status).toBe(400);
    expect(errCode(res.body)).toBe('VALIDATION_FAILED');
  });

  it('同一来源消息重复提交只保存一次', async () => {
    const payload = { source: 'manual', rawText: '投稿｜想做啥：番茄钟', sourceMessageId: 'msg-1' };
    const first = await call<CreateSubmissionResponse>('POST', '/api/submissions', payload);
    const again = await call<CreateSubmissionResponse>('POST', '/api/submissions', payload);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.submission.id).toBe(first.body.submission.id);
    const list = await call<{ items: SubmissionDto[] }>('GET', `/api/submissions?ideaId=${first.body.submission.ideaId}`);
    expect(list.body.items).toHaveLength(1);
  });

  it('并发重复推送也只保存一次', async () => {
    const payload = { source: 'manual', rawText: '投稿｜想做啥：并发', sourceMessageId: 'msg-concurrent' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call<CreateSubmissionResponse>('POST', '/api/submissions', payload)),
    );
    expect(new Set(results.map((r) => r.body.submission.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('整理字段留痕，原文与解析结果在数据库层不可修改', async () => {
    const s = await submit('投稿｜想做啥：记账｜给谁用：___');
    const patched = await call<SubmissionDto>('PATCH', `/api/submissions/${s.id}/fields`, {
      targetUsers: '大学生',
      title: '宿舍记账本',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.rawText).toBe(s.rawText);
    expect(patched.body.fields.targetUsers).toBe('大学生');
    expect(patched.body.missingFields).not.toContain('targetUsers');
    expect((await idea(s.ideaId)).title).toBe('宿舍记账本');

    const edits = await ctx.pool.query('select actor from submission_field_edits where submission_id = $1', [s.id]);
    expect(edits.rows).toEqual([{ actor: 'op' }]);

    await expect(
      ctx.pool.query("update submissions set raw_text = 'tampered' where id = $1", [s.id]),
    ).rejects.toThrow(/immutable/);
    await expect(ctx.pool.query('delete from submissions where id = $1', [s.id])).rejects.toThrow(/cannot be deleted/);
  });
});

describe('重复合并与补充反馈', () => {
  it('重复创意合并后来源投稿全部保留并可追溯', async () => {
    const a = await submit();
    const b = await submit('投稿｜想做啥：图书馆占座神器｜希望它能干啥：查看空位、提醒');
    const res = await call<IdeaDetailDto>('POST', `/api/ideas/${b.ideaId}/merge`, {
      targetIdeaId: a.ideaId,
      reason: '同为自习室座位预约',
    });
    expect(res.status).toBe(200);
    expect(res.body.submissions.map((s) => [s.id, s.relation])).toEqual([
      [a.id, 'origin'],
      [b.id, 'duplicate'],
    ]);
    expect(res.body.desiredFeatures.filter((f) => f.submissionId === b.id).map((f) => f.text)).toEqual([
      '查看空位',
      '提醒',
    ]);
    expect(res.body.mergesIn).toHaveLength(1);

    const merged = await idea(b.ideaId);
    expect(merged.status).toBe('merged');
    expect(merged.mergedIntoId).toBe(a.ideaId);
    expect(merged.mergeOut?.reason).toBe('同为自习室座位预约');

    const trail = await call<SubmissionDetailDto>('GET', `/api/submissions/${b.id}`);
    expect(trail.body.attributions).toMatchObject([
      { fromIdeaId: b.ideaId, toIdeaId: a.ideaId, fromRelation: 'origin', toRelation: 'duplicate', actor: 'op' },
    ]);
    expect(trail.body.attributions[0]!.mergeId).toBe(res.body.mergesIn[0]!.id);
  });

  it('合并到已合并或已拒绝的创意被拒绝；已批准创意不能被合并走', async () => {
    const a = await submit();
    const b = await submit();
    const c = await submit();
    await call('POST', `/api/ideas/${b.ideaId}/merge`, { targetIdeaId: a.ideaId, reason: '重复' });
    const intoMerged = await call<ApiErrorBody>('POST', `/api/ideas/${c.ideaId}/merge`, {
      targetIdeaId: b.ideaId,
      reason: '重复',
    });
    expect(intoMerged.status).toBe(409);
    expect(errCode(intoMerged.body)).toBe('MERGE_INVALID');

    const v = (await propose(a.ideaId, null)).body as ScopeVersionDto;
    await review(a.ideaId, { decision: 'approve', scopeVersionId: v.id });
    const approvedAway = await call<ApiErrorBody>('POST', `/api/ideas/${a.ideaId}/merge`, {
      targetIdeaId: c.ideaId,
      reason: 'x',
    });
    expect(errCode(approvedAway.body)).toBe('MERGE_INVALID');

    const self = await call<ApiErrorBody>('POST', `/api/ideas/${c.ideaId}/merge`, { targetIdeaId: c.ideaId, reason: 'x' });
    expect(errCode(self.body)).toBe('MERGE_INVALID');
  });

  it('补充反馈归入已批准创意，不改变本次三个功能与批准', async () => {
    const a = await submit();
    const v = (await propose(a.ideaId, null)).body as ScopeVersionDto;
    await review(a.ideaId, { decision: 'approve', scopeVersionId: v.id });

    const fb = await submit('能不能加个排行榜');
    // 首条投稿不能单独移走
    const asOrigin = await call<ApiErrorBody>('POST', `/api/submissions/${fb.id}/reattribute`, {
      targetIdeaId: a.ideaId,
      relation: 'feedback',
      reason: '补充反馈',
    });
    expect(errCode(asOrigin.body)).toBe('USE_IDEA_MERGE');

    // 先作为重复合入一个临时创意，再作为反馈改归既有产品
    const tmp = await submit('投稿｜想做啥：临时');
    await call('POST', `/api/ideas/${fb.ideaId}/merge`, { targetIdeaId: tmp.ideaId, reason: '整理' });
    const moved = await call<SubmissionDto>('POST', `/api/submissions/${fb.id}/reattribute`, {
      targetIdeaId: a.ideaId,
      relation: 'feedback',
      reason: '自习室产品的补充反馈',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.relation).toBe('feedback');

    const after = await idea(a.ideaId);
    expect(after.status).toBe('approved');
    expect(after.approvedScopeVersionId).toBe(v.id);
    expect(after.feedback.map((s) => s.id)).toEqual([fb.id]);
    expect(after.desiredFeatures.some((f) => f.submissionId === fb.id)).toBe(false);
    expect(after.launch.launchable).toBe(true);

    const trail = await call<SubmissionDetailDto>('GET', `/api/submissions/${fb.id}`);
    expect(trail.body.attributions.map((t) => [t.toIdeaId, t.toRelation])).toEqual([
      [tmp.ideaId, 'duplicate'],
      [a.ideaId, 'feedback'],
    ]);
  });
});

describe('范围版本与人工审核', () => {
  it('范围必须恰好三个功能且各有完成标准', async () => {
    const s = await submit();
    for (const features of [
      THREE_FEATURES.slice(0, 2),
      [...THREE_FEATURES, { title: '排行榜', acceptanceCriteria: '显示前十' }],
      [THREE_FEATURES[0], THREE_FEATURES[1], { title: '签到', acceptanceCriteria: '   ' }],
    ]) {
      const res = await propose(s.ideaId, null, features as typeof THREE_FEATURES);
      expect(res.status).toBe(400);
    }
    const dbBypass = ctx.pool.query(
      `insert into scope_versions (id, idea_id, version_no, features, page_scope, proposed_by)
       values (gen_random_uuid(), $1, 1, $2, 'p', 'x')`,
      [s.ideaId, JSON.stringify(THREE_FEATURES.slice(0, 2))],
    );
    await expect(dbBypass).rejects.toThrow(/workbench_valid_scope_features|check/);
  });

  it('批准恰好三个功能后才可立项', async () => {
    const s = await submit();
    const v = (await propose(s.ideaId, null)).body as ScopeVersionDto;
    expect(v.versionNo).toBe(1);
    expect((await idea(s.ideaId)).launch).toMatchObject({ launchable: false });

    const res = await review(s.ideaId, { decision: 'approve', scopeVersionId: v.id });
    expect(res.status).toBe(201);
    const detail = (res.body as ReviewResponse).idea;
    expect(detail.status).toBe('approved');
    expect(detail.launch.launchable).toBe(true);
    expect(detail.launch.approvedScope?.features).toEqual(THREE_FEATURES);
    expect(detail.reviews).toMatchObject([{ decision: 'approve', reviewer: 'host', scopeVersionId: v.id }]);
  });

  it('修改范围后旧批准失效，必须重新审核', async () => {
    const s = await submit();
    const v1 = (await propose(s.ideaId, null)).body as ScopeVersionDto;
    await review(s.ideaId, { decision: 'approve', scopeVersionId: v1.id });

    const changed = [...THREE_FEATURES.slice(0, 2), { title: '排行榜', acceptanceCriteria: '显示本周前十' }];
    const v2 = await propose(s.ideaId, v1.id, changed);
    expect(v2.status).toBe(201);
    const detail = await idea(s.ideaId);
    expect(detail.status).toBe('pending_review');
    expect(detail.approvedScopeVersionId).toBeNull();
    expect(detail.scopeVersions.map((v) => v.status)).toEqual(['superseded', 'pending_review']);
    expect(detail.launch.launchable).toBe(false);

    // 用旧版本审核会被拒绝
    const staleApprove = await review(s.ideaId, { decision: 'approve', scopeVersionId: v1.id });
    expect(staleApprove.status).toBe(409);
    expect(errCode(staleApprove.body)).toBe('STALE_SCOPE_VERSION');

    // 数据库层同样拒绝“状态 approved 但批准版本不是最新”
    await expect(
      ctx.pool.query(
        "update ideas set status = 'approved', approved_scope_version_id = $2 where id = $1",
        [s.ideaId, v1.id],
      ),
    ).rejects.toThrow(/check/);
  });

  it('基于过期版本提交范围被拒绝', async () => {
    const s = await submit();
    const v1 = (await propose(s.ideaId, null)).body as ScopeVersionDto;
    await propose(s.ideaId, v1.id);
    const stale = await propose(s.ideaId, v1.id);
    expect(stale.status).toBe(409);
    expect(errCode(stale.body)).toBe('STALE_SCOPE_VERSION');
    const fromNull = await propose(s.ideaId, null);
    expect(errCode(fromNull.body)).toBe('STALE_SCOPE_VERSION');
  });

  it('退回后不可立项，可重新提交范围再审', async () => {
    const s = await submit();
    const v1 = (await propose(s.ideaId, null)).body as ScopeVersionDto;
    const ret = await review(s.ideaId, { decision: 'return', scopeVersionId: v1.id, reason: '签到标准不清楚' });
    expect((ret.body as ReviewResponse).idea).toMatchObject({ status: 'returned', launch: { launchable: false } });

    const approveReturned = await review(s.ideaId, { decision: 'approve', scopeVersionId: v1.id });
    expect(errCode(approveReturned.body)).toBe('INVALID_STATE');

    const v2 = (await propose(s.ideaId, v1.id)).body as ScopeVersionDto;
    expect(v2.versionNo).toBe(2);
    const ok = await review(s.ideaId, { decision: 'approve', scopeVersionId: v2.id });
    expect((ok.body as ReviewResponse).idea.launch.launchable).toBe(true);
  });

  it('拒绝后不可立项，也不能再提交范围或批准', async () => {
    const s = await submit();
    const v1 = (await propose(s.ideaId, null)).body as ScopeVersionDto;
    await review(s.ideaId, { decision: 'approve', scopeVersionId: v1.id });
    const rej = await review(s.ideaId, { decision: 'reject', scopeVersionId: v1.id, reason: '超出小产品范围' });
    expect(rej.status).toBe(201);
    const detail = (rej.body as ReviewResponse).idea;
    expect(detail).toMatchObject({ status: 'rejected', approvedScopeVersionId: null, launch: { launchable: false } });
    expect(detail.scopeVersions[0]!.status).toBe('rejected');

    expect(errCode((await propose(s.ideaId, v1.id)).body)).toBe('INVALID_STATE');
    expect(errCode((await review(s.ideaId, { decision: 'approve', scopeVersionId: v1.id })).body)).toBe(
      'INVALID_STATE',
    );
  });

  it('没有范围也可直接拒绝；退回与拒绝必须写理由', async () => {
    const s = await submit();
    const noReason = await review(s.ideaId, { decision: 'reject', scopeVersionId: null });
    expect(noReason.status).toBe(400);
    const ok = await review(s.ideaId, { decision: 'reject', scopeVersionId: null, reason: '重复且信息不足' });
    expect((ok.body as ReviewResponse).idea.status).toBe('rejected');
  });

  it('立项校验在事务内拒绝未批准的创意', async () => {
    const service = new IdeaService(ctx.pool, ctx.events);
    const s = await submit();
    const client = await ctx.pool.connect();
    try {
      await client.query('begin');
      await expect(service.requireLaunchableScope(client, s.ideaId)).rejects.toMatchObject({ code: 'NOT_LAUNCHABLE' });
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('权限', () => {
  it('只有 reviewer 可以审核，只有 operator 可以录入与提交范围', async () => {
    const s = await submit();
    const v = (await propose(s.ideaId, null)).body as ScopeVersionDto;
    const byOperator = await call<ApiErrorBody>('POST', `/api/ideas/${s.ideaId}/reviews`, {
      decision: 'approve',
      scopeVersionId: v.id,
    });
    expect(byOperator.status).toBe(403);

    const byReviewer = await call<ApiErrorBody>(
      'POST',
      '/api/submissions',
      { source: 'manual', rawText: 'x' },
      REVIEWER,
    );
    expect(byReviewer.status).toBe(403);
  });
});

describe('SSE 事件', () => {
  it('事务提交后发布事件', async () => {
    const seen: WorkbenchEvent[] = [];
    const off = ctx.events.subscribe((e) => seen.push(e));
    const s = await submit();
    off();
    expect(seen).toEqual([
      { type: 'submission.created', submissionId: s.id, ideaId: s.ideaId },
      { type: 'idea.updated', ideaId: s.ideaId },
    ]);
  });
});
