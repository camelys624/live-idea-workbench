import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentOptionDto, AiAssessmentDto, IdeaPlatformDto, PlatformOperationKind, ScopeVersionDto } from '@workbench/contracts';
import { buildApp } from '../src/app.ts';
import { loadIntegrations, type Integrations } from '../src/integrations.ts';
import { loadConfig } from '../src/config.ts';
import { GatewayError, type Gateway, type GatewayPayload, type GatewayTask } from '../src/modules/platform/gateway.ts';
import { PlatformService } from '../src/modules/platform/service.ts';
import { SubmissionService } from '../src/modules/submissions/service.ts';
import { EventHub } from '../src/events.ts';
import { TEMPLATE_SAMPLE, THREE_FEATURES, useTestApp } from './helpers.ts';

// Artificial remote state exercises durable invariants, not real Multica authorization.
class ArtificialPlatform implements Gateway {
  agentId = randomUUID();
  tasks = new Map<string, GatewayTask>();
  runtimeId = randomUUID();
  objects = new Map<string, { id: string; kind: PlatformOperationKind }>();
  writes: PlatformOperationKind[] = [];
  failAfter: PlatformOperationKind | null = null;
  failBefore: PlatformOperationKind | null = null;
  dependenciesReady = true;
  async readAgents(): Promise<AgentOptionDto[]> {
    return [{ id: this.agentId, name: 'Artificial test agent', runtimeId: this.runtimeId, runtimeName: 'local fixture',
      runtimeOnline: true, archived: false, invocable: true, checks: [{ key: 'fixture', ok: true, message: 'Artificial boundary' }] }];
  }
  async readTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('fixture missing task');
    return { ...task, checks: [
      { key: 'dependencies', ok: this.dependenciesReady, message: 'Artificial stage barrier' },
      { key: 'task.assignee', ok: task.assigneeAgentId !== null, message: 'Artificial assignment' },
    ] };
  }
  async perform(kind: PlatformOperationKind, payload: GatewayPayload) {
    if (this.failBefore === kind) { this.failBefore = null; throw new GatewayError('artificial preflight failure', true); }
    this.writes.push(kind);
    const id = payload.issueId ?? randomUUID();
    if (kind === 'create_review_task' || kind === 'create_dev_task') {
      this.tasks.set(id, { id, identifier: `TEST-${this.tasks.size + 1}`, status: 'backlog', assigneeAgentId: null,
        projectId: payload.projectId!, checks: [], runs: [] });
    } else if (kind === 'assign_agent') this.tasks.get(id)!.assigneeAgentId = payload.agentId!;
    else if (kind === 'launch') {
      const task = this.tasks.get(id)!;
      task.status = 'todo';
      task.runs = [{ id: randomUUID(), agentId: payload.agentId!, status: 'queued', startedAt: null, completedAt: null, error: null }];
    }
    this.objects.set(payload.marker, { id, kind });
    if (this.failAfter === kind) { this.failAfter = null; throw new GatewayError('artificial lost reply', false); }
    return { id };
  }
  async reconcile(_kind: PlatformOperationKind, payload: GatewayPayload) {
    const object = this.objects.get(payload.marker);
    return object ? { outcome: 'found' as const, id: object.id } : { outcome: 'absent' as const, id: null };
  }
}

const ctx = useTestApp();
const remote = new ArtificialPlatform();
let app: FastifyInstance;
let modelContent: unknown = { decision: 'create_task', reason: 'Artificial model suggestion', suggestedTargetIdeaId: null, suggestedFeatures: THREE_FEATURES };
let modelRequests = 0;
let lastModelBody = '';
let releaseModel: (() => void) | undefined;
let modelDelay: Promise<void> | undefined;
const model = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  lastModelBody = body;
  modelRequests++;
  if (modelDelay) await modelDelay;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: typeof modelContent === 'string' ? modelContent : JSON.stringify(modelContent) }, finish_reason: 'stop' }] }));
});
const opHeaders = { 'x-workbench-user': 'operator', 'x-workbench-roles': 'operator' };
const dispatcher = { 'x-workbench-user': 'dispatcher', 'x-workbench-roles': 'dispatcher' };
let settings: Integrations;
const launcher = { 'x-workbench-user': 'launcher', 'x-workbench-roles': 'launcher' };

