import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  AgentListDto, DevTaskReadinessDto, ExecutionDto, IdeaPlatformDto, PlatformOperationDto,
  PlatformOperationKind, PlatformTaskDto, ProductLaunchDto, ReadinessCheckDto, ReconcileResultDto,
} from '@workbench/contracts';
import { withTx } from '../../db.ts';
import { AppError } from '../../errors.ts';
import type { EventHub } from '../../events.ts';
import type { Integrations } from '../../integrations.ts';
import { IdeaService } from '../ideas/service.ts';
import { CliGateway, GatewayError, type Gateway, type GatewayPayload } from './gateway.ts';

type OperationRow = {
  id: string; idea_id: string; product_id: string | null; kind: PlatformOperationKind;
  state: PlatformOperationDto['state']; actor: string; attempt: number; remote_id: string | null;
  error: string | null; payload: GatewayPayload; created_at: Date; updated_at: Date;
};
type ProductRow = {
  id: string; idea_id: string; scope_version_id: string; project_id: string | null;
  repo_path: string; task: PlatformTaskDto | null; launched_by: string; created_at: Date;
};
const emptyTask = (): PlatformTaskDto => ({ issueId: null, identifier: null, remoteStatus: null, assigneeAgentId: null, syncedAt: null, operations: [] });
const dto = (r: OperationRow): PlatformOperationDto => ({
  id: r.id, kind: r.kind, state: r.state, actor: r.actor, attempt: r.attempt,
  remoteId: r.remote_id, error: r.error, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});
const check = (key: string, ok: boolean, message: string): ReadinessCheckDto => ({ key, ok, message });

/** 单节点同步执行；外部写入前的 running 记录独立提交，崩溃后只能对账。 */
export class PlatformService {
  private readonly ideas: IdeaService;
  private readonly gateway: Gateway | null;
  private readonly pool: pg.Pool;
  private readonly events: EventHub;
  private readonly integrations: Integrations;
  constructor(pool: pg.Pool, events: EventHub, integrations: Integrations, gateway?: Gateway) {
    this.pool = pool;
    this.events = events;
    this.integrations = integrations;
    this.ideas = new IdeaService(pool, events);
    this.gateway = gateway ?? (integrations.multica ? new CliGateway(integrations.multica) : null);
  }

  async recover(): Promise<void> {
    await this.pool.query(`update platform_operations set state = case when state = 'running' then 'unknown' else 'failed' end,
      error = '服务中断；运行中的写入须先对账', updated_at = now() where state in ('pending','running')`);
  }

  private configured(write = false, launch = false): Gateway {
    if (!this.integrations.multica || !this.gateway) throw new AppError('INTEGRATION_NOT_CONFIGURED', '未配置独立 Multica 部署身份');
    if (write && !this.integrations.multica.writesEnabled) throw new AppError('PLATFORM_WRITES_DISABLED', '未开启平台写入授权');
    if (launch && !this.integrations.multica.executionEnabled) throw new AppError('EXECUTION_DISABLED', '未开启启动授权');
    return this.gateway;
  }

  private publish(ideaId: string) { this.events.publish([{ type: 'platform.updated', ideaId }]); }

