import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MergeIdeaSchema, ReattributeSubmissionSchema } from '@workbench/contracts';
import type {
  IdeaDetailDto,
  IdeaStatus,
  IdeaSummaryDto,
  MergeIdeaRequest,
  Page,
  ReattributeSubmissionRequest,
  SubmissionDto,
  SubmissionRelation,
} from '@workbench/contracts';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, request } from './api';
import { ActionFeedback, useAction } from './useAction';

interface RelationshipPanelProps {
  idea: IdeaDetailDto;
  canOperate: boolean;
  onSaved: () => Promise<void>;
}

const statusLabels: Record<IdeaStatus, string> = {
  open: '待整理',
  pending_review: '待人工审核',
  returned: '已退回补充',
  approved: '已人工批准',
  rejected: '已拒绝',
  merged: '已整体合并',
};

const relationLabels: Record<SubmissionRelation, string> = {
  origin: '首条创意来源',
  duplicate: '重复投稿',
  feedback: '补充反馈',
};
const sourceLabels: Record<SubmissionDto['source'], string> = {
  manual: '人工录入', sample: '示例投稿', douyin: '抖音接入',
};

const targetStatuses: IdeaStatus[] = ['open', 'pending_review', 'returned', 'approved'];
type RelationshipMode = 'merge' | 'duplicate' | 'feedback';
const modeLabels: Record<RelationshipMode, string> = {
  merge: '整体合并重复创意',
  duplicate: '单条投稿归为重复',
  feedback: '单条投稿归为补充反馈',
};

interface ConfirmationSource {
  id: string;
  title: string;
  status: IdeaStatus;
  updatedAt: string;
}

type RelationshipConfirmation = {
  mode: 'merge';
  body: MergeIdeaRequest;
  source: ConfirmationSource;
  target: IdeaSummaryDto;
} | {
  mode: 'duplicate' | 'feedback';
  body: ReattributeSubmissionRequest;
  source: ConfirmationSource;
  target: IdeaSummaryDto;
  submission: SubmissionDto;
};

