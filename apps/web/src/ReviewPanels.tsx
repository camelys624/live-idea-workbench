import { useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ProposeScopeSchema, ReviewSchema } from '@workbench/contracts';
import type {
  IdeaDetailDto,
  ReviewDecision,
  ReviewRequest,
  ReviewResponse,
  ScopeFeature,
  ScopeVersionDto,
  ScopeVersionStatus,
} from '@workbench/contracts';
import { ApiError, request } from './api';
import { ActionFeedback, useAction } from './useAction';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ScopePanelProps {
  idea: IdeaDetailDto;
  canOperate: boolean;
  canReview: boolean;
  onSaved: () => Promise<void>;
  children?: ReactNode;
}

const scopeStatusLabels: Record<ScopeVersionStatus, string> = {
  pending_review: '待人工审核',
  approved: '已批准',
  returned: '已退回',
  rejected: '已拒绝',
  superseded: '已被新版本取代，不能沿用批准',
};

const decisionLabels: Record<ReviewDecision, string> = {
  approve: '批准',
  return: '退回补充',
  reject: '拒绝创意',
};

function ScopeContent({ scope }: { scope: ScopeVersionDto }) {
  return <article className="stack scope-content">
    <div className="inline-meta scope-version-badges">
      <Badge variant="outline">范围 v{scope.versionNo}</Badge>
      <Badge variant="secondary" className="scope-status" data-status={scope.status}>{scopeStatusLabels[scope.status]}</Badge>
    </div>
    <ol className="feature-list">
      {scope.features.map((feature, index) => <li key={index}>
        <Card className="scope-feature-card">
          <CardHeader className="scope-feature-header">
            <span className="scope-feature-number" aria-hidden="true">0{index + 1}</span>
            <CardTitle><h4>{feature.title}</h4></CardTitle>
          </CardHeader>
          <CardContent className="scope-feature-criteria">
            <p><span className="muted">完成标准：</span>{feature.acceptanceCriteria}</p>
          </CardContent>
        </Card>
      </li>)}
    </ol>
    <dl className="scope-summary-grid">
      <div><dt>页面范围</dt><dd>{scope.pageScope}</dd></div>
      <div><dt>风格</dt><dd>{scope.style || '未指定'}</dd></div>
    </dl>
    {scope.notes && <p className="muted"><strong>备注：</strong>{scope.notes}</p>}
    <details className="scope-audit">
      <summary>版本与审计详情</summary>
      <div className="stack muted">
        <p>版本 ID：{scope.id}</p>
        <p>提交人：{scope.proposedBy} · <time dateTime={scope.createdAt}>{scope.createdAt}</time></p>
        <p>状态更新时间：<time dateTime={scope.statusChangedAt}>{scope.statusChangedAt}</time></p>
      </div>
    </details>
  </article>;
}

interface ScopeDraft {
  baseVersionId: string | null;
  features: [ScopeFeature, ScopeFeature, ScopeFeature];
  pageScope: string;
  style: string;
  notes: string;
}

function draftFrom(scope: ScopeVersionDto | undefined, baseVersionId: string | null): ScopeDraft {
  return {
    baseVersionId,
    features: [0, 1, 2].map((index) => ({
      title: scope?.features[index]?.title ?? '',
      acceptanceCriteria: scope?.features[index]?.acceptanceCriteria ?? '',
    })) as ScopeDraft['features'],
    pageScope: scope?.pageScope ?? '',
    style: scope?.style ?? '',
    notes: scope?.notes ?? '',
  };
}

