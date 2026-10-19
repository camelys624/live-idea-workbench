// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { AgentListDto, ExecutionDto, IdeaDetailDto, IdeaPlatformDto, MeDto, PlatformOperationDto, ScopeVersionDto } from '@workbench/contracts';
import { ExecutionPanel } from './ExecutionPanel';
import type { PlatformState } from './usePlatform';

const agentId = '33333333-3333-4333-8333-333333333333';
const oldAgentId = '44444444-4444-4444-8444-444444444444';
const identity: MeDto = { actor: 'human', roles: ['dispatcher', 'launcher'] };
let fixtureNumber = 0;

interface ExecutionFixture {
  idea: IdeaDetailDto;
  platform: IdeaPlatformDto;
  execution: ExecutionDto;
  agents: AgentListDto;
  state: PlatformState;
}
type FetchMock = Mock<(url: RequestInfo | URL, options?: RequestInit) => Promise<Response>>;

function fixture(): ExecutionFixture {
  const ideaId = `11111111-1111-4111-8111-${String(++fixtureNumber).padStart(12, '0')}`;
  const timestamp = new Date().toISOString();
  const scope: ScopeVersionDto = {
    id: '22222222-2222-4222-8222-222222222222', ideaId, versionNo: 1,
    features: [{ title: '功能一', acceptanceCriteria: '标准一' }, { title: '功能二', acceptanceCriteria: '标准二' }, { title: '功能三', acceptanceCriteria: '标准三' }],
    pageScope: '首页', style: null, notes: null, status: 'approved', proposedBy: 'operator', createdAt: timestamp, statusChangedAt: timestamp,
  };
  const idea: IdeaDetailDto = {
    id: scope.ideaId, title: '小产品', status: 'approved', mergedIntoId: null, currentScopeVersionId: scope.id, approvedScopeVersionId: scope.id,
    submissionCount: 1, feedbackCount: 0, hasSimulatedSubmissions: true, createdAt: timestamp, updatedAt: timestamp,
    submissions: [], feedback: [], desiredFeatures: [], scopeVersions: [scope], reviews: [], mergesIn: [], mergeOut: null,
    launch: { launchable: true, approvedScope: scope, reason: null },
  };
  const platform: IdeaPlatformDto = {
    ideaId: idea.id, assessments: [], reviewTask: null,
    product: {
      id: 'product-1', scopeVersionId: scope.id, scopeStillApproved: true, projectId: 'project-1', repoPath: 'products/0001-product', launchedBy: 'human', createdAt: timestamp,
      devTask: { issueId: 'issue-1', identifier: 'DEV-1', remoteStatus: 'backlog', assigneeAgentId: oldAgentId, syncedAt: timestamp, operations: [] },
    },
  };
  const execution: ExecutionDto = { issueId: 'issue-1', remoteStatus: 'backlog', assigneeAgentId: oldAgentId, runs: [], syncedAt: timestamp };
  const agents: AgentListDto = {
    fetchedAt: timestamp,
    items: [{ id: agentId, name: '可用 agent', runtimeId: 'runtime-1', runtimeName: '在线 runtime', runtimeOnline: true, archived: false, invocable: true, checks: [{ key: 'permission', ok: true, message: '部署身份可调用' }] }],
  };
  const state: PlatformState = {
    integrations: {
      ai: { state: 'not_configured', provider: null, model: null, dataScope: 'simulated_only', checks: [] },
      multica: { state: 'configured', workspaceId: 'workspace', workbenchProjectId: 'workbench', productRepoUrl: 'git@example.test:products.git', writesEnabled: true, executionEnabled: true, checks: [] },
    },
    platform, integrationsError: '', platformError: '', unavailable: false, loading: false, reload: vi.fn().mockResolvedValue(undefined),
  };
  return { idea, platform, execution, agents, state };
}

