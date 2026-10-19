import { useId } from 'react';
import type { IntegrationState, ReadinessCheckDto } from '@workbench/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { PlatformState } from './usePlatform';

const stateLabels: Record<IntegrationState, string> = {
  not_configured: '未配置', invalid: '配置不完整或无效', configured: '本地配置完整（未核验远端）',
};

function ReadinessChecks({ checks }: { checks: ReadinessCheckDto[] }) {
  if (checks.length === 0) return <p className="muted">服务器未提供检查项；不能据此推断远端可用。</p>;
  return <ul className="stack" aria-label="本地配置检查">{checks.map((check) => <li key={check.key}>
    <Badge variant={check.ok ? 'outline' : 'secondary'}>{check.ok ? '本地检查通过' : '待配置或修正'}</Badge>{' '}{check.message}
  </li>)}</ul>;
}

function safeRepoLabel(value: string | null): string {
  if (!value) return '未配置';
  // Display repository coordinates only, never URL credentials, query strings or fragments.
  const ssh = /^git@([a-zA-Z0-9.-]+):([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/?$/.exec(value);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && /^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(url.pathname)) {
      return `${url.host}${url.pathname}`;
    }
  } catch { /* Invalid configuration is reported by the server's safe readiness checks. */ }
  return '仓库配置值无法安全展示，请查看服务器配置检查';
}

export function IntegrationPanel({ state }: { state: PlatformState }) {
  const id = useId();
  const integrations = state.integrations;
  const unread = state.integrationsError ? '读取失败，历史仅供参考' : state.loading ? '正在核实' : !integrations ? '尚未读取' : null;
  return <Card id="integration-status" className="panel stack integration-status" role="region" aria-labelledby={`${id}-heading`}>
    <details>
      <summary className="panel-header">
        <div><h2 id={`${id}-heading`}>集成配置与授权</h2><p className="muted">展开查看服务端配置检查，不展示密钥或部署凭据。</p></div>
        <div className="inline-meta">
          <Badge variant="outline">AI：{unread ?? stateLabels[integrations!.ai.state]}</Badge>
          <Badge variant="outline">Multica：{unread ?? stateLabels[integrations!.multica.state]}</Badge>
          <Badge variant="secondary">{unread ? '写入与启动授权待核实' : `写入${integrations!.multica.writesEnabled ? '开启' : '未授权'} · 启动${integrations!.multica.executionEnabled ? '开启' : '未授权'}`}</Badge>
        </div>
      </summary>
      <div className="stack integration-details">
      <Button type="button" variant="outline" disabled={state.loading} onClick={() => void state.reload()}>{state.loading ? '正在刷新…' : '刷新集成状态'}</Button>
    {state.integrationsError && <p className="notice danger" role="alert">集成配置读取失败：{state.integrationsError}。下方保留的配置仅供参考，不代表当前配置。</p>}
    {state.platformError && <p className="notice danger" role="alert">创意平台记录读取失败：{state.platformError}。依赖该接口的写操作保持禁用。</p>}
    {state.unavailable && <p className="notice">创意平台接口尚未开放（404）；不能判断是否已有判断、待审任务或立项记录。配置读取可用不代表其他接口已实现。</p>}
    <p className="notice">AI / Multica 未配置不影响人工投稿、整理、合并及审核。配置完整只说明本地变量检查通过，不证明部署身份、远端权限、模型额度或真实连接已经核验。</p>
    {!integrations ? <p className="muted">{state.loading ? '正在读取真实集成配置。' : '尚未成功取得集成配置；不能推断为已连接或未配置。'}</p> : <>
      <section className="record stack" aria-labelledby={`${id}-ai`}>
        <div className="panel-header"><h3 id={`${id}-ai`}>AI 模型</h3><Badge variant="outline">{stateLabels[integrations.ai.state]}</Badge></div>
        <dl>
          <dt>接口类型</dt><dd>{integrations.ai.provider === 'openai-compatible' ? 'OpenAI 兼容 Chat Completions' : '未配置'}</dd>
          <dt>模型</dt><dd>{integrations.ai.model || '未配置'}</dd>
          <dt>用途范围</dt><dd>{integrations.ai.dataScope === 'simulated_only' ? '仅模拟的人工录入 / 示例投稿；抖音来源未获准送入模型' : '未知用途范围，不能调用模型'}</dd>
        </dl>
        <ReadinessChecks checks={integrations.ai.checks} />
        <p className="muted">只有运营人员显式确认后才请求模型；本页不会自动调用、测试额度或推断调用成功。</p>
      </section>
      <section className="record stack" aria-labelledby={`${id}-multica`}>
        <div className="panel-header"><h3 id={`${id}-multica`}>Multica 平台</h3><Badge variant="outline">{stateLabels[integrations.multica.state]}</Badge></div>
        <dl>
          <dt>Workspace ID</dt><dd className="id-text">{integrations.multica.workspaceId || '未配置'}</dd>
          <dt>待审工作台项目 ID</dt><dd className="id-text">{integrations.multica.workbenchProjectId || '未配置'}</dd>
          <dt>产品交付仓库</dt><dd className="id-text">{safeRepoLabel(integrations.multica.productRepoUrl)}</dd>
          <dt>平台写入开关</dt><dd>{integrations.multica.writesEnabled ? '已开启：允许经权限与条件检查的建任务、立项、分配' : '已关闭：禁止建任务、立项、分配等平台写入'}</dd>
          <dt>Agent 启动开关</dt><dd>{integrations.multica.executionEnabled ? '已开启：仍需写入开关、launcher 权限及全部启动检查通过' : '已关闭：不能启动 agent'}</dd>
        </dl>
        <ReadinessChecks checks={integrations.multica.checks} />
        <p className="muted">两个开关为独立的部署授权，不是“已连接”或“已运行”状态。本页不能切换授权、选择 agent、分配或启动任务。</p>
      </section>
    </>}
      </div>
    </details>
  </Card>;
}