function ScopeEditor({ idea, canOperate, onSaved }: Pick<ScopePanelProps, 'idea' | 'canOperate' | 'onSaved'>) {
  const id = useId();
  const current = idea.scopeVersions.find((version) => version.id === idea.currentScopeVersionId);
  const [expanded, setExpanded] = useState(() => !current);
  // The keyed editor owns its base for its whole lifetime. SSE never rebases a draft.
  const [draft, setDraft] = useState(() => draftFrom(current, idea.currentScopeVersionId));
  const [dirty, setDirty] = useState(false);
  const [blockedBase, setBlockedBase] = useState<'conflict' | 'submitted' | null>(null);
  const [validationError, setValidationError] = useState('');
  const action = useAction();
  const terminal = idea.status === 'merged' || idea.status === 'rejected';
  const stale = blockedBase !== null || draft.baseVersionId !== idea.currentScopeVersionId;
  const base = idea.scopeVersions.find((version) => version.id === draft.baseVersionId);

  function changeFeature(index: number, field: keyof ScopeFeature, value: string) {
    if (!canOperate || terminal || action.busy) return;
    setDraft((previous) => {
      const features: ScopeDraft['features'] = [...previous.features];
      const feature = features[index];
      if (!feature) return previous;
      features[index] = { ...feature, [field]: value };
      return { ...previous, features };
    });
    setDirty(true);
    setValidationError('');
  }

  function changeText(field: 'pageScope' | 'style' | 'notes', value: string) {
    if (!canOperate || terminal || action.busy) return;
    setDraft((previous) => ({ ...previous, [field]: value }));
    setDirty(true);
    setValidationError('');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate || terminal || stale || action.busy) return;
    const parsed = ProposeScopeSchema.safeParse({
      ...draft,
      style: draft.style.trim() || null,
      notes: draft.notes.trim() || null,
    });
    if (!parsed.success) {
      setValidationError('范围必须恰好包含三个功能，每个功能都要有标题和完成标准，并填写页面范围。请检查字段长度限制。');
      return;
    }
    setValidationError('');
    void action.run(async () => {
      try {
        await request<ScopeVersionDto>(`/ideas/${idea.id}/scope-versions`, { method: 'POST', body: parsed.data });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'STALE_SCOPE_VERSION') {
          setBlockedBase('conflict');
          await onSaved();
        }
        throw error;
      }
      setBlockedBase('submitted');
      setDirty(false);
      await onSaved();
    }, '服务器已保存新的不可变范围版本，等待人工审核；旧批准不能沿用。继续修改前，请加载最新版本。');
  }

  function discard() {
    setDraft(draftFrom(current, idea.currentScopeVersionId));
    setDirty(false);
    setBlockedBase(null);
    setValidationError('');
  }

  return <section className="stack scope-editor" aria-labelledby={`${id}-heading`}>
    <div className="actions">
      <Button variant="outline" type="button" aria-expanded={expanded} aria-controls={`${id}-content`} disabled={action.busy} onClick={() => setExpanded((previous) => !previous)}>
        {expanded ? '收起范围编辑' : '编辑本次范围'}
      </Button>
    </div>
    <div id={`${id}-content`} className="stack scope-editor-content" hidden={!expanded}>
      <h3 id={`${id}-heading`}>提交新的三功能范围</h3>
      <p className="muted">这是本次最终实现范围，不是观众全部期望功能或原文中的优先项。提交不会覆盖原文、删除期望功能或修改旧范围版本。</p>
      {idea.status === 'approved' && <p className="notice danger">当前范围已人工批准。修改最终范围会新建版本、使旧批准失效，并重新进入待审核；不可沿用旧批准。</p>}
      {terminal && <p className="notice">创意已拒绝或合并，范围草稿只读，不能提交。</p>}
      <p className="muted">草稿依据：{base ? `v${base.versionNo}` : draft.baseVersionId ? '原范围版本（详情暂不可用）' : '尚无范围版本'} · {dirty ? '有未提交修改' : '尚未修改草稿'}</p>
      <details className="scope-audit">
        <summary>草稿依据版本 ID</summary>
        <p className="muted">{draft.baseVersionId ?? '尚无范围版本'}</p>
      </details>
      {stale && <p className="notice danger" role="alert">{blockedBase === 'submitted' ? '此草稿已提交为新版本，原范围依据已过期。' : blockedBase === 'conflict' ? '服务器已拒绝这个过期的范围依据。' : '当前最新范围已改变。'}{dirty ? '你的未提交草稿已保留，未自动改写或换用新依据。' : '编辑器仍保留打开时的范围依据。'}禁止提交此草稿；请先核对最新范围，再丢弃草稿并载入当前版本。</p>}
      <form className="stack" onSubmit={submit}>
        <fieldset disabled={!canOperate || action.busy || terminal} className="stack">
          <legend>固定三个功能，不能增加或减少</legend>
          {draft.features.map((feature, index) => <fieldset className="record form-grid" key={index}>
            <legend>功能 {index + 1}</legend>
            <div className="field">
              <label htmlFor={`${id}-feature-${index}`}>功能标题（必填，最多 200 字）</label>
              <Input id={`${id}-feature-${index}`} required maxLength={200} value={feature.title} onChange={(event) => changeFeature(index, 'title', event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-criteria-${index}`}>完成标准（必填，最多 2000 字）</label>
              <Textarea id={`${id}-criteria-${index}`} required maxLength={2000} rows={3} value={feature.acceptanceCriteria} onChange={(event) => changeFeature(index, 'acceptanceCriteria', event.target.value)} />
            </div>
          </fieldset>)}
          <div className="field">
            <label htmlFor={`${id}-pages`}>页面范围（必填，最多 2000 字）</label>
            <Textarea id={`${id}-pages`} required maxLength={2000} rows={3} value={draft.pageScope} onChange={(event) => changeText('pageScope', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-style`}>风格（选填，最多 500 字）</label>
            <Textarea id={`${id}-style`} maxLength={500} rows={2} value={draft.style} onChange={(event) => changeText('style', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-notes`}>范围备注（选填，最多 2000 字）</label>
            <Textarea id={`${id}-notes`} maxLength={2000} rows={3} value={draft.notes} onChange={(event) => changeText('notes', event.target.value)} />
          </div>
        </fieldset>
        {validationError && <p className="notice danger" role="alert">{validationError}</p>}
        <div className="actions">
          <Button type="submit" disabled={!canOperate || action.busy || terminal || stale}>{action.busy ? '正在提交…' : '提交新范围版本，进入待审核'}</Button>
          <Button variant="outline" type="button" onClick={discard} disabled={!canOperate || action.busy}>丢弃草稿并载入当前版本</Button>
          <Button variant="ghost" type="button" disabled={action.busy} onClick={() => void onSaved()}>刷新服务器详情（保留草稿）</Button>
        </div>
        <ActionFeedback error={action.error} success={action.success} />
      </form>
    </div>
  </section>;
}

interface ReviewConfirmation {
  body: ReviewRequest;
  scope: ScopeVersionDto | undefined;
  ideaStatus: IdeaDetailDto['status'];
}

function ReviewActions({ idea, canReview, onSaved }: Pick<ScopePanelProps, 'idea' | 'canReview' | 'onSaved'>) {
  const id = useId();
  const prepareButton = useRef<HTMLButtonElement>(null);
  const decisionInput = useRef<HTMLSelectElement>(null);
  const current = idea.scopeVersions.find((version) => version.id === idea.currentScopeVersionId);
  const [decision, setDecision] = useState<ReviewDecision | ''>('');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState<ReviewConfirmation | null>(null);
  const [blockedVersion, setBlockedVersion] = useState<{ id: string | null } | null>(null);
  const [validationError, setValidationError] = useState('');
  const action = useAction();
  const pending = idea.status === 'pending_review' && current?.status === 'pending_review';
  const terminal = idea.status === 'merged' || idea.status === 'rejected';
  const serverStale = blockedVersion !== null && blockedVersion.id === idea.currentScopeVersionId;
  const confirmationStale = confirmation !== null && (
    confirmation.body.scopeVersionId !== idea.currentScopeVersionId ||
    confirmation.ideaStatus !== idea.status ||
    confirmation.scope?.status !== current?.status || serverStale
  );

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canReview || action.busy || terminal || serverStale) return;
    if (!decision || (decision !== 'reject' && !pending)) {
      setValidationError('请选择当前状态允许的人工审核决定；只有当前待审核版本可以批准或退回。');
      return;
    }
    const parsed = ReviewSchema.safeParse({ decision, scopeVersionId: idea.currentScopeVersionId, reason: reason.trim() || null });
    if (!parsed.success) {
      setValidationError('退回和拒绝必须填写理由（最多 2000 字）；批准必须针对当前待审核范围版本。');
      return;
    }
    setValidationError('');
    setConfirmation({ body: parsed.data, scope: current, ideaStatus: idea.status });
  }

  function confirm() {
    if (!canReview || !confirmation || action.busy || confirmationStale || terminal) return;
    const captured = confirmation;
    void action.run(async () => {
      try {
        await request<ReviewResponse>(`/ideas/${idea.id}/reviews`, { method: 'POST', body: captured.body });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'STALE_SCOPE_VERSION') {
          setBlockedVersion({ id: captured.body.scopeVersionId });
          await onSaved();
        }
        throw error;
      }
      await onSaved();
      setConfirmation(null);
      setDecision('');
      setReason('');
    }, '服务器已记录人工审核。批准与否以上方服务器返回的当前范围和审核历史为准。');
  }

  return <section className="stack review-area" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>人工审核（仅审核员）</h3>
    <p className="muted">审核只记录人类决定，不会自动立项、创建任务、选择 agent 或启动执行。</p>
    {serverStale && <p className="notice danger" role="alert">服务器已确认审核依据过期。请刷新最新详情后，针对新版本重新确认。</p>}
    <form className="stack review-form" onSubmit={prepare}>
      <fieldset className="form-grid" disabled={!canReview || action.busy || confirmation !== null || terminal || serverStale}>
        <legend>选择审核决定</legend>
        <div className="field">
          <label htmlFor={`${id}-decision`}>决定</label>
          <select ref={decisionInput} className="native-select" id={`${id}-decision`} required value={decision} onChange={(event) => { setDecision(event.target.value as ReviewDecision | ''); setValidationError(''); }}>
            <option value="">请选择审核决定</option>
            <option value="approve" disabled={!pending}>批准当前待审核范围</option>
            <option value="return" disabled={!pending}>退回补充</option>
            <option value="reject" disabled={terminal}>拒绝创意，不立项</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-reason`}>审核理由（退回、拒绝必填；最多 2000 字）</label>
          <Textarea id={`${id}-reason`} required={decision === 'return' || decision === 'reject'} maxLength={2000} rows={3} value={reason} onChange={(event) => { setReason(event.target.value); setValidationError(''); }} />
        </div>
      </fieldset>
      {validationError && <p className="notice danger" role="alert">{validationError}</p>}
      <div className="actions review-action-bar">
        <div className="review-action-status" data-status={current?.status}><strong>{current ? scopeStatusLabels[current.status] : '范围尚未提交'}</strong><small>批准后仍需人工分配与确认启动</small></div>
        <Button variant="outline" type="button" disabled={action.busy} onClick={() => void onSaved()}>刷新最新详情</Button>
        <Button ref={prepareButton} type={decision ? 'submit' : 'button'} disabled={!canReview || action.busy || confirmation !== null || terminal || serverStale} onClick={() => {
          if (!decision) {
            decisionInput.current?.scrollIntoView({ block: 'center' });
            decisionInput.current?.focus();
          }
        }}>{decision ? '查看范围并确认审核' : '选择审核决定'}</Button>
      </div>
    </form>
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !action.busy) setConfirmation(null); }}>
      {confirmation && <AlertDialogContent className="review-confirmation" onEscapeKeyDown={(event) => { if (action.busy) event.preventDefault(); }} onCloseAutoFocus={(event) => { event.preventDefault(); prepareButton.current?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>请明确确认：{decisionLabels[confirmation.body.decision]}</AlertDialogTitle>
          <AlertDialogDescription>本次审核只适用于下方捕获的范围版本，不适用于全部期望功能；不会自动立项、分配或启动执行。</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="stack review-confirmation-scroll" tabIndex={0} role="region" aria-label="本次审核范围与理由">
          <p><strong>创意：</strong>{idea.title}</p>
          {confirmation.scope ? <ScopeContent scope={confirmation.scope} /> : <p className="muted">此创意还没有范围版本；此次拒绝针对创意本身。</p>}
          <p className="review-reason"><strong>审核理由：</strong>{confirmation.body.reason || '未填写（批准可选）'}</p>
          {confirmation.body.decision === 'reject' && <p className="notice danger">拒绝后创意进入终态，批准失效，不会立项；原始记录与范围历史仍保留。</p>}
          {confirmation.body.decision === 'approve' && <p>确认后将由服务器批准当前版本；不会因此自动开始开发。</p>}
          {confirmationStale && <p className="notice danger" role="alert">范围版本或审核状态已变化，此确认已失效。请取消，刷新并重新核对当前版本。</p>}
          {!canReview && <p className="notice" role="alert">审核权限或服务器连接尚未就绪，确认内容已保留，暂不能提交审核。</p>}
          <ActionFeedback error={action.error} success="" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={action.busy}>取消确认，返回编辑</AlertDialogCancel>
          <Button variant={confirmation.body.decision === 'reject' ? 'destructive' : 'default'} type="button" disabled={!canReview || action.busy || confirmationStale || terminal} onClick={confirm}>{action.busy ? '正在记录审核…' : `确认${decisionLabels[confirmation.body.decision]}`}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>}
    </AlertDialog>
    {!confirmation && <ActionFeedback error={action.error} success={action.success} />}
  </section>;
}

export function ScopePanel({ idea, canOperate, canReview, onSaved, children }: ScopePanelProps) {
  const current = idea.scopeVersions.find((version) => version.id === idea.currentScopeVersionId);
  const approved = idea.scopeVersions.find((version) => version.id === idea.approvedScopeVersionId);
  return <section id="scope-section" className="stack" aria-label="范围版本与人工审核">
    <Card className="panel stack">
    <header className="panel-header">
      <div><h2>本次只做三个功能</h2><p className="muted">每项功能都有独立完成标准</p></div>
      <Badge variant="outline" className="scope-selection-count">{current ? `${current.features.length} / 3` : '尚未提交'}</Badge>
    </header>
    <section className="stack" aria-label="服务器当前范围">
      {current ? <ScopeContent scope={current} /> : <p className="muted">{idea.currentScopeVersionId ? '当前版本详情暂不可用，请刷新服务器详情。' : '尚未提交三功能范围。'}</p>}
    </section>
    <details className="scope-approval-summary" aria-label="服务器有效批准范围">
      <summary>查看人工批准结果</summary>
      <div className="stack">
      <div className="inline-meta">
        <h3>人工批准结果</h3>
        {approved && <Badge variant="secondary" className="scope-status" data-status={approved.status}>v{approved.versionNo} · {scopeStatusLabels[approved.status]}</Badge>}
      </div>
      {approved ? <p>{approved.id === current?.id ? '当前三功能范围已有服务器记录的人工批准。' : `服务器记录的有效批准为范围 v${approved.versionNo}，与上方当前版本不同；请核对范围历史。`}</p> : <p className="notice">{idea.approvedScopeVersionId ? '服务器提供的批准版本详情暂不可用，请刷新核实。' : '服务器未提供有效批准版本。旧版曾被批准，也不能替代当前批准。'}</p>}
      <p className="muted">{idea.launch.launchable ? '服务器确认当前版本已获批准；本页面不执行立项或启动。' : `服务器未确认可立项：${idea.launch.reason ?? '无有效批准范围'}`}</p>
      </div>
    </details>
    {!canOperate && <p className="notice">当前只读：详情同步、操作权限或服务器连接尚未就绪。草稿保留，暂不能提交范围修改。</p>}
    <ScopeEditor key={`scope-${idea.id}`} idea={idea} canOperate={canOperate} onSaved={onSaved} />
    </Card>
    {children}
    <Card className="panel stack">
    {!canReview && <p className="notice">当前只读：详情同步、审核权限或服务器连接尚未就绪。审核草稿与确认内容保留，暂不能批准、退回或拒绝。</p>}
    <ReviewActions key={`review-${idea.id}`} idea={idea} canReview={canReview} onSaved={onSaved} />
    <details className="scope-history" aria-label="不可变范围版本历史">
      <summary>范围版本历史（{idea.scopeVersions.length}）</summary>
      <div className="stack">
        {idea.scopeVersions.length === 0 && <p className="muted">暂无范围版本。</p>}
        {idea.scopeVersions.map((scope) => <details className="record" key={scope.id}>
          <summary>v{scope.versionNo} · {scopeStatusLabels[scope.status]} · {scope.createdAt}</summary>
          <ScopeContent scope={scope} />
        </details>)}
      </div>
    </details>
    <details className="scope-history" aria-label="服务器人工审核历史">
      <summary>人工审核历史（{idea.reviews.length}）</summary>
      <div className="stack">
        {idea.reviews.length === 0 && <p className="muted">暂无人工审核记录。</p>}
        {idea.reviews.map((review) => {
          const reviewedScope = idea.scopeVersions.find((version) => version.id === review.scopeVersionId);
          return <article className="record" key={review.id}>
            <div className="inline-meta"><Badge variant="outline">{decisionLabels[review.decision]}</Badge><span>审核人：{review.reviewer}</span><time dateTime={review.createdAt}>{review.createdAt}</time></div>
            <p>审核依据：{reviewedScope ? `v${reviewedScope.versionNo}（${reviewedScope.id}）` : review.scopeVersionId ?? '尚无范围版本，拒绝创意本身'}</p>
            <p>理由：{review.reason || '未填写'}</p>
            <p className="muted">记录 ID：{review.id}。历史批准记录不等于当前有效批准。</p>
          </article>;
        })}
      </div>
    </details>
    </Card>
  </section>;
}