function respond(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function installReads(data: ExecutionFixture, override?: (path: string, options?: RequestInit) => Response | undefined | Promise<Response | undefined>) {
  const fetch = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    const path = String(url);
    const custom = await override?.(path, options);
    if (custom) return custom;
    if (options?.method === 'POST') return respond({}, 202);
    if (path === '/api/agents') return respond(data.agents);
    if (path.endsWith('/execution')) return respond(data.execution);
    if (path.endsWith('/launch-readiness')) return respond({ launchable: true, checks: [{ key: 'ready', ok: true, message: '全部依赖就绪' }] });
    return respond({ error: { code: 'NOT_FOUND', message: '未实现' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function posts(fetch: FetchMock) {
  return fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
}

async function chooseAgent() {
  const select = screen.getByLabelText('选择 agent（不默认选择）') as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  expect(select.value).toBe('');
  fireEvent.change(select, { target: { value: agentId } });
  return select;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('explicit platform write boundaries', () => {
  it('never selects a prior assignee and confirms assignment without launching', async () => {
    const data = fixture();
    const fetch = installReads(data);
    render(<ExecutionPanel idea={data.idea} identity={identity} canWrite state={data.state} />);
    await chooseAgent();
    const assign = screen.getByRole('button', { name: '查看并确认分配（不启动）' });
    await waitFor(() => expect((assign as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(assign);
    expect(posts(fetch)).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认人工分配 agent（不启动）' }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(posts(fetch)[0]![0]).toBe('/api/products/product-1/assignment');
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ agentId });
    await waitFor(() => expect(data.state.reload).toHaveBeenCalledTimes(1));
    // A 202 without a newly confirmed operation must not permit a duplicate write.
    await waitFor(() => expect(screen.getByText(/已锁定重复写入/)).toBeDefined());
    expect(posts(fetch).some(([path]) => String(path).endsWith('/launch'))).toBe(false);
  });

  it('keeps an uncertain assignment locked after switching away and remounting the same idea', async () => {
    const data = fixture();
    const fetch = installReads(data, (_path, options) => {
      if (options?.method === 'POST') throw new TypeError('connection lost after sending');
      return undefined;
    });
    const view = render(<ExecutionPanel idea={data.idea} identity={identity} canWrite state={data.state} />);
    await chooseAgent();
    const assign = screen.getByRole('button', { name: '查看并确认分配（不启动）' });
    await waitFor(() => expect((assign as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(assign);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认人工分配 agent（不启动）' }));
    await waitFor(() => expect(screen.getByText(/上次网络或服务器响应无法确认写入结果/)).toBeDefined());
    view.unmount();
    render(<ExecutionPanel idea={data.idea} identity={identity} canWrite state={data.state} />);
    await chooseAgent();
    expect((screen.getByRole('button', { name: '查看并确认分配（不启动）' }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts(fetch)).toHaveLength(1);
  });

  it('invalidates an opened creation confirmation when approval becomes stale', async () => {
    const data = fixture();
    data.platform.product = null;
    const fetch = installReads(data);
    const view = render(<ExecutionPanel idea={data.idea} identity={identity} canWrite state={data.state} />);
    fireEvent.click(screen.getByRole('button', { name: '创建独立项目与开发任务' }));
    const changed: IdeaDetailDto = { ...data.idea, status: 'pending_review', currentScopeVersionId: 'new-scope', launch: { launchable: false, approvedScope: null, reason: '新范围待审' } };
    view.rerender(<ExecutionPanel idea={changed} identity={identity} canWrite state={data.state} />);
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认按当前批准范围立项' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(posts(fetch)).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消确认' }));
    expect((screen.getByRole('button', { name: '创建独立项目与开发任务' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears the chosen agent on approval changes and keeps disconnected confirmations invalid', async () => {
    const data = fixture();
    const fetch = installReads(data);
    const view = render(<ExecutionPanel idea={data.idea} identity={identity} canWrite state={data.state} />);
    await chooseAgent();
    const assign = screen.getByRole('button', { name: '查看并确认分配（不启动）' });
    await waitFor(() => expect((assign as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(assign);
    view.rerender(<ExecutionPanel idea={data.idea} identity={identity} canWrite={false} state={data.state} />);
    view.rerender(<ExecutionPanel idea={data.idea} identity={identity} canWrite state={data.state} />);
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认人工分配 agent（不启动）' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(posts(fetch)).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消确认' }));
    view.rerender(<ExecutionPanel idea={{ ...data.idea, approvedScopeVersionId: null, status: 'returned' }} identity={identity} canWrite state={data.state} />);
    expect((screen.getByLabelText('选择 agent（不默认选择）') as HTMLSelectElement).value).toBe('');
  });

  it('rechecks the actual assignee immediately before launcher-only authorization', async () => {
    const data = fixture();
    let executionReads = 0;
    const fetch = installReads(data, (path, options) => {
      if (path.endsWith('/execution') && options?.method !== 'POST') {
        executionReads += 1;
        return respond(executionReads === 1 ? data.execution : { ...data.execution, assigneeAgentId: agentId });
      }
    });
    render(<ExecutionPanel idea={data.idea} identity={{ actor: 'launcher', roles: ['launcher'] }} canWrite state={data.state} />);
    const launch = screen.getByRole('button', { name: '查看并单独确认启动' }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    expect(fetch.mock.calls.some(([path]) => path === '/api/agents')).toBe(false);
    fireEvent.click(launch);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认授权启动已分配任务' }));
    await waitFor(() => expect(screen.getAllByText(/启动前实时核对未通过/).length).toBeGreaterThan(0));
    expect(posts(fetch)).toHaveLength(0);
  });

  it('permits only dispatcher reconciliation for unknown operations and exposes ambiguous outcomes', async () => {
    const data = fixture();
    const operation: PlatformOperationDto = { id: 'operation-1', kind: 'assign_agent', state: 'unknown', actor: 'human', attempt: 1, remoteId: null, error: '平台超时', createdAt: data.idea.createdAt, updatedAt: data.idea.updatedAt };
    data.platform.product!.devTask.operations = [operation];
    const fetch = installReads(data, (path, options) => path.endsWith('/reconcile') && options?.method === 'POST' ? respond({ operation, outcome: 'ambiguous' }) : undefined);
    render(<ExecutionPanel idea={data.idea} identity={identity} canWrite state={data.state} />);
    await chooseAgent();
    expect((screen.getByRole('button', { name: '查看并确认分配（不启动）' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '查看并单独确认启动' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '人工核对未知作业' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认仅对账，不重试平台写入' }));
    await waitFor(() => expect(screen.getByText(/对账结果：无法唯一确定远端结果/)).toBeDefined());
    expect(posts(fetch).map(([path]) => path)).toEqual(['/api/platform-operations/operation-1/reconcile']);
  });

  it('does not turn execution 404 into an empty run list or allow dependent writes', async () => {
    const data = fixture();
    installReads(data, (path) => path.endsWith('/execution') ? respond({ error: { code: 'NOT_FOUND', message: '未实现' } }, 404) : undefined);
    render(<ExecutionPanel idea={data.idea} identity={identity} canWrite state={data.state} />);
    await chooseAgent();
    await waitFor(() => expect(screen.getByText(/执行查询失败：.*404/)).toBeDefined());
    expect((screen.getByRole('button', { name: '查看并确认分配（不启动）' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '查看并单独确认启动' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
