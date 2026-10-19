import { useId, useRef, useState } from 'react';
import type { AiAssessmentDto, AiDecision, IdeaDetailDto, IdeaPlatformDto, MeDto, PlatformOperationState } from '@workbench/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ApiError, request } from './api';
import { ActionFeedback, useAction } from './useAction';
import type { PlatformState } from './usePlatform';

interface AiPanelProps {
  idea: IdeaDetailDto;
  identity: MeDto | null;
  canWrite: boolean;
  state: PlatformState;
}

const decisionLabels: Record<AiDecision, string> = {
  create_task: '建议进入人工待审', duplicate: '建议归为重复投稿', feedback: '建议作为补充反馈',
  needs_info: '需要补充信息', skip: '不建议建任务',
};
const statusLabels: Record<AiAssessmentDto['status'], string> = {
  pending: '判断中（排队或调用中）', succeeded: '判断已完成', failed: '模型判断失败',
};
const operationLabels: Record<PlatformOperationState, string> = {
  pending: '等待执行', running: '执行中', succeeded: '已确认成功', failed: '已失败', unknown: '结果不明，需对账',
};

interface SubmissionLock {
  platform: IdeaPlatformDto;
  assessmentIds: Set<string>;
  outcome: 'submitting' | 'accepted' | 'unknown' | 'route_missing';
}
// Do not lose an uncertain write by switching ideas or remounting this panel.
const submissionLocks = new Map<string, SubmissionLock>();

function AssessmentRecord({ assessment }: { assessment: AiAssessmentDto }) {
  return <article className="record stack" aria-label={`AI 判断 ${assessment.id}`}>
    <div className="inline-meta">
      <Badge variant={assessment.status === 'failed' ? 'destructive' : 'secondary'}>{statusLabels[assessment.status]}</Badge>
      <span>模型：{assessment.model || '服务器未提供'}</span>
    </div>
    <p><strong>决定：</strong>{assessment.decision ? decisionLabels[assessment.decision] : '尚无决定'}</p>
    <p><strong>判断依据：</strong>{assessment.reason || (assessment.status === 'pending' ? '等待模型结果。' : '服务器未提供判断依据。')}</p>
    {assessment.error && <p className="notice danger">模型错误：{assessment.error}</p>}
    {assessment.suggestedTargetIdeaId && <p>建议目标创意 ID：<span className="id-text">{assessment.suggestedTargetIdeaId}</span>。仅供人工核对，不会自动合并或归属。</p>}
    {assessment.suggestedFeatures.length === 3 ? <section className="stack" aria-label="三功能参考建议">
      <h4>三个功能建议（仅供参考）</h4>
      <p className="muted">不会自动创建本次范围，也不构成人工批准。</p>
      <ol className="feature-list">{assessment.suggestedFeatures.map((feature, index) => <li key={index}>
        <div><h4>{index + 1}. {feature.title}</h4><p>完成标准：{feature.acceptanceCriteria}</p></div>
      </li>)}</ol>
    </section> : assessment.suggestedFeatures.length === 0
      ? <p className="muted">此次没有三功能建议。</p>
      : <p className="notice danger">服务器返回的功能建议不是恰好三项，不能作为三功能范围使用；请核实服务器记录。</p>}
    <div className="stack muted">
      <p>请求时间：<time dateTime={assessment.createdAt}>{assessment.createdAt}</time> · 请求人：{assessment.requestedBy}</p>
      <p>完成时间：{assessment.completedAt ? <time dateTime={assessment.completedAt}>{assessment.completedAt}</time> : '尚无完成记录'}</p>
      <p>判断 ID：{assessment.id}</p>
    </div>
  </article>;
}

