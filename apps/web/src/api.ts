import type { ApiErrorBody } from '@workbench/contracts';

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    let response: Response;
    try {
      response = await fetch(`/api${path}`, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers: options.body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (deadline.signal.aborted) throw new ApiError('服务器响应超时，操作结果待核实，请刷新确认；未自动重试。', 'TIMEOUT', 0);
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError('无法连接服务器。写操作可能已生效，请刷新核实后再操作；未自动重试。', 'NETWORK', 0);
    }
    if (!response.ok) {
      const body: ApiErrorBody | null = await response.json().catch(() => null);
      const code = body?.error?.code ?? 'HTTP_ERROR';
      const message = response.status === 401 ? '身份未验证或会话失效，请检查后台访问入口。'
        : response.status === 403 ? '当前身份没有此操作权限。'
        : response.status >= 500 ? '服务器处理失败，操作结果待核实，请刷新后确认。'
        : body?.error?.message ?? `请求失败（${response.status}）`;
      throw new ApiError(message, code, response.status);
    }
    try {
      return await response.json() as T;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (deadline.signal.aborted) throw new ApiError('服务器确认结果超时，操作结果待核实，请刷新确认。', 'TIMEOUT', 0);
      throw new ApiError('未收到有效服务器结果，请刷新核实；不能确认操作成功。', 'INVALID_RESPONSE', response.status);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '操作失败，请刷新核实。';
