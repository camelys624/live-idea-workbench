import { useCallback, useEffect, useRef, useState } from 'react';
import type { IdeaPlatformDto, IntegrationStatusDto } from '@workbench/contracts';
import { ApiError, errorMessage, request } from './api';

export interface PlatformState {
  integrations: IntegrationStatusDto | null;
  integrationsError: string;
  platform: IdeaPlatformDto | null;
  platformError: string;
  unavailable: boolean;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Reads are independent: a missing platform route must not hide configuration checks. */
export function usePlatform(ideaId: string | null, refreshKey: number): PlatformState {
  const [integrations, setIntegrations] = useState<IntegrationStatusDto | null>(null);
  const [integrationsError, setIntegrationsError] = useState('');
  const [platform, setPlatform] = useState<IdeaPlatformDto | null>(null);
  const [platformError, setPlatformError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const version = ++sequence.current;
    setLoading(true);
    const active = () => !current.signal.aborted && sequence.current === version;
    await Promise.all([
      request<IntegrationStatusDto>('/integrations', { signal: current.signal }).then((result) => {
        if (!active()) return;
        setIntegrations(result);
        setIntegrationsError('');
      }).catch((error: unknown) => {
        if (active()) setIntegrationsError(errorMessage(error));
      }),
      ideaId ? request<IdeaPlatformDto>(`/ideas/${ideaId}/platform`, { signal: current.signal }).then((result) => {
        if (!active()) return;
        setPlatform(result);
        setPlatformError('');
        setUnavailable(false);
      }).catch((error: unknown) => {
        if (!active()) return;
        const missing = error instanceof ApiError && error.status === 404;
        setUnavailable(missing);
        setPlatformError(missing ? '平台查询接口尚未提供，AI 判断与派单操作不可用；投稿与人工审核仍可继续。' : errorMessage(error));
      }) : Promise.resolve(),
    ]);
    if (active()) setLoading(false);
  }, [ideaId]);

  useEffect(() => {
    setPlatform(null);
    setPlatformError('');
    setUnavailable(false);
  }, [ideaId]);

  useEffect(() => {
    void reload();
    return () => {
      controller.current?.abort();
      ++sequence.current;
    };
  }, [reload, refreshKey]);

  return {
    integrations,
    integrationsError,
    platform: platform?.ideaId === ideaId ? platform : null,
    platformError,
    unavailable,
    loading,
    reload,
  };
}
