import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  AgentListDto,
  AgentOptionDto,
  DevTaskReadinessDto,
  ExecutionDto,
  IdeaDetailDto,
  MeDto,
  PlatformOperationDto,
  PlatformOperationKind,
  PlatformTaskDto,
  ReadinessCheckDto,
  ReconcileResultDto,
} from '@workbench/contracts';
import { ApiError, errorMessage, request } from './api';
import { ActionFeedback, useAction } from './useAction';
import type { PlatformState } from './usePlatform';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ExecutionPanelProps {
  idea: IdeaDetailDto;
  identity: MeDto | null;
  canWrite: boolean;
  state: PlatformState;
}

interface ReadResult<T> {
  key: string;
  data: T | null;
  loading: boolean;
  error: string;
  unavailable: boolean;
  receivedAt: number;
}

/** Every result belongs to one idea/product snapshot; late responses cannot re-enable writes. */
function usePlatformRead<T>(path: string | null, revision: string) {
  const key = `${path ?? ''}:${revision}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [result, setResult] = useState<ReadResult<T>>({ key: '', data: null, loading: false, error: '', unavailable: false, receivedAt: 0 });
  const refresh = useCallback(async (): Promise<T | null> => {
    controller.current?.abort();
    const attempt = ++sequence.current;
    if (!path) return null;
    const abort = new AbortController();
    controller.current = abort;
    setResult({ key, data: null, loading: true, error: '', unavailable: false, receivedAt: 0 });
    try {
      const data = await request<T>(path, { signal: abort.signal });
      if (abort.signal.aborted || sequence.current !== attempt || currentKey.current !== key) return null;
      setResult({ key, data, loading: false, error: '', unavailable: false, receivedAt: Date.now() });
      return data;
    } catch (cause) {
      if (abort.signal.aborted || sequence.current !== attempt || currentKey.current !== key) return null;
      const unavailable = cause instanceof ApiError && cause.status === 404;
      setResult({ key, data: null, loading: false, error: unavailable ? `接口 /api${path} 尚未实现或当前记录不可用（404），依赖此查询的操作已禁用。` : errorMessage(cause), unavailable, receivedAt: 0 });
      return null;
    }
  }, [key, path]);
  useEffect(() => {
    void refresh();
    return () => { ++sequence.current; controller.current?.abort(); };
  }, [refresh]);
  const visible = result.key === key ? result : { key, data: null, loading: Boolean(path), error: '', unavailable: false, receivedAt: 0 };
  return { ...visible, refresh };
}

function useFresh(receivedAt: number, serverTime?: string) {
  const [now, setNow] = useState(Date.now);
  const parsed = serverTime === undefined ? receivedAt : Date.parse(serverTime);
  const expiresAt = Math.min(receivedAt, Number.isFinite(parsed) ? parsed : 0) + 30_000;
  useEffect(() => {
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return receivedAt > 0 && now < expiresAt && Date.now() < expiresAt;
}

const operationLabels: Record<PlatformOperationKind, string> = {
  create_review_task: '创建工作台待审任务',
  create_product_project: '创建独立产品项目',
  create_dev_task: '创建开发任务',
  assign_agent: '分配 agent',
  launch: '授权启动',
};
const operationStates: Record<PlatformOperationDto['state'], string> = {
  pending: '待处理', running: '处理中', succeeded: '已确认成功', failed: '已确认失败', unknown: '结果不明，先对账',
};
const runLabels: Record<string, string> = {
  queued: '排队中', dispatched: '已派发', running: '运行中', waiting_local_directory: '等待本地目录',
  completed: '已完成', failed: '失败', cancelled: '已取消',
};
const outcomeLabels: Record<ReconcileResultDto['outcome'], string> = {
  found: '找到远端记录并已关联；不重复创建或启动。',
  absent: '已确认远端未写入；核对最新状态后，才可另行人工确认原操作。',
  ambiguous: '无法唯一确定远端结果，须人工处理；不能重试或重建。',
};

function CheckList({ checks }: { checks: ReadinessCheckDto[] }) {
  return checks.length > 0 ? <ul className="muted">{checks.map((check, index) => <li key={`${check.key}-${index}`}><strong>{check.ok ? '已就绪' : '未就绪'}：</strong>{check.message}</li>)}</ul> : <p className="muted">服务端未返回检查明细。</p>;
}

function agentFailures(agent: AgentOptionDto) {
  return [
    ...(agent.archived ? ['agent 已归档'] : []),
    ...(!agent.runtimeId ? ['未绑定 runtime'] : []),
    ...(!agent.runtimeOnline ? ['runtime 不在线'] : []),
    ...(!agent.invocable ? ['部署身份无权调用此 agent'] : []),
    ...agent.checks.filter((check) => !check.ok).map((check) => check.message),
  ];
}

function TaskSnapshot({ task, empty }: { task: PlatformTaskDto | null; empty: string }) {
  if (!task) return <p className="muted">{empty}</p>;
  return <dl>
    <dt>远端任务</dt><dd>{task.identifier ?? task.issueId ?? '尚未确认创建'}</dd>
    <dt>已同步任务状态</dt><dd>{task.remoteStatus ?? '未取得远端状态'}</dd>
    <dt>已同步 assignee</dt><dd>{task.assigneeAgentId ?? '未分配'}</dd>
    <dt>同步时间</dt><dd>{task.syncedAt ?? '尚未同步，不作为远端确认'}</dd>
  </dl>;
}

type Command = { kind: 'create' } | { kind: 'assign'; agentId: string; agentName: string } | { kind: 'launch'; agentId: string } | { kind: 'reconcile'; operation: PlatformOperationDto };
interface Confirmation {
  command: Command;
  snapshot: string;
  scope: IdeaDetailDto['launch']['approvedScope'];
  productId: string | null;
  issueId: string | null;
  assignee: string | null;
  invalidated: boolean;
}
interface AwaitingRecord {
  before: Map<string, string>;
  kinds: PlatformOperationKind[];
  operationId?: string;
  uncertain: boolean;
  platformBefore: PlatformState['platform'];
}

// Keep uncertain writes locked when an operator switches ideas and comes back.
const pendingWrites = new Map<string, AwaitingRecord>();

export function ExecutionPanel(props: ExecutionPanelProps) {
  return <ExecutionFlow key={props.idea.id} {...props} />;
}

function ExecutionFlow({ idea, identity, canWrite, state }: ExecutionPanelProps) {
  const id = useId();
  const action = useAction();
  const platform = state.platform?.ideaId === idea.id ? state.platform : null;
  const product = platform?.product ?? null;
  const dispatcher = identity?.roles.includes('dispatcher') ?? false;
  const launcher = identity?.roles.includes('launcher') ?? false;
  const multica = state.integrations?.multica;
  const currentScope = idea.scopeVersions.find((scope) => scope.id === idea.currentScopeVersionId);
  const approved = idea.status === 'approved' && Boolean(idea.approvedScopeVersionId)
    && idea.currentScopeVersionId === idea.approvedScopeVersionId
    && currentScope?.status === 'approved' && idea.launch.launchable
    && idea.launch.approvedScope?.id === idea.approvedScopeVersionId;
  const productCurrent = Boolean(product && product.scopeStillApproved && product.scopeVersionId === idea.approvedScopeVersionId);
  const selectionKey = `${idea.id}:${idea.currentScopeVersionId}:${idea.approvedScopeVersionId}:${idea.status}:${product?.id ?? ''}:${product?.scopeVersionId ?? ''}:${product?.scopeStillApproved ?? ''}:${product?.projectId ?? ''}:${product?.devTask.issueId ?? ''}:${product?.devTask.assigneeAgentId ?? ''}`;
  const [selection, setSelection] = useState({ key: selectionKey, agentId: '' });
  const selectedAgentId = selection.key === selectionKey ? selection.agentId : '';
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [awaiting, setAwaitingState] = useState<AwaitingRecord | null>(() => pendingWrites.get(idea.id) ?? null);
  const setAwaiting = useCallback((next: AwaitingRecord | null) => {
    if (next) pendingWrites.set(idea.id, next);
    else pendingWrites.delete(idea.id);
    setAwaitingState(next);
  }, [idea.id]);
  const [rejectedApproval, setRejectedApproval] = useState<IdeaDetailDto | null>(null);
  const [missingWrites, setMissingWrites] = useState<Command['kind'][]>([]);
  const [reconciliations, setReconciliations] = useState<Record<string, ReconcileResultDto>>({});
  const [refreshError, setRefreshError] = useState('');
  const mounted = useRef(true);
  const writeController = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; writeController.current?.abort(); };
  }, []);

  const revision = useMemo(() => JSON.stringify({
    idea: [idea.id, idea.updatedAt, idea.status, idea.currentScopeVersionId, idea.approvedScopeVersionId],
    product, reviewTask: platform?.reviewTask, actor: identity?.actor, roles: identity?.roles,
    loading: state.loading, canWrite,
  }), [idea.id, idea.updatedAt, idea.status, idea.currentScopeVersionId, idea.approvedScopeVersionId, product, platform?.reviewTask, identity?.actor, identity?.roles, state.loading, canWrite]);
  const agents = usePlatformRead<AgentListDto>(dispatcher ? '/agents' : null, `${identity?.actor ?? ''}:${selectionKey}`);
  const execution = usePlatformRead<ExecutionDto>(identity && product ? `/products/${product.id}/execution` : null, revision);
  const readiness = usePlatformRead<DevTaskReadinessDto>(launcher && product ? `/products/${product.id}/launch-readiness` : null, revision);
  const agentsFresh = useFresh(agents.receivedAt, agents.data?.fetchedAt);
  const executionFresh = useFresh(execution.receivedAt, execution.data?.syncedAt);
  const readinessFresh = useFresh(readiness.receivedAt);
  const selectedAgent = agents.data?.items.find((agent) => agent.id === selectedAgentId);
  const operations = useMemo(() => {
    const byId = new Map<string, PlatformOperationDto>();
    for (const operation of [...(platform?.reviewTask?.operations ?? []), ...(product?.devTask.operations ?? [])]) byId.set(operation.id, operation);
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [platform?.reviewTask?.operations, product?.devTask.operations]);
  const blockingOperations = operations.filter((operation) => ['unknown', 'pending', 'running'].includes(operation.state));
  const ambiguous = operations.some((operation) => operation.state === 'unknown' && reconciliations[operation.id]?.outcome === 'ambiguous');
  const platformReady = Boolean(platform && !state.loading && !state.unavailable && !state.platformError && !state.integrationsError);
  const configured = multica?.state === 'configured' && multica.checks.every((check) => check.ok);
  const common = canWrite && platformReady && configured && !action.busy;
  const writeReady = common && Boolean(multica?.writesEnabled) && approved && rejectedApproval !== idea && blockingOperations.length === 0 && !ambiguous && !awaiting;
  const actual = execution.data;
  const taskConfirmed = Boolean(product?.devTask.issueId && actual && executionFresh && actual.issueId === product.devTask.issueId && actual.syncedAt && actual.remoteStatus === 'backlog');
  const assigneeConfirmed = Boolean(taskConfirmed && actual?.assigneeAgentId && product?.devTask.syncedAt && product.devTask.assigneeAgentId === actual.assigneeAgentId);
  const activeRun = actual?.runs.some((run) => !['completed', 'failed', 'cancelled'].includes(run.status)) ?? false;
  const incomplete = !product || !product.projectId || !product.devTask.issueId;
  const canCreate = writeReady && dispatcher && (!product || productCurrent) && incomplete && !missingWrites.includes('create');
  const canAssign = writeReady && dispatcher && productCurrent && Boolean(product?.projectId) && taskConfirmed && !activeRun
    && agentsFresh && Boolean(selectedAgent && agentFailures(selectedAgent).length === 0) && !missingWrites.includes('assign');
  const canLaunch = writeReady && launcher && Boolean(multica?.executionEnabled) && productCurrent && Boolean(product?.projectId)
    && assigneeConfirmed && !activeRun && readinessFresh && Boolean(readiness.data?.launchable && readiness.data.checks.every((check) => check.ok)) && !missingWrites.includes('launch');
  const canReconcile = common && dispatcher && !awaiting && !missingWrites.includes('reconcile');
  const snapshot = useMemo(() => JSON.stringify({
    idea: [idea.id, idea.updatedAt, idea.status, idea.currentScopeVersionId, idea.approvedScopeVersionId],
    platform, multica, actor: identity?.actor, roles: identity?.roles,
    actual: actual && { issueId: actual.issueId, assignee: actual.assigneeAgentId, status: actual.remoteStatus, runs: actual.runs },
    selection: selectedAgentId,
  }), [idea.id, idea.updatedAt, idea.status, idea.currentScopeVersionId, idea.approvedScopeVersionId, platform, multica, identity?.actor, identity?.roles, actual, selectedAgentId]);
  const confirmationInvalidated = Boolean(confirmation && (confirmation.invalidated || confirmation.snapshot !== snapshot || !canWrite || !platformReady));
  const latest = useRef({ snapshot, canCreate, canAssign, canLaunch, canReconcile, operations, product, canWrite, selectedAgentId, confirmationInvalidated });
  latest.current = { snapshot, canCreate, canAssign, canLaunch, canReconcile, operations, product, canWrite, selectedAgentId, confirmationInvalidated };

  useEffect(() => {
    setSelection((previous) => previous.key === selectionKey ? previous : { key: selectionKey, agentId: '' });
  }, [selectionKey]);
  useEffect(() => {
    if (confirmation && !confirmation.invalidated && (confirmation.snapshot !== snapshot || !canWrite || !platformReady)) {
      setConfirmation({ ...confirmation, invalidated: true });
    }
  }, [confirmation, snapshot, canWrite, platformReady]);
  useEffect(() => {
    if (!awaiting || !platformReady || state.platform === awaiting.platformBefore) return;
    const observed = operations.some((operation) => (awaiting.operationId ? operation.id === awaiting.operationId : awaiting.kinds.includes(operation.kind))
      && awaiting.before.get(operation.id) !== JSON.stringify(operation));
    // A changed persisted operation is authoritative: unknown permits only reconciliation;
    // pending/running remain blocked by the operation gates, failed needs a new human decision.
    if (observed) setAwaiting(null);
  }, [awaiting, operations, platformReady, state.platform]);

  async function refreshAll() {
    setRefreshError('');
    const results = await Promise.allSettled([state.reload(), execution.refresh(), readiness.refresh(), dispatcher ? agents.refresh() : Promise.resolve(null)]);
    if (!mounted.current) return;
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') setRefreshError(errorMessage(rejected.reason));
  }

  function allowed(command: Command) {
    const value = latest.current;
    if (command.kind === 'create') return value.canCreate;
    if (command.kind === 'assign') return value.canAssign && command.agentId === value.selectedAgentId;
    if (command.kind === 'launch') return value.canLaunch;
    return value.canReconcile && value.operations.some((operation) => operation.id === command.operation.id && operation.state === 'unknown');
  }

  function prepare(command: Command) {
    if (!allowed(command)) return;
    setConfirmation({ command, snapshot, scope: idea.launch.approvedScope, productId: product?.id ?? null, issueId: product?.devTask.issueId ?? null, assignee: actual?.assigneeAgentId ?? null, invalidated: false });
  }

  function confirm() {
    const captured = confirmation;
    if (!captured || captured.invalidated || captured.snapshot !== latest.current.snapshot || !allowed(captured.command)) return;
    void action.run(async () => {
      const abort = new AbortController();
      writeController.current = abort;
      const command = captured.command;
      const before = new Map(operations.map((operation) => [operation.id, JSON.stringify(operation)]));
      const kinds: PlatformOperationKind[] = command.kind === 'create' ? ['create_product_project', 'create_dev_task']
        : command.kind === 'assign' ? ['assign_agent'] : command.kind === 'launch' ? ['launch'] : [command.operation.kind];
      const hold: AwaitingRecord = { before, kinds, operationId: command.kind === 'reconcile' ? command.operation.id : undefined, uncertain: false, platformBefore: state.platform };
      let posted = false;
      try {
        if (command.kind === 'launch') {
          // Check immediately before the POST, not only when the confirmation opened.
          const [freshExecution, freshReadiness] = await Promise.all([
            request<ExecutionDto>(`/products/${captured.productId}/execution`, { signal: abort.signal }),
            request<DevTaskReadinessDto>(`/products/${captured.productId}/launch-readiness`, { signal: abort.signal }),
          ]);
          const sameTask = freshExecution.issueId === captured.issueId && freshExecution.assigneeAgentId === command.agentId
            && freshExecution.remoteStatus === 'backlog' && Date.now() - Date.parse(freshExecution.syncedAt) < 30_000
            && freshExecution.runs.every((run) => ['completed', 'failed', 'cancelled'].includes(run.status));
          if (!sameTask || !freshReadiness.launchable || freshReadiness.checks.some((check) => !check.ok)) {
            setConfirmation((previous) => previous ? { ...previous, invalidated: true } : null);
            throw new Error(`启动前实时核对未通过，未发送启动请求。${freshReadiness.checks.filter((check) => !check.ok).map((check) => check.message).join('；')}`);
          }
        }
        // useAction sets busy during preflight; compare the captured server/role snapshot,
        // not its own busy-derived button gate.
        if (!mounted.current || !latest.current.canWrite || latest.current.confirmationInvalidated || captured.snapshot !== latest.current.snapshot) throw new Error('批准范围、项目、分配或权限已变化，未发送请求；请刷新后重新确认。');
        const path = command.kind === 'create' ? `/ideas/${idea.id}/product`
          : command.kind === 'assign' ? `/products/${captured.productId}/assignment`
          : command.kind === 'launch' ? `/products/${captured.productId}/launch`
          : `/platform-operations/${command.operation.id}/reconcile`;
        const body = command.kind === 'create' ? { scopeVersionId: captured.scope?.id }
          : command.kind === 'reconcile' ? undefined : { agentId: command.agentId };
        setAwaiting({ ...hold, uncertain: true });
        posted = true;
        // The POST acknowledgement is not a project/task/run confirmation. Only
        // reconcile has a declared response DTO; all other results come from GETs.
        if (command.kind === 'reconcile') {
          const result = await request<ReconcileResultDto>(path, { method: 'POST', body, signal: abort.signal });
          if (mounted.current) setReconciliations((previous) => ({ ...previous, [command.operation.id]: result }));
          if (mounted.current) setAwaiting(null);
          else pendingWrites.delete(idea.id);
        } else {
          await request<unknown>(path, { method: 'POST', body, signal: abort.signal });
          if (mounted.current) setAwaiting(hold);
          else pendingWrites.set(idea.id, hold);
        }
        if (mounted.current) setConfirmation(null);
      } catch (cause) {
        if (posted && cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.code !== 'OPERATION_UNKNOWN' && cause.code !== 'INVALID_RESPONSE') {
          pendingWrites.delete(idea.id);
          if (mounted.current) setAwaiting(null);
        }
        if (mounted.current) {
          if (cause instanceof ApiError && cause.status === 404) {
            setMissingWrites((previous) => previous.includes(command.kind) ? previous : [...previous, command.kind]);
            throw new Error(posted ? '此写入接口尚未实现或目标已不可用（404）；操作已禁用，未确认任何远端变化。' : '启动前实时查询接口尚未实现或记录不可用（404）；启动已禁用，未发送启动请求。');
          }
          if (cause instanceof ApiError && ['STALE_SCOPE_VERSION', 'NOT_LAUNCHABLE'].includes(cause.code)) {
            setRejectedApproval(idea);
            setConfirmation((previous) => previous ? { ...previous, invalidated: true } : null);
          }
          if (posted && (!(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500 || cause.code === 'INVALID_RESPONSE' || cause.code === 'OPERATION_UNKNOWN')) {
            setAwaiting({ ...hold, uncertain: true });
          }
        }
        throw cause;
      } finally {
        if (mounted.current) await refreshAll();
      }
    }, '请求已收到响应；这不代表项目、任务或运行已创建成功。请以下方最新远端记录及平台作业为准。');
  }

  const confirmationStale = Boolean(confirmation && (confirmation.invalidated || confirmation.snapshot !== snapshot || !canWrite || !platformReady));
  const confirmationAllowed = Boolean(confirmation && !confirmationStale && allowed(confirmation.command));
  const title = confirmation?.command.kind === 'create' ? '确认按当前批准范围立项'
    : confirmation?.command.kind === 'assign' ? '确认人工分配 agent（不启动）'
    : confirmation?.command.kind === 'launch' ? '确认授权启动已分配任务' : '确认仅对账，不重试平台写入';

  return <Card className="panel" aria-labelledby={`${id}-heading`}>
    <div className="panel-header"><div><p className="eyebrow">人工决策与平台事实分开</p><h2 id={`${id}-heading`}>任务与执行</h2></div><Badge variant="secondary">立项 · 分配 · 启动分别确认</Badge></div>
    <p className="muted">AI 建待审任务不等于批准；批准不等于立项，分配不会启动。HTTP 202 仅代表请求受理，远端项目、任务与运行以实际同步记录为准。</p>
    <div className="actions"><Button type="button" variant="outline" disabled={action.busy || state.loading} onClick={() => void refreshAll()}>刷新平台、agent 与执行记录</Button></div>
    {state.loading && <p role="status" className="muted">正在读取配置与平台记录，写操作暂不可用…</p>}
    {state.integrationsError && <p role="alert" className="notice danger">集成配置读取失败：{state.integrationsError}</p>}
    {state.platformError && <p role="alert" className="notice danger">平台记录读取失败：{state.platformError}</p>}
    {state.unavailable && <p className="notice">平台查询接口尚未实现（404）；依赖平台记录的立项、分配、启动和对账均已禁用。</p>}
    {!platform && !state.loading && !state.platformError && !state.unavailable && <p className="notice">尚未取得此创意的平台记录；不能据此认定没有任务或运行，写入已禁用。</p>}
    {!canWrite && <p className="notice">当前身份、详情或实时连接尚未就绪；所有平台写操作暂停。请恢复连接并刷新后重新确认。</p>}
    {rejectedApproval === idea && <p className="notice danger" role="alert">服务器已拒绝此批准范围依据。请通过工作台刷新取得最新创意详情并重新人工审核；不能重复提交旧依据。</p>}
    {!multica && !state.loading && !state.integrationsError && <p className="notice">尚未取得 Multica 配置；相关写入与启动不可用。</p>}
    {multica && (!configured || !multica.writesEnabled || !multica.executionEnabled) && <div className="notice stack">
      <p>Multica 配置：{multica.state === 'configured' ? '本地配置完整，远端权限仍需实时核验' : multica.state === 'invalid' ? '配置无效' : '未配置'}；写入授权{multica.writesEnabled ? '已开启' : '未开启'}；启动授权{multica.executionEnabled ? '已开启' : '未开启'}。</p>
      {multica.checks.some((check) => !check.ok) && <CheckList checks={multica.checks.filter((check) => !check.ok)} />}
    </div>}
    {awaiting && <p className="notice danger" role="alert">{awaiting.uncertain ? '上次网络或服务器响应无法确认写入结果。' : '请求已受理，尚未观察到本次请求的新平台作业记录。'}已锁定重复写入；请刷新核实。只有权威记录确认结果后才能继续；unknown 作业只能由 dispatcher 对账，不能盲目重试。</p>}
    {blockingOperations.length > 0 && <p className="notice">存在{blockingOperations.some((operation) => operation.state === 'unknown') ? '结果不明' : '待处理或处理中'}的平台作业；立项、分配与启动已暂停。不会自动重建或重试。</p>}
    {missingWrites.length > 0 && <p className="notice">写入接口不可用（404）：{missingWrites.map((kind) => ({ create: '立项', assign: '分配', launch: '启动', reconcile: '对账' })[kind]).join('、')}。相关操作已禁用。</p>}
    {refreshError && <p className="notice danger" role="alert">刷新失败：{refreshError}</p>}
    <ActionFeedback error={action.error} success={action.success} />

    <ol className="phase-grid">
      <li><span className="phase-number">01</span><h3>AI 待审任务与当前批准</h3>
        <TaskSnapshot task={platform?.reviewTask ?? null} empty={platform ? '平台尚无工作台待审任务记录。' : '待审任务查询尚未可用。'} />
        {platform?.reviewTask && <small>以上是最近同步的真实状态，不推断仍为 backlog 或仍未分配。AI 创建时应为 backlog、无 assignee。</small>}
        <Badge variant={approved ? 'default' : 'secondary'}>{approved ? `当前范围 v${currentScope?.versionNo} 已人工批准` : '当前范围未获有效批准'}</Badge>
        <p className="muted">{approved ? `批准版本：${idea.approvedScopeVersionId}` : idea.launch.reason ?? '必须批准当前最新范围；旧版本批准不可沿用。'}</p>
      </li>
      <li><span className="phase-number">02</span><h3>独立产品立项</h3>
        {product ? <><dl><dt>立项记录</dt><dd>{product.id}</dd><dt>独立项目</dt><dd>{product.projectId ?? '尚未确认创建'}</dd><dt>交付目录</dt><dd>{product.repoPath}</dd><dt>依据范围</dt><dd>{product.scopeVersionId}</dd></dl><TaskSnapshot task={product.devTask} empty="暂无开发任务" />
          {!productCurrent && <p className="notice danger">立项范围不再是当前批准版本；不能沿用旧立项分配或启动。</p>}</> : <p className="muted">{platform ? '暂无独立产品立项记录。' : '尚无法确认是否已有立项。'}</p>}
        <small>dispatcher 仅为当前批准范围创建独立项目与未分配的 backlog 开发任务；不选 agent、不启动。</small>
        {!dispatcher && <small>需要 dispatcher 角色。</small>}
        {product && !incomplete && <small>项目及开发任务已有远端 ID，不重复立项。</small>}
        <Button type="button" variant="outline" disabled={!canCreate} onClick={() => prepare({ kind: 'create' })}>{product ? '确认补齐失败的立项缺项' : '创建独立项目与开发任务'}</Button>
      </li>
      <li><span className="phase-number">03</span><h3>人工选择并分配</h3>
        <p>最近实时确认的 assignee：{actual ? actual.assigneeAgentId ?? '未分配' : '尚未取得实时确认'}</p>
        {!dispatcher && <p className="muted">需要 dispatcher 角色才能查询 agent 与分配；不会为其他角色调用 agent 列表。</p>}
        {agents.loading && dispatcher && <p role="status" className="muted">正在实时查询 agent…</p>}
        {agents.error && <p role="alert" className="notice danger">agent 查询失败：{agents.error}</p>}
        {dispatcher && agents.data && agents.data.items.length === 0 && <p className="muted">部署身份未返回可见 agent。</p>}
        {dispatcher && agents.data && <small>agent 查询时间：{agents.data.fetchedAt}{!agentsFresh && '；已过期，请人工刷新，不自动重查。'}</small>}
        <label className="field" htmlFor={`${id}-agent`}>选择 agent（不默认选择）<select id={`${id}-agent`} value={selectedAgentId} disabled={!dispatcher || !canWrite || action.busy || !agentsFresh || !productCurrent} onChange={(event) => setSelection({ key: selectionKey, agentId: event.target.value })}>
          <option value="">由人工选择，不沿用已有 assignee</option>
          {agents.data?.items.map((agent) => <option value={agent.id} disabled={agentFailures(agent).length > 0} key={agent.id}>{agent.name}{agentFailures(agent).length > 0 ? '（未就绪）' : ''}</option>)}
        </select></label>
        {agents.data && <details><summary>全部 agent 与未就绪原因</summary><div className="stack">{agents.data.items.map((agent) => <article className="record stack" key={agent.id}><h4>{agent.name}</h4><p className="id-text">{agent.id} · runtime：{agent.runtimeName ?? agent.runtimeId ?? '未绑定'}</p>{agentFailures(agent).length > 0 ? <ul className="muted">{agentFailures(agent).map((failure, index) => <li key={index}>{failure}</li>)}</ul> : <p className="muted">未归档、runtime 在线、部署身份可调用；全部检查通过。</p>}<CheckList checks={agent.checks} /></article>)}</div></details>}
        {!taskConfirmed && <small>需实时确认此开发任务仍为 backlog；查询失败、过期或任务 ID 不一致均不能分配。</small>}
        {activeRun && <small>存在未结束或未知状态的运行，不允许再次分配或启动。</small>}
        <small>只设置所选 agent 为 assignee；开发任务保持 backlog，不会启动。</small>
        <Button type="button" variant="outline" disabled={!canAssign} onClick={() => selectedAgent && prepare({ kind: 'assign', agentId: selectedAgent.id, agentName: selectedAgent.name })}>查看并确认分配（不启动）</Button>
      </li>
      <li><span className="phase-number">04</span><h3>单独授权启动</h3>
        <p>启动对象：{assigneeConfirmed ? actual?.assigneeAgentId : '尚无与平台记录一致的实时 assignee'}</p>
        {!launcher && <p className="muted">需要 launcher 角色；与分配授权分开。</p>}
        {readiness.loading && launcher && <p role="status" className="muted">正在检查启动依赖…</p>}
        {readiness.error && <p className="notice danger" role="alert">启动就绪查询失败：{readiness.error}</p>}
        {readiness.data && <><Badge variant="secondary">{readiness.data.launchable ? '本次依赖查询允许启动' : '启动依赖未就绪'}</Badge><CheckList checks={readiness.data.checks} />{!readinessFresh && <small>依赖查询已过期，请刷新后重新确认。</small>}</>}
        {!readiness.data && !readiness.loading && !readiness.error && <p className="muted">尚无启动依赖查询结果。</p>}
        <small>须同时开启写入、启动授权，核验当前批准版本与实际 assignee；最终确认时再实时查询一次依赖和执行状态。</small>
        <Button type="button" disabled={!canLaunch} onClick={() => actual?.assigneeAgentId && prepare({ kind: 'launch', agentId: actual.assigneeAgentId })}>查看并单独确认启动</Button>
      </li>
    </ol>

    <section className="record stack" aria-labelledby={`${id}-execution`}><div className="panel-header"><h3 id={`${id}-execution`}>实际执行（独立只读查询）</h3><Badge variant="outline">不要求 dispatcher / launcher</Badge></div>
      {!product && <p className="muted">{platform ? '尚无产品立项，无法查询产品执行。' : '平台记录不可用，不能判断是否已有执行。'}</p>}
      {execution.loading && <p role="status" className="muted">正在实时查询任务与运行记录…</p>}
      {execution.error && <p className="notice danger" role="alert">执行查询失败：{execution.error} 不能据此显示为“没有运行”。</p>}
      {actual && <><dl><dt>远端任务 ID</dt><dd>{actual.issueId}</dd><dt>确认的远端任务状态</dt><dd>{actual.remoteStatus}</dd><dt>确认的实际 assignee</dt><dd>{actual.assigneeAgentId ?? '未分配'}</dd><dt>远端同步时间</dt><dd>{actual.syncedAt}</dd></dl>
        {!executionFresh && <p className="notice">实时查询已超过 30 秒；以上仅供查看，分配与启动已暂停，请刷新。</p>}
        <h4>运行记录（最新在前，与任务状态分开）</h4>
        {actual.runs.length === 0 ? <p className="muted">本次成功查询未返回运行记录；不推断任务已完成。</p> : <ol className="stack">{actual.runs.map((run, index) => <li className="record stack" key={run.id}><div className="inline-meta"><Badge variant="secondary">{index === 0 ? '最新运行 · ' : ''}{Object.prototype.hasOwnProperty.call(runLabels, run.status) ? runLabels[run.status] : `未知状态（${run.status}）`}</Badge><span>{run.id}</span></div><p className="muted">agent：{run.agentId} · 原始状态：{run.status}</p><p className="muted">开始：{run.startedAt ?? '尚未开始或平台未提供'} · 结束：{run.completedAt ?? '尚无结束时间'}</p>{run.error && <p className="notice danger">运行失败信息：{run.error}</p>}</li>)}</ol>}
      </>}
    </section>

    <section className="record stack" aria-labelledby={`${id}-operations`}><h3 id={`${id}-operations`}>持久平台作业与对账</h3>
      {!platform ? <p className="muted">平台作业尚无法查询。</p> : operations.length === 0 ? <p className="muted">本次平台查询未返回作业记录。</p> : <ul className="stack">{operations.map((operation) => <li className="record stack" key={operation.id}>
        <div className="panel-header"><h4>{operationLabels[operation.kind]}</h4><Badge variant={operation.state === 'unknown' || operation.state === 'failed' ? 'destructive' : 'secondary'}>{operationStates[operation.state]}</Badge></div>
        <dl><dt>作业 ID</dt><dd>{operation.id}</dd><dt>发起人 / 次数</dt><dd>{operation.actor} / {operation.attempt}</dd><dt>已确认远端 ID</dt><dd>{operation.remoteId ?? '尚未确认'}</dd><dt>创建 / 更新时间</dt><dd>{operation.createdAt} / {operation.updatedAt}</dd></dl>
        {operation.error && <p className="notice danger">{operation.error}</p>}
        {reconciliations[operation.id] && <p className={reconciliations[operation.id]?.outcome === 'ambiguous' ? 'notice danger' : 'notice'}>对账结果：{outcomeLabels[reconciliations[operation.id]!.outcome]} 返回作业状态：{operationStates[reconciliations[operation.id]!.operation.state]}。</p>}
        {operation.state === 'unknown' && <><small>只允许 dispatcher 查询远端幂等记录；不重试原写入、不自动重建。{!dispatcher && '当前身份没有对账权限。'}</small><Button type="button" variant="outline" disabled={!canReconcile} onClick={() => prepare({ kind: 'reconcile', operation })}>人工核对未知作业</Button></>}
      </li>)}</ul>}
    </section>

    <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !action.busy) setConfirmation(null); }}>
      <AlertDialogContent className="confirmation-dialog">
        <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>本次确认绑定打开时的批准范围、产品与实际 assignee。实时状态或权限改变后，不自动切换目标；请取消并重新核对。</AlertDialogDescription></AlertDialogHeader>
        <div className="confirmation-scroll stack">
          <dl><dt>创意</dt><dd>{idea.title}</dd><dt>批准范围</dt><dd>{confirmation?.scope ? `v${confirmation.scope.versionNo} · ${confirmation.scope.id}` : '无当前有效批准'}</dd><dt>产品 / 开发任务</dt><dd>{confirmation?.productId ?? '此次申请创建独立项目'} / {confirmation?.issueId ?? '尚无已确认任务'}</dd><dt>打开时实际 assignee</dt><dd>{confirmation?.assignee ?? '未分配或尚未确认'}</dd></dl>
          {confirmation?.command.kind === 'create' && <><p className="notice">仅创建或补齐独立项目与 backlog 开发任务，不分配、不启动；不会将受理响应当作远端创建成功。</p><ol>{confirmation.scope?.features.map((feature, index) => <li key={index}><strong>{feature.title}</strong><p>{feature.acceptanceCriteria}</p></li>)}</ol><p>页面范围：{confirmation.scope?.pageScope}</p></>}
          {confirmation?.command.kind === 'assign' && <p className="notice">人工所选：{confirmation.command.agentName}（{confirmation.command.agentId}）。只分配，不启动。若已有 assignee，本操作将改为所选 agent。</p>}
          {confirmation?.command.kind === 'launch' && <p className="notice danger">将授权当前已分配 agent：{confirmation.command.agentId}。启动会使 backlog 任务进入 todo 并由平台排队运行；确认前将再次实时核验依赖。</p>}
          {confirmation?.command.kind === 'reconcile' && <p className="notice">仅对账作业 {confirmation.command.operation.id}（{operationLabels[confirmation.command.operation.kind]}），不会重试写入。找到、确认不存在、无法判断三个结果将分别展示。</p>}
          {confirmationStale && <p className="notice danger" role="alert">打开后服务端状态、权限或连接已变化，此确认已失效。请取消、刷新并重新确认。</p>}
          <ActionFeedback error={action.error} success="" />
        </div>
        <AlertDialogFooter><AlertDialogCancel disabled={action.busy}>取消确认</AlertDialogCancel><Button type="button" disabled={!confirmationAllowed || action.busy} onClick={confirm}>{action.busy ? '核对并提交中…' : title}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
