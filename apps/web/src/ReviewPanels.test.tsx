// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdeaDetailDto, ScopeVersionDto } from '@workbench/contracts';
import { ScopePanel } from './ReviewPanels';

const idea: IdeaDetailDto = {
  id: '11111111-1111-4111-8111-111111111111', title: '座位预约', status: 'open',
  mergedIntoId: null, currentScopeVersionId: null, approvedScopeVersionId: null,
  submissionCount: 1, feedbackCount: 0, hasSimulatedSubmissions: true,
  createdAt: '2026-10-09T08:00:00Z', updatedAt: '2026-10-09T08:00:00Z',
  submissions: [], feedback: [], desiredFeatures: [], scopeVersions: [], reviews: [],
  mergesIn: [], mergeOut: null, launch: { launchable: false, approvedScope: null, reason: '待人工审核' },
};
const scope: ScopeVersionDto = {
  id: '22222222-2222-4222-8222-222222222222', ideaId: idea.id, versionNo: 1,
  features: [
    { title: '服务器新功能一', acceptanceCriteria: '能演示功能一' },
    { title: '服务器新功能二', acceptanceCriteria: '能演示功能二' },
    { title: '服务器新功能三', acceptanceCriteria: '能演示功能三' },
  ],
  pageScope: '首页', style: null, notes: null, status: 'pending_review', proposedBy: 'operator',
  createdAt: '2026-10-09T08:01:00Z', statusChangedAt: '2026-10-09T08:01:00Z',
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('human scope drafts during live refresh', () => {
  it('retains the edited scope while read freshness temporarily disables writing', () => {
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const view = render(<ScopePanel idea={idea} canOperate canReview onSaved={onSaved} />);
    fireEvent.change(screen.getAllByLabelText('功能标题（必填，最多 200 字）')[0]!, { target: { value: '主播尚未提交的草稿' } });
    view.rerender(<ScopePanel idea={idea} canOperate={false} canReview={false} onSaved={onSaved} />);
    expect(screen.getByDisplayValue('主播尚未提交的草稿')).toBeDefined();
    expect((screen.getByRole('button', { name: '提交新范围版本，进入待审核' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ScopePanel idea={{ ...idea, updatedAt: '2026-10-09T08:01:00Z' }} canOperate canReview onSaved={onSaved} />);
    expect(screen.getByDisplayValue('主播尚未提交的草稿')).toBeDefined();
    expect((screen.getByRole('button', { name: '提交新范围版本，进入待审核' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps a stale draft without silently switching its base or submitting it', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const view = render(<ScopePanel idea={idea} canOperate canReview onSaved={onSaved} />);
    fireEvent.change(screen.getAllByLabelText('功能标题（必填，最多 200 字）')[0]!, { target: { value: '主播尚未提交的草稿' } });
    view.rerender(<ScopePanel idea={{ ...idea, status: 'pending_review', currentScopeVersionId: scope.id, scopeVersions: [scope] }} canOperate canReview onSaved={onSaved} />);
    const input = screen.getByDisplayValue('主播尚未提交的草稿') as HTMLInputElement;
    const submit = screen.getByRole('button', { name: '提交新范围版本，进入待审核' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.submit(input.form!);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '丢弃草稿并载入当前版本' }));
    expect(screen.queryByDisplayValue('主播尚未提交的草稿')).toBeNull();
    expect(screen.getByDisplayValue('服务器新功能一')).toBeDefined();
    expect(submit.disabled).toBe(false);
  });

  it('retains a mounted draft when its editor is collapsed during permission and server updates', () => {
    const pendingIdea: IdeaDetailDto = { ...idea, status: 'pending_review', currentScopeVersionId: scope.id, scopeVersions: [scope] };
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const view = render(<ScopePanel idea={pendingIdea} canOperate canReview onSaved={onSaved} />);
    expect(screen.queryByRole('textbox', { name: '功能标题（必填，最多 200 字）' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '编辑本次范围' }));
    fireEvent.change(screen.getAllByLabelText('功能标题（必填，最多 200 字）')[0]!, { target: { value: '收起后仍保留的修改' } });
    fireEvent.click(screen.getByRole('button', { name: '收起范围编辑' }));
    view.rerender(<ScopePanel idea={{ ...pendingIdea, updatedAt: '2026-10-09T08:02:00Z' }} canOperate={false} canReview={false} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑本次范围' }));
    const input = screen.getByDisplayValue('收起后仍保留的修改') as HTMLInputElement;
    expect(input.matches(':disabled')).toBe(true);
    view.rerender(<ScopePanel idea={pendingIdea} canOperate canReview onSaved={onSaved} />);
    expect(screen.getByDisplayValue('收起后仍保留的修改')).toBe(input);
    expect(input.matches(':disabled')).toBe(false);
  });
});

describe('captured human review confirmation', () => {
  const pendingIdea: IdeaDetailDto = { ...idea, status: 'pending_review', currentScopeVersionId: scope.id, scopeVersions: [scope] };

  it('keeps failed confirmation open and restores the unchanged review draft on cancel', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<ScopePanel idea={pendingIdea} canOperate canReview onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('决定'), { target: { value: 'return' } });
    fireEvent.change(screen.getByLabelText('审核理由（退回、拒绝必填；最多 2000 字）'), { target: { value: '需要补充验收边界' } });
    fireEvent.click(screen.getByRole('button', { name: '查看范围并确认审核' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(scope.features[0]!.title)).toBeDefined();
    expect(within(dialog).getByText('需要补充验收边界')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认退回补充' }));
    await waitFor(() => expect(within(screen.getByRole('alertdialog')).getByRole('alert')).toBeDefined());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消确认，返回编辑' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((screen.getByLabelText('决定') as HTMLSelectElement).value).toBe('return');
    expect((screen.getByLabelText('审核理由（退回、拒绝必填；最多 2000 字）') as HTMLTextAreaElement).value).toBe('需要补充验收边界');
  });

  it('preserves the captured scope and prevents submission when the server version changes', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const view = render(<ScopePanel idea={pendingIdea} canOperate canReview onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('决定'), { target: { value: 'approve' } });
    fireEvent.click(screen.getByRole('button', { name: '查看范围并确认审核' }));
    const newerScope: ScopeVersionDto = {
      ...scope, id: '33333333-3333-4333-8333-333333333333', versionNo: 2,
      features: [{ title: '新版本替换功能', acceptanceCriteria: '新版本标准' }, scope.features[1]!, scope.features[2]!],
    };
    view.rerender(<ScopePanel idea={{ ...pendingIdea, currentScopeVersionId: newerScope.id, scopeVersions: [newerScope, { ...scope, status: 'superseded' }] }} canOperate canReview onSaved={onSaved} />);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(scope.features[0]!.title)).toBeDefined();
    expect(within(dialog).queryByText(newerScope.features[0]!.title)).toBeNull();
    const confirm = within(dialog).getByRole('button', { name: '确认批准' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消确认，返回编辑' }));
    expect((screen.getByLabelText('决定') as HTMLSelectElement).value).toBe('approve');
  });
});