  /** 会话锁串行化本创意的平台操作；创意行锁另用于防止写入期间审核版本改变。 */
  private async serialized<T>(ideaId: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 11911)) as locked', [ideaId]);
      if (!lock.rows[0]?.locked) throw new AppError('INVALID_STATE', '该创意的平台操作正在执行，请刷新后重试');
      try { return await fn(); }
      finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 11911))', [ideaId]); }
    } finally { client.release(); }
  }

  private async product(id: string): Promise<ProductRow> {
    const row = (await this.pool.query<ProductRow>('select * from products where id = $1', [id])).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '小产品不存在');
    return row;
  }

  async get(ideaId: string): Promise<IdeaPlatformDto> {
    const idea = await this.ideas.get(ideaId);
    const assessments = await this.pool.query<{ data: IdeaPlatformDto['assessments'][number] }>(
      'select data from ai_assessments where idea_id = $1 order by data->>\'createdAt\' desc, id desc', [ideaId]);
    const ops = (await this.pool.query<OperationRow>('select * from platform_operations where idea_id = $1 order by created_at, id', [ideaId])).rows;
    const review = (await this.pool.query<{ task: PlatformTaskDto }>('select task from review_tasks where idea_id = $1', [ideaId])).rows[0];
    const product = (await this.pool.query<ProductRow>('select * from products where idea_id = $1', [ideaId])).rows[0];
    const reviewOps = ops.filter(o => o.kind === 'create_review_task').map(dto);
    let productDto: ProductLaunchDto | null = null;
    if (product) productDto = {
      id: product.id, scopeVersionId: product.scope_version_id,
      scopeStillApproved: idea.status === 'approved' && idea.approvedScopeVersionId === product.scope_version_id && idea.currentScopeVersionId === product.scope_version_id,
      projectId: product.project_id, repoPath: product.repo_path,
      devTask: { ...(product.task ?? emptyTask()), operations: ops.filter(o => o.product_id === product.id).map(dto) },
      launchedBy: product.launched_by, createdAt: product.created_at.toISOString(),
    };
    return { ideaId, assessments: assessments.rows.map(r => r.data),
      reviewTask: review || reviewOps.length ? { ...(review?.task ?? emptyTask()), operations: reviewOps } : null, product: productDto };
  }

  private async assertAllowedData(ideaId: string, db: pg.Pool | pg.PoolClient = this.pool) {
    const result = await db.query('select 1 from submissions where idea_id = $1 and source = \'douyin\' limit 1', [ideaId]);
    if (result.rowCount) throw new AppError('FORBIDDEN', '真实抖音数据用途尚未获准，不能写入平台');
  }

  private async noUnknown(ideaId: string) {
    const result = await this.pool.query(`select 1 from platform_operations where idea_id = $1 and state in ('unknown','running','pending') limit 1`, [ideaId]);
    if (result.rowCount) throw new AppError('OPERATION_UNKNOWN', '存在结果不明或未完成的平台操作，须先对账');
  }

  private async operation(ideaId: string, productId: string | null, kind: PlatformOperationKind, actor: string, payload: Omit<GatewayPayload, 'marker'>): Promise<OperationRow> {
    let existing: OperationRow | undefined;
    if (kind.startsWith('create_')) existing = (await this.pool.query<OperationRow>(
      'select * from platform_operations where idea_id = $1 and kind = $2', [ideaId, kind])).rows[0];
    if (existing) {
      if (existing.state === 'succeeded') return existing;
      if (existing.state !== 'failed') throw new AppError('OPERATION_UNKNOWN', '上次操作结果不明，须先对账');
      return (await this.pool.query<OperationRow>(`update platform_operations set state='pending', attempt=attempt+1,
        actor=$2,error=null,updated_at=now() where id=$1 returning *`, [existing.id, actor])).rows[0]!;
    }
    const id = randomUUID();
    return (await this.pool.query<OperationRow>(`insert into platform_operations(id,idea_id,product_id,kind,state,actor,payload)
      values($1,$2,$3,$4,'pending',$5,$6) returning *`,
    [id, ideaId, productId, kind, actor, JSON.stringify({ ...payload, marker: `workbench-operation:${id}` })])).rows[0]!;
  }

  private async link(op: OperationRow, remoteId: string, db: pg.Pool | pg.PoolClient) {
    if (op.kind === 'create_product_project') {
      await db.query('update products set project_id=$2 where id=$1', [op.product_id, remoteId]);
    } else if (op.kind === 'create_review_task') {
      await db.query(`insert into review_tasks(idea_id,task) values($1,$2) on conflict(idea_id) do update set task=excluded.task`,
        [op.idea_id, JSON.stringify({ ...emptyTask(), issueId: remoteId })]);
    } else if (op.kind === 'create_dev_task') {
      await db.query('update products set task=$2 where id=$1', [op.product_id, JSON.stringify({ ...emptyTask(), issueId: remoteId })]);
    }
  }

  private async run(op: OperationRow, guard: (tx: pg.PoolClient) => Promise<void>): Promise<boolean> {
    if (op.state === 'succeeded') return true;
    const gateway = this.configured(true, op.kind === 'launch');
    // COMMIT before any external side effect; an interrupted call is never silently retried.
    await this.pool.query(`update platform_operations set state='running',updated_at=now() where id=$1`, [op.id]);
    this.publish(op.idea_id);
    let attempted = false;
    try {
      await withTx(this.pool, async tx => {
        await tx.query('select id from ideas where id=$1 for update', [op.idea_id]);
        await this.assertAllowedData(op.idea_id, tx);
        await guard(tx);
        attempted = true;
        const result = await gateway.perform(op.kind, op.payload);
        await this.link(op, result.id, tx);
        await tx.query(`update platform_operations set state='succeeded',remote_id=$2,error=null,updated_at=now() where id=$1`, [op.id, result.id]);
      });
      return true;
    } catch (error) {
      const known = !attempted || (error instanceof GatewayError && error.knownNotWritten);
      await this.pool.query(`update platform_operations set state=$2,error=$3,updated_at=now() where id=$1`,
        [op.id, known ? 'failed' : 'unknown', known ? '写入前检查失败；请核对配置、依赖和批准版本' : '平台写入结果不明；请先对账，禁止直接重试']);
      if (!attempted && error instanceof AppError) throw error;
      return false;
    } finally { this.publish(op.idea_id); }
  }

  private async approved(tx: pg.PoolClient, ideaId: string, scopeId: string) {
    const scope = await this.ideas.requireLaunchableScope(tx, ideaId);
    if (scope.id !== scopeId) throw new AppError('STALE_SCOPE_VERSION', '批准版本已变化');
  }

  async createReviewTask(ideaId: string, assessmentId: string): Promise<void> {
    // Assessment success remains useful while platform writes are not configured.
    if (!this.integrations.multica?.writesEnabled) return;
    await this.serialized(ideaId, async () => {
      await this.noUnknown(ideaId);
      const idea = await this.ideas.get(ideaId);
      if (idea.status === 'merged' || idea.status === 'rejected') return;
      await this.assertAllowedData(ideaId);
      const assessment = (await this.pool.query('select data from ai_assessments where id=$1 and idea_id=$2', [assessmentId, ideaId])).rows[0]?.data;
      if (assessment?.status !== 'succeeded' || assessment?.decision !== 'create_task') return;
      const op = await this.operation(ideaId, null, 'create_review_task', `system:ai-assessment:${assessmentId}`, {
        title: `待人工审核：${idea.title}`, projectId: this.integrations.multica!.workbenchProjectId,
        description: `人工/示例数据；不是实时抖音接通。\n创意 ${ideaId}\nAI 判断理由（不可信建议）：${assessment.reason}\n\n未批准、未分配、禁止启动。保留全部期望功能：\n${idea.desiredFeatures.map(f => f.text).join('\n')}`,
      });
      await this.run(op, async tx => {
        const current = await this.ideas.get(ideaId, tx);
        if (current.status === 'merged' || current.status === 'rejected') throw new AppError('INVALID_STATE', '创意已拒绝或合并');
      });
      await this.refreshTasks(ideaId);
    });
  }

  async createProduct(ideaId: string, scopeId: string, actor: string): Promise<IdeaPlatformDto> {
    this.configured(true);
    return this.serialized(ideaId, async () => {
      await this.noUnknown(ideaId);
      await this.assertAllowedData(ideaId);
      const p = await withTx(this.pool, async tx => {
        const scope = await this.ideas.requireLaunchableScope(tx, ideaId);
        if (scope.id !== scopeId) throw new AppError('STALE_SCOPE_VERSION', '批准版本已变化');
        const old = (await tx.query<ProductRow>('select * from products where idea_id=$1', [ideaId])).rows[0];
        if (old) {
          if (old.scope_version_id !== scopeId) throw new AppError('NOT_LAUNCHABLE', '该创意已有其他版本立项；禁止重复创建独立项目');
          return old;
        }
        const id = randomUUID();
        return (await tx.query<ProductRow>(`insert into products(id,idea_id,scope_version_id,repo_path,launched_by)
          values($1,$2,$3,$4,$5) returning *`, [id, ideaId, scopeId, `products/${ideaId}`, actor])).rows[0]!;
      });
      const idea = await this.ideas.get(ideaId);
      const scope = idea.scopeVersions.find(s => s.id === scopeId)!;
      const description = `人工/示例小产品；人工批准版本 ${scopeId}。\n交付仓库目录：${p.repo_path}\n页面范围：${scope.pageScope}\n风格：${scope.style ?? '未指定'}\n\n本次恰好三个功能及完成标准（只实现以下范围）：\n${scope.features.map((f, i) => `${i + 1}. ${f.title}\n完成标准：${f.acceptanceCriteria}`).join('\n')}\n\n全部期望功能（仅作背景，不扩大本次批准范围）：\n${idea.desiredFeatures.map(f => f.text).join('\n')}\n\n此任务在人工选择 agent、依赖就绪及单独确认启动前必须保持 backlog。`;
      const projectOp = await this.operation(ideaId, p.id, 'create_product_project', actor, { title: idea.title, description, repoPath: p.repo_path });
      if (!await this.run(projectOp, tx => this.approved(tx, ideaId, scopeId))) return this.get(ideaId);
      const latest = await this.product(p.id);
      const taskOp = await this.operation(ideaId, p.id, 'create_dev_task', actor,
        { title: idea.title, description, projectId: latest.project_id!, repoPath: p.repo_path });
      await this.run(taskOp, tx => this.approved(tx, ideaId, scopeId));
      await this.refreshTasks(ideaId);
      return this.get(ideaId);
    });
  }

  async agents(): Promise<AgentListDto> {
    return { items: await this.configured().readAgents(), fetchedAt: new Date().toISOString() };
  }

  private async refreshTasks(ideaId: string): Promise<void> {
    if (!this.gateway) return;
    const p = (await this.pool.query<ProductRow>('select * from products where idea_id=$1', [ideaId])).rows[0];
    const r = (await this.pool.query<{ task: PlatformTaskDto }>('select task from review_tasks where idea_id=$1', [ideaId])).rows[0];
    for (const [type, task] of [['product', p?.task], ['review', r?.task]] as const) {
      if (!task?.issueId) continue;
      try {
        const remote = await this.gateway.readTask(task.issueId);
        const expectedProject = type === 'product' ? p!.project_id : this.integrations.multica!.workbenchProjectId;
        if (remote.id !== task.issueId || remote.projectId !== expectedProject) continue;
        const snapshot: PlatformTaskDto = { issueId: remote.id, identifier: remote.identifier, remoteStatus: remote.status,
          assigneeAgentId: remote.assigneeAgentId, syncedAt: new Date().toISOString(), operations: [] };
        if (type === 'product') await this.pool.query('update products set task=$2 where id=$1', [p!.id, JSON.stringify(snapshot)]);
        else await this.pool.query('update review_tasks set task=$2 where idea_id=$1', [ideaId, JSON.stringify(snapshot)]);
      } catch { /* Keep the dated snapshot, never imply a failed read confirmed remote state. */ }
    }
    this.publish(ideaId);
  }

  private async checks(p: ProductRow, agentId?: string, launch = true): Promise<DevTaskReadinessDto> {
    const gateway = this.configured();
    const idea = await this.ideas.get(p.idea_id);
    const uncertain = (await this.pool.query(`select 1 from platform_operations where idea_id=$1 and state in ('unknown','pending','running')`, [p.idea_id])).rowCount !== 0;
    const checks = [
      check('writes', !!this.integrations.multica?.writesEnabled, '平台写入授权已开启'),
      check('scope', idea.status === 'approved' && idea.approvedScopeVersionId === p.scope_version_id && idea.currentScopeVersionId === p.scope_version_id, '立项依据仍为当前人工批准版本'),
      check('operations', !uncertain, '无结果不明或正在执行的平台操作'),
      check('task', !!p.task?.issueId && !!p.project_id, '独立项目和开发任务已关联'),
    ];
    if (launch) checks.push(check('execution', !!this.integrations.multica?.executionEnabled, '独立启动授权已开启'));
    if (p.task?.issueId) {
      const task = await gateway.readTask(p.task.issueId);
      checks.push(check('ownership', task.id === p.task.issueId && task.projectId === p.project_id, '远端任务仍属于本独立项目'),
        check('backlog', task.status === 'backlog', '远端任务仍为 backlog，未排队启动'),
        ...task.checks.filter(c => launch || c.key !== 'task.assignee'));
      const selected = agentId ?? task.assigneeAgentId;
      if (launch) checks.push(check('assignee', !!selected && task.assigneeAgentId === selected, '请求 agent 与远端已分配 agent 一致'));
      if (selected) {
        const agent = (await gateway.readAgents()).find(a => a.id === selected);
        checks.push(check('agent', !!agent && !agent.archived && !!agent.runtimeId && agent.runtimeOnline && agent.invocable && agent.checks.every(c => c.ok), '所选 agent 可调用且 runtime 在线'));
        if (agent) checks.push(...agent.checks);
      } else checks.push(check('agent', false, '尚未人工选择 agent'));
    }
    return { launchable: checks.every(c => c.ok), checks };
  }

  async readiness(id: string): Promise<DevTaskReadinessDto> { return this.checks(await this.product(id)); }

  async assign(id: string, agentId: string, actor: string): Promise<IdeaPlatformDto> {
    this.configured(true);
    const p = await this.product(id);
    return this.serialized(p.idea_id, async () => {
      await this.noUnknown(p.idea_id);
      const current = await this.product(id);
      const ready = await this.checks(current, agentId, false);
      if (!ready.launchable) throw new AppError('DEPENDENCY_NOT_READY', '分配前检查未通过', ready.checks);
      const op = await this.operation(p.idea_id, id, 'assign_agent', actor, { issueId: current.task!.issueId!, projectId: current.project_id!, agentId });
      await this.run(op, tx => this.approved(tx, p.idea_id, p.scope_version_id));
      await this.refreshTasks(p.idea_id);
      return this.get(p.idea_id);
    });
  }

  async launch(id: string, agentId: string, actor: string): Promise<IdeaPlatformDto> {
    this.configured(true, true);
    const p = await this.product(id);
    return this.serialized(p.idea_id, async () => {
      await this.noUnknown(p.idea_id);
      const current = await this.product(id);
      const ready = await this.checks(current, agentId);
      if (!ready.launchable) throw new AppError('DEPENDENCY_NOT_READY', '启动前检查未通过', ready.checks);
      const op = await this.operation(p.idea_id, id, 'launch', actor, { issueId: current.task!.issueId!, projectId: current.project_id!, agentId });
      await this.run(op, async tx => {
        await this.approved(tx, p.idea_id, p.scope_version_id);
        // Recheck assignee/status/dependencies immediately before the side effect, not from the browser snapshot.
        const task = await this.configured().readTask(current.task!.issueId!);
        if (task.status !== 'backlog' || task.assigneeAgentId !== agentId || task.projectId !== current.project_id || !task.checks.every(c => c.ok)) {
          throw new AppError('DEPENDENCY_NOT_READY', '远端分配、状态或依赖已变化');
        }
      });
      await this.refreshTasks(p.idea_id);
      return this.get(p.idea_id);
    });
  }

  async execution(id: string): Promise<ExecutionDto> {
    const p = await this.product(id);
    if (!p.task?.issueId) throw new AppError('DEPENDENCY_NOT_READY', '开发任务尚未关联');
    const task = await this.configured().readTask(p.task.issueId);
    if (task.id !== p.task.issueId || task.projectId !== p.project_id) throw new AppError('INVALID_STATE', '远端对象归属不匹配');
    await this.refreshTasks(p.idea_id);
    return { issueId: task.id, remoteStatus: task.status, assigneeAgentId: task.assigneeAgentId, runs: task.runs, syncedAt: new Date().toISOString() };
  }

  async reconcile(id: string): Promise<ReconcileResultDto> {
    const gateway = this.configured();
    const original = (await this.pool.query<OperationRow>('select * from platform_operations where id=$1', [id])).rows[0];
    if (!original) throw new AppError('NOT_FOUND', '平台作业不存在');
    return this.serialized(original.idea_id, async () => {
      const op = (await this.pool.query<OperationRow>('select * from platform_operations where id=$1', [id])).rows[0]!;
      if (op.state !== 'unknown') throw new AppError('INVALID_STATE', '仅结果不明的操作需要对账');
      const result = await gateway.reconcile(op.kind, op.payload);
      if (result.outcome === 'found' && !result.id) throw new AppError('INVALID_STATE', '对账未返回远端对象');
      if (result.outcome !== 'ambiguous') await withTx(this.pool, async tx => {
        if (result.outcome === 'found') await this.link(op, result.id!, tx);
        await tx.query(`update platform_operations set state=$2,remote_id=$3,error=$4,updated_at=now() where id=$1`,
          [id, result.outcome === 'found' ? 'succeeded' : 'failed', result.id, result.outcome === 'absent' ? '已确认远端未写入，可人工重试' : null]);
      });
      await this.refreshTasks(op.idea_id);
      const row = (await this.pool.query<OperationRow>('select * from platform_operations where id=$1', [id])).rows[0]!;
      this.publish(op.idea_id);
      return { operation: dto(row), outcome: result.outcome };
    });
  }
}
