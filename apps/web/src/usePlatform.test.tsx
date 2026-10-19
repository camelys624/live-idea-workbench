// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlatform } from './usePlatform';

const integration = {
  ai: { state: 'not_configured', provider: null, model: null, dataScope: 'simulated_only', checks: [] },
  multica: { state: 'not_configured', workspaceId: null, workbenchProjectId: null, productRepoUrl: null, writesEnabled: false, executionEnabled: false, checks: [] },
};
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('platform selection freshness', () => {
  it('does not show another idea’s late result or release the newer selection’s loading gate', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    // Deliberately ignore AbortSignal: a late response can already be queued when selection changes.
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/api/integrations') return Promise.resolve(json(integration));
      return new Promise<Response>((resolve) => {
        if (path === '/api/ideas/first/platform') resolveFirst = resolve;
        else if (path === '/api/ideas/second/platform') resolveSecond = resolve;
        else throw new Error(`Unexpected request: ${path}`);
      });
    }));
    const { result, rerender } = renderHook(({ id }) => usePlatform(id, 0), { initialProps: { id: 'first' } });
    await waitFor(() => expect(resolveFirst).toBeDefined());
    rerender({ id: 'second' });
    await waitFor(() => expect(resolveSecond).toBeDefined());
    await act(async () => { resolveFirst(json({ ideaId: 'first', assessments: [], reviewTask: null, product: null })); });
    expect(result.current.platform).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { resolveSecond(json({ ideaId: 'second', assessments: [], reviewTask: null, product: null })); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.platform?.ideaId).toBe('second');
  });
});