function RelationshipEditor({ idea, canOperate, onSaved }: Pick<RelationshipPanelProps, 'idea' | 'canOperate' | 'onSaved'>) {
  const id = useId();
  const action = useAction();
  const [mode, setMode] = useState<RelationshipMode | ''>('');
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [targets, setTargets] = useState<IdeaSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [targetLoading, setTargetLoading] = useState(true);
  const [targetError, setTargetError] = useState('');
  const [validationError, setValidationError] = useState('');
  const [confirmation, setConfirmation] = useState<RelationshipConfirmation | null>(null);
  const targetAbort = useRef<AbortController | null>(null);
  const targetRequestId = useRef(0);
  const confirmationButton = useRef<HTMLButtonElement>(null);
  const sources = [...idea.submissions, ...idea.feedback];
  const selectedSource = sources.find((submission) => submission.id === sourceId);
  const selectedTarget = targets.find((target) => target.id === targetId);
  const canMerge = idea.status === 'open' || idea.status === 'pending_review' || idea.status === 'returned';
  const terminal = idea.status === 'merged' || idea.status === 'rejected';
  const originSelected = mode !== 'merge' && selectedSource?.relation === 'origin';
  const lastSourceSelected = mode !== 'merge' && selectedSource !== undefined && selectedSource.relation !== 'feedback' && idea.submissions.length === 1;
  const confirmedSubmissionId = confirmation !== null && confirmation.mode !== 'merge' ? confirmation.submission.id : null;
  const confirmationStale = confirmation !== null && (
    confirmation.source.updatedAt !== idea.updatedAt ||
    confirmation.source.status !== idea.status ||
    (confirmedSubmissionId !== null && !sources.some((submission) => submission.id === confirmedSubmissionId))
  );

  const loadTargets = useCallback(async (cursor: string | null, replace: boolean) => {
    targetAbort.current?.abort();
    const controller = new AbortController();
    targetAbort.current = controller;
    const requestId = ++targetRequestId.current;
    setTargetLoading(true);
    setTargetError('');
    const query = new URLSearchParams({ limit: '30' });
    for (const status of targetStatuses) query.append('status', status);
    if (cursor !== null) query.set('cursor', cursor);
    try {
      const page = await request<Page<IdeaSummaryDto>>(`/ideas?${query.toString()}`, { signal: controller.signal });
      if (controller.signal.aborted || requestId !== targetRequestId.current) return;
      const available = page.items.filter((target) => target.id !== idea.id && targetStatuses.includes(target.status));
      setTargets((previous) => Array.from(new Map((replace ? available : [...previous, ...available]).map((target) => [target.id, target])).values()));
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (!controller.signal.aborted && requestId === targetRequestId.current) setTargetError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted && requestId === targetRequestId.current) setTargetLoading(false);
    }
  }, [idea.id]);

  useEffect(() => {
    void loadTargets(null, true);
    return () => targetAbort.current?.abort();
  }, [loadTargets]);

  function changeMode(value: RelationshipMode | '') {
    setMode(value);
    setSourceId('');
    setTargetId('');
    setValidationError('');
  }

  function reloadTargets() {
    setTargetId('');
    setTargets([]);
    setNextCursor(null);
    setValidationError('');
    void loadTargets(null, true);
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate || action.busy || terminal || !mode) return;
    if (!selectedTarget) {
      setValidationError('请从服务器返回的创意中明确选择目标；不会自动选择目标。');
      return;
    }
    const source: ConfirmationSource = { id: idea.id, title: idea.title, status: idea.status, updatedAt: idea.updatedAt };
    if (mode === 'merge') {
      if (!canMerge) {
        setValidationError('已批准创意不能被整体合并走；终态创意也不能操作。');
        return;
      }
      const parsed = MergeIdeaSchema.safeParse({ targetIdeaId: selectedTarget.id, reason });
      if (!parsed.success) {
        setValidationError('整体合并必须明确选择有效目标并填写理由（最多 1000 字）。');
        return;
      }
      setValidationError('');
      setConfirmation({ mode, body: parsed.data, source, target: selectedTarget });
      return;
    }
    if (!selectedSource) {
      setValidationError('请明确选择需要重新归属的单条投稿或补充反馈。');
      return;
    }
    if (selectedSource.relation === 'origin') {
      setValidationError('USE_IDEA_MERGE：首条投稿代表创意本身，不能单独移走，请优先使用整体合并。');
      return;
    }
    const parsed = ReattributeSubmissionSchema.safeParse({ targetIdeaId: selectedTarget.id, relation: mode, reason });
    if (!parsed.success) {
      setValidationError('单条归属必须选择有效目标和关系，并填写理由（最多 1000 字）。');
      return;
    }
    setValidationError('');
    setConfirmation({ mode, body: parsed.data, source, target: selectedTarget, submission: selectedSource });
  }

  function confirm() {
    if (!canOperate || !confirmation || action.busy || terminal || confirmationStale || (confirmation.mode === 'merge' && !canMerge)) return;
    const captured = confirmation;
    void action.run(async () => {
      if (captured.mode === 'merge') {
        await request<IdeaDetailDto>(`/ideas/${captured.source.id}/merge`, { method: 'POST', body: captured.body });
      } else {
        await request<SubmissionDto>(`/submissions/${captured.submission.id}/reattribute`, { method: 'POST', body: captured.body });
      }
      await onSaved();
      setConfirmation(null);
      setMode('');
      setSourceId('');
      setTargetId('');
      setReason('');
    }, captured.mode === 'merge' ? '服务器已确认整体合并，合并与逐条归属记录已保存。请以刷新后的服务器记录为准。' : '服务器已确认单条投稿的新归属，原文和归属历史已保留。请以刷新后的服务器记录为准。');
  }

  return <section className="stack" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>人工整理关系</h3>
    {idea.status === 'approved' && <p className="notice">此创意已批准，不能整体合并走。单条重复投稿或反馈可以按允许的规则重新归属；首条创意来源不能单独移走。</p>}
    <p className="muted">整体合并会迁移全部投稿，来源创意变为“已整体合并”。单条归属只移动你选中的记录，两种操作不能混用。</p>
    <form className="stack" onSubmit={prepare}>
      <fieldset className="form-grid" disabled={!canOperate || action.busy || confirmation !== null || terminal}>
        <legend>选择操作、来源和目标</legend>
        <div className="field">
          <label htmlFor={`${id}-mode`}>操作方式</label>
          <select id={`${id}-mode`} required value={mode} onChange={(event) => changeMode(event.target.value as RelationshipMode | '')}>
            <option value="">请选择操作方式</option>
            <option value="merge" disabled={!canMerge}>整体合并重复创意（全部投稿）</option>
            <option value="duplicate">单条投稿归为重复（计入目标的全部期望功能）</option>
            <option value="feedback">单条投稿归为补充反馈（不改变目标范围）</option>
          </select>
        </div>
        {mode === 'merge' && <p className="notice">来源创意：{idea.title} · {statusLabels[idea.status]}。全部来源投稿和反馈都会保留并迁移，来源范围不会成为目标范围。</p>}
        {(mode === 'duplicate' || mode === 'feedback') && <div className="field">
          <label htmlFor={`${id}-source`}>明确选择单条来源记录</label>
          <select id={`${id}-source`} required value={sourceId} onChange={(event) => { setSourceId(event.target.value); setValidationError(''); }}>
            <option value="">请选择来源投稿或补充反馈</option>
            {sources.map((submission) => <option key={submission.id} value={submission.id}>
              {submission.fields.title || '未整理标题'} · {relationLabels[submission.relation]} · {submission.id}
            </option>)}
          </select>
        </div>}
        {originSelected && <p className="notice danger">USE_IDEA_MERGE：首条投稿（origin）代表创意本身，服务器不允许单独移走，应改用整体合并。{!canMerge && '当前创意已批准或处于终态，整体合并同样不可用。'}</p>}
        {lastSourceSelected && <p className="notice">你选择的是此创意最后一条来源投稿。请优先整体合并，以保留完整创意的去向；能否单独移动最终由服务器校验。首条投稿会返回 USE_IDEA_MERGE。</p>}
        {(originSelected || lastSourceSelected) && canMerge && <Button variant="outline" type="button" onClick={() => changeMode('merge')}>改为整体合并</Button>}
        <div className="field">
          <label htmlFor={`${id}-target`}>目标创意（标题 · 当前列表状态 · ID）</label>
          <select id={`${id}-target`} required value={targetId} disabled={targetLoading} onChange={(event) => { setTargetId(event.target.value); setValidationError(''); }}>
            <option value="">请选择目标创意，不会默认选择</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.title} · {statusLabels[target.status]} · {target.id}</option>)}
          </select>
          <p className="muted">仅列出服务器返回的待整理、待审核、退回和已批准创意，排除当前创意。目标状态来自列表读取，提交时服务器会再次校验。</p>
        </div>
        <div className="actions">
          <Button variant="outline" type="button" disabled={targetLoading || !nextCursor} onClick={() => void loadTargets(nextCursor, false)}>{targetLoading ? '正在读取目标…' : '加载更多可选创意'}</Button>
          <Button variant="outline" type="button" disabled={targetLoading} onClick={reloadTargets}>重新加载目标列表</Button>
        </div>
        {!targetLoading && targets.length === 0 && !targetError && <p className="muted">当前已加载页面没有可选目标。{nextCursor ? '可继续加载下一页。' : '服务器未提供其他可用创意。'}</p>}
        {targetError && <p className="notice danger" role="alert">目标列表读取失败：{targetError}。可以重新加载；不会使用虚构目标。</p>}
        <div className="field">
          <label htmlFor={`${id}-reason`}>关系调整理由（必填，最多 1000 字）</label>
          <Textarea id={`${id}-reason`} required maxLength={1000} rows={3} value={reason} onChange={(event) => { setReason(event.target.value); setValidationError(''); }} />
        </div>
      </fieldset>
      {validationError && <p className="notice danger" role="alert">{validationError}</p>}
      <Button ref={confirmationButton} type="submit" disabled={!canOperate || action.busy || confirmation !== null || terminal || targetLoading || !mode || !selectedTarget || originSelected || (mode === 'merge' && !canMerge)}>核对来源和目标，进入确认</Button>
    </form>
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => {
      if (!open && !action.busy) setConfirmation(null);
    }}>
      {confirmation && <AlertDialogContent className="confirmation-dialog" onEscapeKeyDown={(event) => {
        if (action.busy) event.preventDefault();
      }} onCloseAutoFocus={(event) => {
        event.preventDefault();
        confirmationButton.current?.focus();
      }}>
        <AlertDialogHeader>
          <AlertDialogTitle>请明确确认：{modeLabels[confirmation.mode]}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation.mode === 'merge' ? '来源创意将成为已合并终态，全部投稿迁到目标，每条迁移保留归属记录。目标的本次范围和批准状态不变。' : confirmation.mode === 'feedback' ? '只有选中记录成为目标的补充反馈，不计入目标全部期望功能，不修改其本次范围或批准状态。' : '只有选中记录成为目标的重复投稿，其期望功能计入目标全部期望功能，不会自动进入三功能范围。'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="confirmation-scroll stack" aria-busy={action.busy}>
          <article className="record stack">
            <div>
              <h4>来源创意</h4>
              <p>{confirmation.source.title} <Badge variant="outline">{statusLabels[confirmation.source.status]}</Badge></p>
              <p className="muted">来源 ID：{confirmation.source.id}</p>
            </div>
            {confirmation.mode !== 'merge' && <>
              <div>
                <h4>仅移动这条记录</h4>
                <p>{confirmation.submission.fields.title || '未整理标题'}</p>
                <div className="inline-meta">
                  <Badge variant="secondary">{sourceLabels[confirmation.submission.source]}</Badge>
                  <Badge variant="outline">{relationLabels[confirmation.submission.relation]}</Badge>
                  {confirmation.submission.isSimulated && <Badge variant="outline">非真实抖音接入</Badge>}
                </div>
                <p className="muted">投稿 ID：{confirmation.submission.id}</p>
              </div>
              <div><h4>不可修改的原文</h4><blockquote className="raw-quote">{confirmation.submission.rawText}</blockquote></div>
              <p><strong>新关系：</strong>{relationLabels[confirmation.body.relation]}</p>
            </>}
            <div>
              <h4>目标创意</h4>
              <p>{confirmation.target.title} <Badge variant="outline">{statusLabels[confirmation.target.status]}</Badge></p>
              <p className="muted">目标 ID：{confirmation.target.id}</p>
            </div>
            <div><h4>关系调整理由</h4><p className="raw-text">{confirmation.body.reason}</p></div>
          </article>
          <p className="muted">原始投稿与历史记录不会删除。只有服务器确认后才刷新列表，不会提前移除来源记录。取消会返回已保留的草稿。</p>
          {!canOperate && <p className="notice">当前权限、详情同步或连接尚未就绪，确认内容保留，暂不能提交。</p>}
          {confirmationStale && <p className="notice danger" role="alert">来源创意或投稿信息已更新，此确认失效。请取消后重新核对来源和目标。</p>}
          <ActionFeedback error={action.error} success="" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={action.busy}>取消，返回选择</AlertDialogCancel>
          <AlertDialogAction type="button" disabled={!canOperate || action.busy || confirmationStale || terminal || (confirmation.mode === 'merge' && !canMerge)} onClick={(event) => {
            event.preventDefault();
            confirm();
          }}>{action.busy ? '正在等待服务器确认…' : `确认${modeLabels[confirmation.mode]}`}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>}
    </AlertDialog>
    {!confirmation && <ActionFeedback error={action.error} success={action.success} />}
  </section>;
}