export function AiPanel({ idea, identity, canWrite, state }: AiPanelProps) {
  const id = useId();
  const action = useAction();
  const [, updateLock] = useState(0);
  const [confirmation, setConfirmation] = useState<{ snapshot: string; title: string; createsReviewTask: boolean } | null>(null);
  const platform = state.platform?.ideaId === idea.id ? state.platform : null;
  const latestPlatform = useRef(platform);
  latestPlatform.current = platform;
  const integrations = state.integrations;
  const assessments = platform?.assessments ?? [];
  const reviewTask = platform?.reviewTask;
  const operations = [...(reviewTask?.operations ?? []), ...(platform?.product?.devTask.operations ?? [])];
  const unknownOperation = operations.some((operation) => operation.state === 'unknown');
  const pendingOperation = operations.some((operation) => operation.state === 'pending' || operation.state === 'running');
  const pendingAssessment = assessments.some((assessment) => assessment.status === 'pending');
  const submissions = [...idea.submissions, ...idea.feedback];
  const allowedSources = submissions.length > 0 && submissions.every((submission) => submission.isSimulated && (submission.source === 'manual' || submission.source === 'sample'));
  const terminal = idea.status === 'merged' || idea.status === 'rejected';
  const lock = submissionLocks.get(idea.id);
  const refreshed = platform !== null && platform !== lock?.platform && !state.loading && !state.platformError && !state.unavailable;
  const newAssessment = assessments.some((assessment) => lock && !lock.assessmentIds.has(assessment.id));
  const submissionBlocked = !!lock && (lock.outcome === 'submitting' || lock.outcome === 'route_missing' || !refreshed || (lock.outcome === 'accepted' && !newAssessment));
  const aiConfigured = integrations?.ai.state === 'configured' && integrations.ai.dataScope === 'simulated_only' && integrations.ai.checks.every((check) => check.ok);
  const writesEnabled = integrations?.multica.writesEnabled === true;
  const multicaReady = !writesEnabled || (integrations?.multica.state === 'configured' && integrations.multica.checks.every((check) => check.ok));
  const snapshot = JSON.stringify({ idea, identity, integrations, platform });
  const confirmationStale = confirmation !== null && confirmation.snapshot !== snapshot;
  const disabledReasons = [
    !identity?.roles.includes('operator') && '仅 operator（运营）身份可手动请求 AI 判断。',
    !canWrite && '当前详情、身份或事件同步尚未就绪，只能查看历史。',
    (state.unavailable || !platform) && '平台读取接口尚不可用或未成功返回；不能确认判断历史，已禁用请求。',
    !!state.platformError && '平台读取失败，已保留的历史仅供只读参考。',
    !!state.integrationsError && '集成配置读取失败，不能确认当前配置。',
    state.loading && '正在刷新服务器状态，请稍候。',
    !aiConfigured && (!integrations ? '尚未取得 AI 配置，不能判断模型是否已配置。' : integrations.ai.state === 'not_configured' ? 'AI 尚未配置，不能调用模型；人工投稿与审核仍可使用。' : 'AI 配置不完整、用途范围不允许或检查未通过，请查看集成检查。'),
    !multicaReady && 'Multica 写入开关已开启，但本地配置检查未通过，暂不能请求可能建待审任务的判断。',
    !allowedSources && '仅允许全部相关投稿（含补充反馈）均为模拟的人工录入或示例来源；抖音投稿不送入模型。',
    terminal && '已合并或已拒绝的创意不能再请求 AI 判断。',
    pendingAssessment && '已有判断排队或调用中，请刷新等待，不能重复提交。',
    unknownOperation && '存在结果不明的平台作业；须由调度员对账，不能重新提交。',
    pendingOperation && '存在尚未完成的平台写入作业，请等待并刷新。',
    submissionBlocked && (lock?.outcome === 'route_missing'
      ? 'AI 判断写入接口尚未开放（404）；已禁用请求，待后端部署后重新加载页面。'
      : lock?.outcome === 'accepted'
        ? '请求已被接收，尚待平台 GET 历史确认新判断；不会因接收响应宣称模型成功或再次提交。'
        : '此次写入正在提交或结果待核实，已锁定再次请求。请刷新权威记录；若有结果不明的平台作业，需先对账。'),
  ].filter((reason): reason is string => typeof reason === 'string');
  const eligible = disabledReasons.length === 0 && !action.busy;

  function prepare() {
    if (!eligible) return;
    setConfirmation({ snapshot, title: idea.title, createsReviewTask: writesEnabled });
  }

  function confirm() {
    if (!eligible || !confirmation || confirmationStale || !platform) return;
    const entry: SubmissionLock = { platform, assessmentIds: new Set(assessments.map((assessment) => assessment.id)), outcome: 'submitting' };
    submissionLocks.set(idea.id, entry);
    updateLock((version) => version + 1);
    setConfirmation(null);
    void action.run(async () => {
      try {
        await request<unknown>(`/ideas/${idea.id}/assessments`, { method: 'POST', body: {} });
        entry.platform = latestPlatform.current?.ideaId === idea.id ? latestPlatform.current : platform;
        entry.outcome = 'accepted';
      } catch (error) {
        entry.platform = latestPlatform.current?.ideaId === idea.id ? latestPlatform.current : platform;
        if (error instanceof ApiError && error.status === 404) entry.outcome = 'route_missing';
        else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== 'OPERATION_UNKNOWN' && error.code !== 'INVALID_RESPONSE') submissionLocks.delete(idea.id);
        else if (error instanceof ApiError && error.code === 'INTEGRATION_NOT_CONFIGURED') submissionLocks.delete(idea.id);
        else entry.outcome = 'unknown';
        updateLock((version) => version + 1);
        throw error;
      }
      updateLock((version) => version + 1);
      await state.reload();
    }, '服务器已接收判断请求；是否完成、是否失败及是否建任务，以上方刷新后的平台记录为准。');
  }

  return <Card className="panel stack" role="region" aria-labelledby={`${id}-heading`}>
    <header className="panel-header">
      <div><h2 id={`${id}-heading`}>AI 判断与人工待审</h2><p className="muted">AI 仅提供建议，不自动合并、批准、立项、分配或启动 agent。</p></div>
      <Badge variant="outline">{platform ? `${assessments.length} 条判断记录` : '记录尚不可用'}</Badge>
    </header>
    {state.platformError && <p className="notice danger" role="alert">平台读取：{state.platformError}</p>}
    {state.integrationsError && <p className="notice danger" role="alert">集成读取：{state.integrationsError}</p>}
    {aiConfigured && <p className="notice">AI 仅确认本地配置完整，尚不证明远端连接、模型额度或调用可用；失败详情以实际判断记录为准。</p>}
    {disabledReasons.length > 0 && <ul className="notice" aria-label="AI 判断请求限制">{disabledReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    <div className="actions">
      <Button type="button" variant="outline" disabled={state.loading || action.busy} onClick={() => void state.reload()}>刷新 AI 与平台记录</Button>
      <Button type="button" disabled={!eligible || confirmation !== null} onClick={prepare}>{assessments.length ? '手动重新请求 AI 判断' : '手动请求 AI 判断'}</Button>
    </div>
    <ActionFeedback error={action.error} success={action.success} />
    <section className="stack" aria-label="AI 判断历史">
      <h3>判断历史（新到旧）</h3>
      {!platform ? <p className="muted">尚未成功读取平台历史；这不等于没有判断记录。</p>
        : assessments.length === 0 ? <p className="muted">服务器历史中暂无 AI 判断，不代表模型失败。</p>
          : assessments.map((assessment) => <AssessmentRecord key={assessment.id} assessment={assessment} />)}
    </section>
    <section className="stack" aria-label="实际工作台待审任务">
      <h3>工作台待审任务（平台快照）</h3>
      {reviewTask ? <div className="record stack">
        <dl>
          <dt>任务</dt><dd>{reviewTask.identifier || '未提供编号'} · {reviewTask.issueId || '尚无已确认远端 ID'}</dd>
          <dt>实际状态</dt><dd>{reviewTask.remoteStatus || '未同步，状态未知'}</dd>
          <dt>实际 assignee</dt><dd>{reviewTask.assigneeAgentId || '快照未记录 assignee'}</dd>
          <dt>最近同步</dt><dd>{reviewTask.syncedAt || '尚无同步时间'}</dd>
        </dl>
        <p className={reviewTask.remoteStatus === 'backlog' && !reviewTask.assigneeAgentId && !!reviewTask.syncedAt ? 'notice positive' : 'notice'}>
          {reviewTask.remoteStatus === 'backlog' && !reviewTask.assigneeAgentId && !!reviewTask.syncedAt
            ? '最近平台快照为 backlog、未分配；这里只描述该次同步，不代表实时状态。'
            : '创建时预期为 backlog、未分配；当前快照存在差异或尚未同步，请核对实际状态。不会自动更正、分配或启动。'}
        </p>
        {reviewTask.operations.map((operation) => <article className="record" key={operation.id}>
          <p>{operation.kind} · {operationLabels[operation.state]} · 尝试 {operation.attempt}</p>
          <p className="id-text">作业：{operation.id} · 远端 ID：{operation.remoteId || '尚未确认'}</p>
          {operation.error && <p className="notice danger">{operation.error}</p>}
        </article>)}
      </div> : <p className="muted">{platform ? '平台未记录工作台待审任务；AI 完成并不意味着已创建任务。' : '平台接口不可用，无法确认是否存在待审任务。'}</p>}
    </section>
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !action.busy) setConfirmation(null); }}>
      {confirmation && <AlertDialogContent className="review-confirmation">
        <AlertDialogHeader>
          <AlertDialogTitle>确认手动请求 AI 判断</AlertDialogTitle>
          <AlertDialogDescription>将把允许的模拟投稿发送给部署配置的模型。模型建议不等于人工范围或批准。</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="stack review-confirmation-scroll">
          <p>创意：{confirmation.title}</p>
          <p>{confirmation.createsReviewTask
            ? 'Multica 写入已开启：若判断为 create_task，服务器可能在工作台创建一个 backlog、无 assignee 的待审任务（已有任务不重复建）。请明确确认这一平台写入后果。不会因此立项、分配或启动。'
            : 'Multica 写入开关关闭：本次请求不会授权创建待审任务；模型仅提供建议。'}</p>
          {confirmationStale && <p className="notice danger" role="alert">服务器详情、判断历史或配置已变化，此确认已失效。请取消并重新核对。</p>}
          {!eligible && <p className="notice">当前请求条件不再满足，不能确认提交。</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={action.busy}>取消</AlertDialogCancel>
          <Button type="button" disabled={!eligible || confirmationStale} onClick={confirm}>确认请求判断</Button>
        </AlertDialogFooter>
      </AlertDialogContent>}
    </AlertDialog>
  </Card>;
}
