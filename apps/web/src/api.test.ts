import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './api';

// Network outcomes must never turn an uncertain write into a reported success.
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('uncertain API writes', () => {
  it('does not replay a write when the connection drops after sending it', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('connection closed'));
    vi.stubGlobal('fetch', fetch);
    await expect(request('/ideas/id/reviews', { method: 'POST', body: { decision: 'approve' } }))
      .rejects.toMatchObject({ code: 'NETWORK', status: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful HTTP status with an unreadable confirmation body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('proxy html', { status: 201 })));
    await expect(request('/submissions', { method: 'POST', body: {} }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 201 });
  });

  it('ends a hanging proxy request without retrying an uncertain write', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const result = request('/ideas/id/reviews', { method: 'POST', body: { decision: 'approve' } });
    const rejected = expect(result).rejects.toMatchObject({ code: 'TIMEOUT', status: 0 });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an explicitly cancelled read instead of reporting a network failure', async () => {
    const abort = new DOMException('cancelled', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    try {
      await request('/ideas', { signal: AbortSignal.abort() });
      throw new Error('read unexpectedly succeeded');
    } catch (error) {
      expect(error).toBe(abort);
      expect(error).not.toBeInstanceOf(ApiError);
    }
  });
});