export function RelationshipPanel({ idea, canOperate, onSaved }: RelationshipPanelProps) {
  const terminal = idea.status === 'merged' || idea.status === 'rejected';
  return <Card id="relationships-section" className="panel stack" role="region" aria-label="创意合并与补充反馈归属">
    <header className="panel-header">
      <div><p className="eyebrow">可追溯的人工关系整理</p><h2>整体合并与单条归属</h2></div>
    </header>
    <p className="muted">原文、真实来源和历史记录不可变且不会删除。整体合并保存合并记录，并逐条保存迁移归属；单条归属也保存原创意、目标创意、关系、理由和操作人。补充反馈单独保留，不修改三功能范围或沿用/生成任何批准。</p>
    {(terminal || !canOperate) && <p className="notice">{terminal ? '创意已拒绝或合并，不能进行关系调整，历史记录仍可查看。' : '当前只读：详情同步、操作权限或服务器连接尚未就绪。关系草稿与确认内容保留，暂不能调整归属。'}</p>}
    <RelationshipEditor key={idea.id} idea={idea} canOperate={canOperate} onSaved={onSaved} />
    <section className="stack" aria-label="本创意被整体合并的去向">
      <h3>本创意的整体合并去向</h3>
      {idea.mergeOut ? <article className="record">
        <p>已整体合并至目标创意 · <time dateTime={idea.mergeOut.createdAt}>{new Date(idea.mergeOut.createdAt).toLocaleString('zh-CN')}</time></p>
        <p>理由：{idea.mergeOut.reason}</p>
        <details className="audit-details">
          <summary>来源、目标与合并审计信息</summary>
          <p>来源：{idea.mergeOut.sourceIdeaId} → 目标：{idea.mergeOut.targetIdeaId}</p>
          <p className="muted">操作人：{idea.mergeOut.actor} · 合并记录：{idea.mergeOut.id}</p>
        </details>
      </article> : <p className="muted">没有整体合并出去的记录。</p>}
    </section>
    <section className="stack" aria-label="合并进本创意的历史">
      <h3>整体合并进本创意（{idea.mergesIn.length}）</h3>
      {idea.mergesIn.length === 0 && <p className="muted">暂无整体合并记录。</p>}
      {idea.mergesIn.map((merge) => <article className="record" key={merge.id}>
        <p>整体合并记录 · <time dateTime={merge.createdAt}>{new Date(merge.createdAt).toLocaleString('zh-CN')}</time></p>
        <p>理由：{merge.reason}</p>
        <details className="audit-details">
          <summary>来源、目标与合并审计信息</summary>
          <p>来源：{merge.sourceIdeaId} → 目标：{merge.targetIdeaId}</p>
          <p className="muted">操作人：{merge.actor} · 合并记录：{merge.id}</p>
        </details>
      </article>)}
    </section>
    <section className="stack" aria-label="本创意的补充反馈记录">
      <h3>补充反馈（{idea.feedback.length}）</h3>
      <p className="muted">补充反馈不是本次三功能范围，也不计入全部期望功能。原文和来源保持原样，只有当前归属关系可由人工调整。</p>
      {idea.feedback.length === 0 && <p className="muted">暂无补充反馈。</p>}
      {idea.feedback.map((feedback) => <details className="record" key={feedback.id}>
        <summary>{feedback.fields.title || '未整理标题的补充反馈'} <Badge variant="secondary">{sourceLabels[feedback.source]}</Badge> {feedback.isSimulated && <Badge variant="outline">非真实抖音接入</Badge>}</summary>
        <p>关系：{relationLabels[feedback.relation]} · 作者：{feedback.authorName || '未提供'}</p>
        <p className="muted">接收时间：<time dateTime={feedback.receivedAt}>{feedback.receivedAt}</time></p>
        <details className="audit-details"><summary>投稿标识与归属</summary><p className="muted">投稿 ID：{feedback.id} · 当前归属：{feedback.ideaId}</p></details>
        <h4>不可修改的原文</h4><blockquote className="raw-quote">{feedback.rawText}</blockquote>
        <p className="muted">每次归属调整的不可变记录由服务器保留；不会因本次移动删除此投稿。</p>
      </details>)}
    </section>
  </Card>;
}
