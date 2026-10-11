import { describe, expect, it } from 'vitest';
import type { IntegrationStatusDto } from '@workbench/contracts';
import { loadIntegrations } from '../src/integrations.ts';
import { useTestApp } from './helpers.ts';

const AI = { AI_BASE_URL: 'https://models.example.com/v1', AI_API_KEY: 'sk-test-secret-value', AI_MODEL: 'demo-model' };
const MULTICA = {
  WORKBENCH_MULTICA_PROFILE: 'workbench-deploy',
  WORKBENCH_MULTICA_WORKSPACE_ID: 'b5aa222d-b388-4dd7-b124-44afb152b706',
  WORKBENCH_MULTICA_PROJECT_ID: 'f136606c-25e8-420d-99d6-4e3083554bde',
  WORKBENCH_PRODUCT_REPO_URL: 'git@github.com:camelys624/live-projects.git',
};
const failing = (status: IntegrationStatusDto['ai' | 'multica']) => status.checks.filter((c) => !c.ok).map((c) => c.key);

describe('integration configuration', () => {
  it('defaults to not configured with no usable settings', () => {
    const i = loadIntegrations({});
    expect(i.status.ai.state).toBe('not_configured');
    expect(i.status.multica.state).toBe('not_configured');
    expect(i.ai).toBeNull();
    expect(i.multica).toBeNull();
    expect(i.status.multica.writesEnabled).toBe(false);
  });

  it('reports partial AI configuration as invalid and never exposes the key', () => {
    const i = loadIntegrations({ AI_API_KEY: AI.AI_API_KEY });
    expect(i.status.ai.state).toBe('invalid');
    expect(failing(i.status.ai)).toEqual(['ai.base_url', 'ai.model']);
    expect(i.ai).toBeNull();
    const full = loadIntegrations(AI);
    expect(full.status.ai.state).toBe('configured');
    expect(full.ai?.apiKey).toBe(AI.AI_API_KEY);
    expect(JSON.stringify(full.status)).not.toContain(AI.AI_API_KEY);
  });

  it('rejects plain http model endpoints except loopback', () => {
    expect(loadIntegrations({ ...AI, AI_BASE_URL: 'http://models.example.com/v1' }).status.ai.state).toBe('invalid');
    expect(loadIntegrations({ ...AI, AI_BASE_URL: 'http://127.0.0.1:8080/v1' }).status.ai.state).toBe('configured');
  });

  it('keeps writes and execution off until each is explicitly enabled', () => {
    const off = loadIntegrations(MULTICA);
    expect(off.status.multica.state).toBe('configured');
    expect(off.status.multica.writesEnabled).toBe(false);
    expect(off.status.multica.executionEnabled).toBe(false);
    expect(failing(off.status.multica)).toEqual(['multica.writes_enabled', 'multica.execution_enabled']);

    const writesOnly = loadIntegrations({ ...MULTICA, WORKBENCH_MULTICA_WRITES_ENABLED: 'true' });
    expect(writesOnly.multica?.writesEnabled).toBe(true);
    expect(writesOnly.multica?.executionEnabled).toBe(false);

    const both = loadIntegrations({
      ...MULTICA,
      WORKBENCH_MULTICA_WRITES_ENABLED: 'true',
      WORKBENCH_MULTICA_EXECUTION_ENABLED: 'true',
    });
    expect(both.multica?.executionEnabled).toBe(true);
  });

  it('refuses execution authorization without write authorization', () => {
    const i = loadIntegrations({ ...MULTICA, WORKBENCH_MULTICA_EXECUTION_ENABLED: 'true' });
    expect(i.status.multica.state).toBe('invalid');
    expect(i.multica).toBeNull();
    expect(failing(i.status.multica)).toEqual(['multica.execution_flag']);
  });

  it('refuses to run with an agent run credential instead of a deployment identity', () => {
    for (const runEnv of [{ MULTICA_TASK_ID: 'task' }, { MULTICA_TOKEN: 'mat_run_scoped' }]) {
      const i = loadIntegrations({ ...MULTICA, WORKBENCH_MULTICA_WRITES_ENABLED: 'true', ...runEnv });
      expect(i.status.multica.state).toBe('invalid');
      expect(i.multica).toBeNull();
      expect(i.status.multica.writesEnabled).toBe(false);
      expect(failing(i.status.multica)).toEqual(['multica.isolated_identity']);
    }
  });

  it('validates ids, profile name and product repository', () => {
    const i = loadIntegrations({
      WORKBENCH_MULTICA_PROFILE: '../owner',
      WORKBENCH_MULTICA_WORKSPACE_ID: 'current',
      WORKBENCH_MULTICA_PROJECT_ID: MULTICA.WORKBENCH_MULTICA_PROJECT_ID,
      WORKBENCH_PRODUCT_REPO_URL: 'https://gitlab.com/x/y',
      WORKBENCH_MULTICA_WRITES_ENABLED: 'yes',
    });
    expect(failing(i.status.multica)).toEqual([
      'multica.profile',
      'multica.workspace',
      'multica.product_repo',
      'multica.writes_flag',
    ]);
  });
});

describe('GET /api/integrations', () => {
  const ctx = useTestApp();

  it('reports the unconfigured state to any authenticated identity', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/integrations',
      headers: { 'x-workbench-user': 'viewer', 'x-workbench-roles': '' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as IntegrationStatusDto;
    expect(body.ai.state).toBe('not_configured');
    expect(body.multica.state).toBe('not_configured');
    expect(body.multica.executionEnabled).toBe(false);
  });
});
