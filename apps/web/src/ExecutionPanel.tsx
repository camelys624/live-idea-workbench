import type { IdeaDetailDto } from '@workbench/contracts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

/** Current contracts expose review readiness, not platform task or execution records. */
export function ExecutionPanel({ idea }: { idea: IdeaDetailDto }) {
  return <Card className="panel" aria-labelledby="execution-heading">
    <div className="panel-header"><div><p className="eyebrow">人工决策之后</p><h2 id="execution-heading">任务与执行</h2></div><Badge variant="secondary">平台能力未就绪</Badge></div>
    <p className="muted">审核通过仅代表本次范围获批，不代表已建项目、已分配或已启动。</p>
    <ol className="phase-grid">
      <li><span className="phase-number">01</span><h3>建任务</h3><p>暂无平台确认记录</p><small>当前后端未提供 AI 建任务与 Multica 立项接口。AI 建出的待审任务须 backlog、未分配。</small><Button variant="outline" disabled title="等待 ROBB-11 提供真实平台契约">创建独立项目与任务</Button></li>
      <li><span className="phase-number">02</span><h3>人工审核</h3><p>{idea.launch.launchable ? `最新范围已批准 · v${idea.launch.approvedScope?.versionNo}` : '尚不可立项'}</p><small>{idea.launch.reason ?? '后端确认当前批准版本可作为立项依据；未自动选择 agent。'}</small></li>
      <li><span className="phase-number">03</span><h3>人工分配</h3><p>未取得分配及依赖状态</p><label className="field">选择 agent<select disabled value=""><option value="">由人工选择，不默认分配</option></select></label><small>需最新范围批准、依赖就绪及真实 agent 列表。</small><Button variant="outline" disabled title="真实分配接口尚未提供">确认分配</Button></li>
      <li><span className="phase-number">04</span><h3>执行</h3><p>暂无可核实的执行状态</p><small>未接入真实平台查询。分配与启动分别确认；不以本地点击推断运行成功。</small><Button variant="outline" disabled title="真实启动接口尚未提供">确认启动</Button></li>
    </ol>
    <p className="notice">ROBB-11 尚未提供平台能力，以上操作不可执行。ROBB-13 的真实抖音接入也未提供；这里不展示模拟进度或虚构成功。</p>
  </Card>;
}
