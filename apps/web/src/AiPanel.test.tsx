// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiAssessmentDto, IdeaDetailDto, IntegrationStatusDto, MeDto } from '@workbench/contracts';
import { AiPanel } from './AiPanel';
import type { PlatformState } from './usePlatform';

const identity: MeDto = { actor: 'operator-test', roles: ['operator'] };
const integrations: IntegrationStatusDto = {
  ai: { state: 'configured', provider: 'openai-compatible', model: 'test-model', dataScope: 'simulated_only', checks: [] },
  multica: { state: 'not_configured', workspaceId: null, workbenchProjectId: null, productRepoUrl: null, writesEnabled: false, executionEnabled: false, checks: [] },
};
let sequence = 0;
function fixture() {
  const id = `assessment-safety-${++sequence}`;
  const time = '2026-10-19T08:00:00Z';
  const idea: IdeaDetailDto = {
    id, title: '预约工具', status: 'open', mergedIntoId: null, currentScopeVersionId: null, approvedScopeVersionId: null,
    submissionCount: 1, feedbackCount: 0, hasSimulatedSubmissions: true, createdAt: time, updatedAt: time,
    submissions: [{
      id: `${id}-submission`, source: 'manual', isSimulated: true, sourceMessageId: null, authorName: null,
      rawText: '人工模拟投稿', receivedAt: time, parseStatus: 'unparsed',
      fields: { title: null, targetUsers: null, problem: null, desiredFeatures: [], viewerPriorities: [], pageScope: null, completionCriteria: null, style: null },
      missingFields: [], ideaId: id, relation: 'origin', createdBy: 'operator-test', createdAt: time, updatedAt: time,
    }],
    feedback: [], desiredFeatures: [], scopeVersions: [], reviews: [], mergesIn: [], mergeOut: null,
    launch: { launchable: false, approvedScope: null, reason: '待审核' },
  };
  const state: PlatformState = {
    integrations, integrationsError: '', platform: { ideaId: id, assessments: [], reviewTask: null, product: null },
    platformError: '', unavailable: false, loading: false, reload: vi.fn().mockResolvedValue(undefined),
  };
  return { idea, state };
}
function assessment(ideaId: string, status: AiAssessmentDto['status']): AiAssessmentDto {
  return {
    id: `${ideaId}-${status}`, ideaId, status, decision: status === 'succeeded' ? 'needs_info' : null,
    reason: status === 'succeeded' ? '需要补充演示目标' : null, suggestedTargetIdeaId: null, suggestedFeatures: [],
    model: 'test-model', error: status === 'failed' ? '提供商额度不足' : null, requestedBy: identity.actor,
    createdAt: '2026-10-19T08:00:00Z', completedAt: status === 'pending' ? null : '2026-10-19T08:01:00Z',
  };
}
function requestButton() { return screen.getByRole('button', { name: /手动.*请求 AI 判断/ }) as HTMLButtonElement; }
function confirmRequest() {
  fireEvent.click(requestButton());
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认请求判断' }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AI assessment write gates', () => {
  it('requires available platform GET, operator role, and safe origins including feedback', () => {
    const { idea, state } = fixture();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const view = render(<AiPanel idea={idea} identity={identity} canWrite state={{ ...state, platform: null, unavailable: true }} />);
    expect(requestButton().disabled).toBe(true);
    view.rerender(<AiPanel idea={idea} identity={{ actor: 'reviewer-test', roles: ['reviewer'] }} canWrite state={state} />);
    expect(requestButton().disabled).toBe(true);
    const feedback = { ...idea.submissions[0]!, id: 'unsafe-feedback', relation: 'feedback' as const, source: 'douyin' as const, isSimulated: false };
    view.rerender(<AiPanel idea={{ ...idea, feedback: [feedback] }} identity={identity} canWrite state={state} />);
    expect(requestButton().disabled).toBe(true);
    view.rerender(<AiPanel idea={idea} identity={identity} canWrite state={state} />);
    expect(requestButton().disabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains failed history on read error, permits manual retry only when fresh, and blocks pending assessments', () => {
    const { idea, state } = fixture();
    const failed = assessment(idea.id, 'failed');
    const withHistory: PlatformState = { ...state, platform: { ...state.platform!, assessments: [failed] } };
    const view = render(<AiPanel idea={idea} identity={identity} canWrite state={{ ...withHistory, platformError: '读取失败' }} />);
    expect(screen.getByText('模型错误：提供商额度不足')).toBeDefined();
    expect(requestButton().disabled).toBe(true);
    view.rerender(<AiPanel idea={idea} identity={identity} canWrite state={withHistory} />);
    expect(requestButton().disabled).toBe(false);
    view.rerender(<AiPanel idea={idea} identity={identity} canWrite state={{ ...withHistory, platform: { ...withHistory.platform!, assessments: [assessment(idea.id, 'pending'), failed] } }} />);
    expect(requestButton().disabled).toBe(true);
    expect(screen.getByText('模型错误：提供商额度不足')).toBeDefined();
  });

  it('invalidates captured confirmation when write authorization changes', () => {
    const { idea, state } = fixture();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const view = render(<AiPanel idea={idea} identity={identity} canWrite state={state} />);
    fireEvent.click(requestButton());
    const changed = { ...integrations, multica: { ...integrations.multica, state: 'configured' as const, writesEnabled: true } };
    view.rerender(<AiPanel idea={idea} identity={identity} canWrite state={{ ...state, integrations: changed }} />);
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认请求判断' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('locks an uncertain POST across remount and failed refresh until an authoritative GET replaces the snapshot', async () => {
    const { idea, state } = fixture();
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    const view = render(<AiPanel idea={idea} identity={identity} canWrite state={state} />);
    confirmRequest();
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestButton().disabled).toBe(true);
    view.unmount();
    const remount = render(<AiPanel idea={idea} identity={identity} canWrite state={{ ...state, platformError: '仍不可用' }} />);
    expect(requestButton().disabled).toBe(true);
    remount.rerender(<AiPanel idea={idea} identity={identity} canWrite state={state} />);
    expect(requestButton().disabled).toBe(true);
    remount.rerender(<AiPanel idea={idea} identity={identity} canWrite state={{ ...state, platform: { ...state.platform! } }} />);
    expect(requestButton().disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never treats POST acceptance as model success or reissues it before new GET history', async () => {
    const { idea, state } = fixture();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ accepted: true }) });
    vi.stubGlobal('fetch', fetch);
    const view = render(<AiPanel idea={idea} identity={identity} canWrite state={state} />);
    confirmRequest();
    await waitFor(() => expect(state.reload).toHaveBeenCalledTimes(1));
    expect(requestButton().disabled).toBe(true);
    view.rerender(<AiPanel idea={idea} identity={identity} canWrite state={{ ...state, platform: { ...state.platform! } }} />);
    expect(requestButton().disabled).toBe(true);
    const completed = assessment(idea.id, 'succeeded');
    view.rerender(<AiPanel idea={idea} identity={identity} canWrite state={{ ...state, platform: { ...state.platform!, assessments: [completed] } }} />);
    expect(requestButton().disabled).toBe(false);
    expect(screen.getByText('需要补充演示目标')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