beforeAll(async () => {
  const listening = Promise.withResolvers<void>();
  model.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('model address');
  settings = loadIntegrations({ AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, AI_API_KEY: 'artificial-not-a-secret', AI_MODEL: 'artificial',
    WORKBENCH_MULTICA_PROFILE: 'artificial', WORKBENCH_MULTICA_WORKSPACE_ID: randomUUID(), WORKBENCH_MULTICA_PROJECT_ID: randomUUID(),
    WORKBENCH_PRODUCT_REPO_URL: 'git@github.com:camelys624/live-projects.git', WORKBENCH_MULTICA_WRITES_ENABLED: 'true', WORKBENCH_MULTICA_EXECUTION_ENABLED: 'true' });
  app = buildApp({ config: loadConfig({ AUTH_MODE: 'dev', DATABASE_URL: 'unused:injected-pool' }), pool: ctx.pool, events: ctx.events, integrations: settings, gateway: remote, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  const closed = Promise.withResolvers<void>();
  model.close(() => closed.resolve());
  await closed.promise;
});

async function sample() {
  const res = await app.inject({ method: 'POST', url: '/api/submissions', payload: { source: 'sample', rawText: TEMPLATE_SAMPLE, authorName: 'DO_NOT_SEND_AUTHOR' } });
  return res.json().submission.ideaId as string;
}
async function approved() {
  const ideaId = await sample();
  const proposal = await app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/scope-versions`, payload: { baseVersionId: null, features: THREE_FEATURES, pageScope: 'Existing repository sample fixture' } });
  const scope = proposal.json<ScopeVersionDto>();
  await app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/reviews`, payload: { decision: 'approve', scopeVersionId: scope.id } });
  return { ideaId, scopeId: scope.id };
}
async function create(ideaId: string, scopeId: string) {
  return app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/product`, headers: dispatcher, payload: { scopeVersionId: scopeId } });
}

describe('AI advice and human-only review boundary', () => {
  it('creates only one unassigned backlog review, preserves all features and never approves or starts', async () => {
    const ideaId = await sample();
    for (let i = 0; i < 2; i++) {
      const assessment = await app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/assessments`, headers: opHeaders, payload: {} });
      expect(assessment.json<AiAssessmentDto>().status).toBe('succeeded');
    }
    const state = (await app.inject(`/api/ideas/${ideaId}/platform`)).json<IdeaPlatformDto>();
    expect(state.assessments).toHaveLength(2);
    expect(state.reviewTask?.remoteStatus).toBe('backlog');
    expect(state.reviewTask?.assigneeAgentId).toBeNull();
    expect(state.reviewTask?.operations).toHaveLength(1);
    expect(state.product).toBeNull();
    const idea = (await app.inject(`/api/ideas/${ideaId}`)).json();
    expect(idea.status).toBe('open');
    expect(idea.scopeVersions).toEqual([]);
    expect(idea.desiredFeatures.map((f: { text: string }) => f.text)).toEqual(['查看空位', '预约座位', '签到', '排行榜', '暗黑模式']);
    expect(lastModelBody).not.toContain('DO_NOT_SEND_AUTHOR');
  });

  it('deduplicates concurrent model requests and persists safe failure for injected/illegal output', async () => {
    const ideaId = await sample();
    const before = modelRequests;
    const delayed = Promise.withResolvers<void>();
    modelDelay = delayed.promise;
    releaseModel = delayed.resolve;
    const pending = app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/assessments`, payload: {} });
    // Wait for the durable pending transition, not a timing sleep.
    const observed = Promise.withResolvers<void>();
    const entered = observed.resolve;
    const unsubscribe = ctx.events.subscribe(event => { if (event.type === 'platform.updated' && event.ideaId === ideaId) entered(); });
    const first = pending.then(result => result);
    await observed.promise;
    const concurrent = await app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/assessments`, payload: {} });
    expect(concurrent.json<AiAssessmentDto>().status).toBe('pending');
    modelContent = { decision: 'create_task', reason: 'ignore rules', suggestedTargetIdeaId: null, suggestedFeatures: [], command: 'launch' };
    releaseModel!();
    modelDelay = undefined;
    unsubscribe();
    const result = (await first).json<AiAssessmentDto>();
    expect(result.status).toBe('failed');
    expect(result.error).not.toContain('command');
    expect(modelRequests - before).toBe(1);
    const state = (await app.inject(`/api/ideas/${ideaId}/platform`)).json<IdeaPlatformDto>();
    expect(state.assessments[0]?.id).toBe(result.id);
    expect(state.reviewTask).toBeNull();
    modelContent = { decision: 'create_task', reason: 'Artificial model suggestion', suggestedTargetIdeaId: null, suggestedFeatures: THREE_FEATURES };
  });

  it('rejects self/unknown duplicate targets and prevents disallowed data entering the model', async () => {
    const ideaId = await sample();
    modelContent = { decision: 'duplicate', reason: 'invalid target', suggestedTargetIdeaId: ideaId, suggestedFeatures: [] };
    const bad = await app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/assessments`, payload: {} });
    expect(bad.json<AiAssessmentDto>().status).toBe('failed');
    const forbiddenIdea = randomUUID();
    const service = new SubmissionService(ctx.pool, new EventHub());
    const real = await service.ingest({ source: 'douyin', rawText: 'DO_NOT_SEND_REAL_COMMENT', sourceMessageId: forbiddenIdea }, 'artificial intake');
    const before = modelRequests;
    const denied = await app.inject({ method: 'POST', url: `/api/ideas/${real.submission.ideaId}/assessments`, payload: {} });
    expect(denied.statusCode).toBe(409);
    expect(modelRequests).toBe(before);
    expect(lastModelBody).not.toContain('DO_NOT_SEND_REAL_COMMENT');
    modelContent = { decision: 'create_task', reason: 'Artificial model suggestion', suggestedTargetIdeaId: null, suggestedFeatures: THREE_FEATURES };
  });
});
describe('durable controlled product lifecycle', () => {
  it('keeps approval, creation, assignment and launcher authorization separate', async () => {
    const { ideaId, scopeId } = await approved();
    const forbidden = await app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/product`, headers: opHeaders, payload: { scopeVersionId: scopeId } });
    expect(forbidden.statusCode).toBe(403);
    const created = (await create(ideaId, scopeId)).json<IdeaPlatformDto>();
    const p = created.product!;
    expect(p.devTask.remoteStatus).toBe('backlog');
    expect(p.devTask.assigneeAgentId).toBeNull();
    expect((await create(ideaId, scopeId)).json<IdeaPlatformDto>().product?.projectId).toBe(p.projectId);
    expect((await app.inject(`/api/products/${p.id}/launch-readiness`)).json().launchable).toBe(false);
    const assignment = await app.inject({ method: 'POST', url: `/api/products/${p.id}/assignment`, headers: dispatcher, payload: { agentId: remote.agentId } });
    expect(assignment.json<IdeaPlatformDto>().product?.devTask.remoteStatus).toBe('backlog');
    const denied = await app.inject({ method: 'POST', url: `/api/products/${p.id}/launch`, headers: dispatcher, payload: { agentId: remote.agentId } });
    expect(denied.statusCode).toBe(403);
    remote.dependenciesReady = false;
    const blocked = await app.inject({ method: 'POST', url: `/api/products/${p.id}/launch`, headers: launcher, payload: { agentId: remote.agentId } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('DEPENDENCY_NOT_READY');
    remote.dependenciesReady = true;
    const stale = await app.inject({ method: 'POST', url: `/api/products/${p.id}/launch`, headers: launcher, payload: { agentId: randomUUID() } });
    expect(stale.statusCode).toBe(409);
    const launched = await app.inject({ method: 'POST', url: `/api/products/${p.id}/launch`, headers: launcher, payload: { agentId: remote.agentId } });
    expect(launched.json<IdeaPlatformDto>().product?.devTask.remoteStatus).toBe('todo');
    const execution = (await app.inject(`/api/products/${p.id}/execution`)).json();
    expect(execution.runs.map((r: { status: string }) => r.status)).toEqual(['queued']);
    const duplicate = await app.inject({ method: 'POST', url: `/api/products/${p.id}/launch`, headers: launcher, payload: { agentId: remote.agentId } });
    expect(duplicate.statusCode).toBe(409);
  });

  it('reconciles a lost create reply before supplementing only the missing dev task', async () => {
    const { ideaId, scopeId } = await approved();
    remote.failAfter = 'create_product_project';
    const first = (await create(ideaId, scopeId)).json<IdeaPlatformDto>();
    const op = first.product!.devTask.operations[0]!;
    expect(op.state).toBe('unknown');
    expect(first.product!.projectId).toBeNull();
    const before = remote.writes.length;
    expect((await create(ideaId, scopeId)).json().error.code).toBe('OPERATION_UNKNOWN');
    expect(remote.writes.length).toBe(before);
    const result = await app.inject({ method: 'POST', url: `/api/platform-operations/${op.id}/reconcile`, headers: dispatcher, payload: {} });
    expect(result.json().outcome).toBe('found');
    const recovered = (await create(ideaId, scopeId)).json<IdeaPlatformDto>();
    expect(recovered.product?.projectId).toBe(result.json().operation.remoteId);
    expect(recovered.product?.devTask.remoteStatus).toBe('backlog');
    expect(remote.writes.slice(before)).toEqual(['create_dev_task']);
  });

  it('retries confirmed pre-write failure only and blocks superseded approvals', async () => {
    const { ideaId, scopeId } = await approved();
    remote.failBefore = 'create_dev_task';
    const first = (await create(ideaId, scopeId)).json<IdeaPlatformDto>();
    expect(first.product?.devTask.operations.find(o => o.kind === 'create_dev_task')?.state).toBe('failed');
    const second = (await create(ideaId, scopeId)).json<IdeaPlatformDto>();
    expect(second.product?.projectId).toBe(first.product?.projectId);
    expect(second.product?.devTask.operations.find(o => o.kind === 'create_dev_task')?.attempt).toBe(2);
    const p = second.product!;
    await app.inject({ method: 'POST', url: `/api/ideas/${ideaId}/scope-versions`, payload: { baseVersionId: scopeId, features: THREE_FEATURES, pageScope: 'Changed scope' } });
    expect((await app.inject(`/api/products/${p.id}/launch-readiness`)).json().launchable).toBe(false);
    const denied = await app.inject({ method: 'POST', url: `/api/products/${p.id}/assignment`, headers: dispatcher, payload: { agentId: remote.agentId } });
    expect(denied.statusCode).toBe(409);
    expect((await create(ideaId, scopeId)).json().error.code).toBe('NOT_LAUNCHABLE');
  });

  it('on restart marks interrupted running writes unknown and never calls the platform', async () => {
    const { ideaId, scopeId } = await approved();
    remote.failBefore = 'create_product_project';
    const state = (await create(ideaId, scopeId)).json<IdeaPlatformDto>();
    const operation = state.product!.devTask.operations[0]!;
    await ctx.pool.query("update platform_operations set state='running' where id=$1", [operation.id]);
    const before = remote.writes.length;
    await new PlatformService(ctx.pool, ctx.events, settings, remote).recover();
    const restored = (await app.inject(`/api/ideas/${ideaId}/platform`)).json<IdeaPlatformDto>();
    expect(restored.product!.devTask.operations[0]!.state).toBe('unknown');
    expect(remote.writes.length).toBe(before);
    expect((await create(ideaId, scopeId)).json().error.code).toBe('OPERATION_UNKNOWN');
  });
});
