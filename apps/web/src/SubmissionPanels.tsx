import { useId, useState, type FormEvent } from 'react';
import {
  CreateSubmissionSchema,
  UpdateSubmissionFieldsSchema,
  type AttributionDto,
  type CreateSubmissionResponse,
  type ManualEntrySource,
  type SubmissionDetailDto,
  type SubmissionDto,
  type SubmissionFields,
  type SubmissionRelation,
  type SubmissionSource,
  type TemplateField,
} from '@workbench/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { request } from './api';
import { ActionFeedback, useAction } from './useAction';

const fieldLabels: Record<TemplateField, string> = {
  title: '想做啥',
  targetUsers: '给谁用',
  problem: '解决啥问题',
  desiredFeatures: '希望它能干啥（全部期望功能）',
  viewerPriorities: '最希望先做哪3件事（观众优先项）',
  pageScope: '想要几个页面、分别放啥',
  completionCriteria: '做到啥样算完成',
  style: '喜欢啥风格（选填）',
};
const fieldNames = Object.keys(fieldLabels) as TemplateField[];
const sourceLabels: Record<SubmissionSource, string> = {
  manual: '人工录入', sample: '示例投稿', douyin: '抖音接入',
};
const relationLabels: Record<SubmissionRelation, string> = {
  origin: '原始投稿', duplicate: '重复投稿', feedback: '补充反馈',
};
const parseLabels: Record<SubmissionDto['parseStatus'], string> = {
  complete: '原文解析完整', partial: '原文部分解析', unparsed: '原文未解析',
};
const exampleText = '投稿｜想做啥：自习室座位预约｜给谁用：大学生｜解决啥问题：图书馆占座难｜希望它能干啥：查看空位、预约座位、签到、排行榜、暗黑模式｜最希望先做哪3件事：查看空位、预约座位、签到｜想要几个页面、分别放啥：首页看空位，预约页，个人页｜做到啥样算完成：能演示预约到签到全流程｜喜欢啥风格（选填）：清新';

function validationMessage(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  const labels: Record<string, string> = {
    ...fieldLabels, source: '投稿来源', rawText: '原始投稿', authorName: '作者', sourceMessageId: '来源消息 ID',
  };
  return '请检查输入：' + issues.map((issue) => {
    const key = String(issue.path[0] ?? '');
    const item = typeof issue.path[1] === 'number' ? `第 ${issue.path[1] + 1} 项` : '';
    return `${labels[key] ?? '投稿字段'}${item}：${issue.message}`;
  }).join('；');
}

function RecordTime({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString('zh-CN')}</time>;
}

export function IntakeForm({ canOperate, onCreated }: {
  canOperate: boolean;
  onCreated: (ideaId: string) => Promise<void>;
}) {
  const id = useId();
  const [source, setSource] = useState<ManualEntrySource>('manual');
  const [authorName, setAuthorName] = useState('');
  const [rawText, setRawText] = useState('');
  const [sourceMessageId, setSourceMessageId] = useState('');
  const [confirmed, setConfirmed] = useState('');
  const action = useAction();

  function fillExample() {
    setSource('sample');
    setAuthorName('示例观众');
    setRawText(exampleText);
    setSourceMessageId('');
    setConfirmed('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate) return;
    await action.run(async () => {
      setConfirmed('');
      const parsed = CreateSubmissionSchema.safeParse({
        source, authorName: authorName.trim() || null, rawText, sourceMessageId: sourceMessageId.trim() || null,
      });
      if (!parsed.success) throw new Error(validationMessage(parsed.error.issues));
      const result = await request<CreateSubmissionResponse>('/submissions', { method: 'POST', body: parsed.data });
      setConfirmed(result.deduplicated
        ? `服务器已按来源消息 ID 去重：使用已有投稿 ${result.submission.id}，未新增投稿。`
        : `投稿已保存：${result.submission.id}。`);
      await onCreated(result.submission.ideaId);
    }, '');
  }

  return <Card className="panel" role="region" aria-labelledby={`${id}-heading`}>
    <header className="panel-header">
      <div><p className="eyebrow">投稿入口</p><h2 id={`${id}-heading`}>录入观众创意</h2></div>
      <Badge variant="secondary">{sourceLabels[source]}</Badge>
    </header>
    <p className="notice">人工录入和示例投稿均为非真实抖音接入。原文保存后不可修改，整理字段可另行编辑。</p>
    {!canOperate && <p className="notice">当前身份没有运营权限，只能查看投稿。</p>}
    <form onSubmit={submit} className="stack">
      <fieldset disabled={!canOperate || action.busy} className="form-grid">
        <legend>投稿内容</legend>
        <label className="field" htmlFor={`${id}-source`}>投稿来源
          <select id={`${id}-source`} value={source} onChange={(event) => setSource(event.target.value as ManualEntrySource)}>
            <option value="manual">人工录入（非真实抖音接入）</option>
            <option value="sample">示例投稿（非真实抖音接入）</option>
          </select>
        </label>
        <label className="field" htmlFor={`${id}-author`}>作者（选填）
          <Input id={`${id}-author`} maxLength={100} value={authorName} onChange={(event) => setAuthorName(event.target.value)} />
        </label>
        <label className="field" htmlFor={`${id}-message`}>来源消息 ID（选填，用于同来源消息去重）
          <Input id={`${id}-message`} maxLength={200} value={sourceMessageId} onChange={(event) => setSourceMessageId(event.target.value)} />
        </label>
        <label className="field" htmlFor={`${id}-raw`}>原始模板投稿（必填）
          <Textarea id={`${id}-raw`} required maxLength={5000} rows={9} value={rawText} onChange={(event) => setRawText(event.target.value)} aria-describedby={`${id}-template`} />
        </label>
      </fieldset>
      <p id={`${id}-template`} className="muted">模板：投稿｜想做啥：…｜给谁用：…｜解决啥问题：…｜希望它能干啥：…｜最希望先做哪3件事：…｜想要几个页面、分别放啥：…｜做到啥样算完成：…｜喜欢啥风格（选填）：…</p>
      <div className="actions">
        <Button type="button" variant="outline" disabled={!canOperate || action.busy} onClick={fillExample}>填入示例（切换为示例来源）</Button>
        <Button type="submit" disabled={!canOperate || action.busy}>{action.busy ? '正在保存…' : '保存投稿并打开创意'}</Button>
      </div>
      <ActionFeedback error={action.error} success={confirmed} />
    </form>
  </Card>;
}

type FieldsDraft = Record<TemplateField, string>;

function fieldsToDraft(fields: SubmissionFields): FieldsDraft {
  return {
    title: fields.title ?? '', targetUsers: fields.targetUsers ?? '', problem: fields.problem ?? '',
    desiredFeatures: fields.desiredFeatures.join('\n'), viewerPriorities: fields.viewerPriorities.join('\n'),
    pageScope: fields.pageScope ?? '', completionCriteria: fields.completionCriteria ?? '', style: fields.style ?? '',
  };
}

function FieldsEditor({ submission, canOperate, onSaved, onDiscard }: {
  submission: SubmissionDto;
  canOperate: boolean;
  onSaved: () => Promise<void>;
  onDiscard: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => fieldsToDraft(submission.fields));
  const action = useAction();
  const text = (field: TemplateField) => draft[field].trim() || null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate) return;
    await action.run(async () => {
      const parsed = UpdateSubmissionFieldsSchema.safeParse({
        title: text('title'), targetUsers: text('targetUsers'), problem: text('problem'),
        desiredFeatures: draft.desiredFeatures.split('\n').map((item) => item.trim()).filter(Boolean),
        viewerPriorities: draft.viewerPriorities.split('\n').map((item) => item.trim()).filter(Boolean),
        pageScope: text('pageScope'), completionCriteria: text('completionCriteria'), style: text('style'),
      });
      if (!parsed.success) throw new Error(validationMessage(parsed.error.issues));
      const saved = await request<SubmissionDto>(`/submissions/${encodeURIComponent(submission.id)}/fields`, {
        method: 'PATCH', body: parsed.data,
      });
      setDraft(fieldsToDraft(saved.fields));
      await onSaved();
    }, '整理字段已保存，原始投稿未修改。');
  }

  return <form className="stack" onSubmit={submit}>
    <p className="notice">只修改整理字段，不覆盖原文。列表每行一项；空白列表保存为空列表，其他空白字段保存为空值。刷新不会覆盖当前草稿，放弃或保存成功才会重置。</p>
    <fieldset className="form-grid" disabled={!canOperate || action.busy}>
      <legend>人工整理所有模板字段</legend>
      {fieldNames.map((field) => <label key={field} className="field" htmlFor={`${id}-${field}`}>
        {fieldLabels[field]}{field === 'desiredFeatures' || field === 'viewerPriorities' ? '（每行一项）' : ''}
        <Textarea id={`${id}-${field}`} rows={field === 'title' || field === 'style' ? 2 : 4} value={draft[field]}
          onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} />
      </label>)}
    </fieldset>
    <div className="actions">
      <Button type="submit" disabled={!canOperate || action.busy}>{action.busy ? '正在保存…' : '保存整理字段'}</Button>
      <Button type="button" variant="outline" disabled={action.busy} onClick={onDiscard}>放弃草稿并收起</Button>
    </div>
    <ActionFeedback error={action.error} success={action.success} />
  </form>;
}

function AttributionHistory({ submissionId }: { submissionId: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<AttributionDto[] | null>(null);
  const action = useAction();

  async function load() {
    await action.run(async () => {
      const detail = await request<SubmissionDetailDto>(`/submissions/${encodeURIComponent(submissionId)}`);
      setRecords(detail.attributions);
    }, '');
  }

  return <section className="stack">
    <div className="actions">
      <Button type="button" variant="outline" aria-expanded={open} aria-controls={`${id}-history`} disabled={action.busy}
        onClick={() => {
          if (open) setOpen(false);
          else { setOpen(true); void load(); }
        }}>{open ? '收起归属历史' : '查看归属历史'}</Button>
      {open && <Button type="button" variant="outline" disabled={action.busy} onClick={() => void load()}>刷新归属历史</Button>}
    </div>
    {open && <div id={`${id}-history`} className="stack" aria-busy={action.busy}>
      <h4>服务器归属历史</h4>
      {action.busy && <p role="status">正在读取归属历史…</p>}
      <ActionFeedback error={action.error} success="" />
      {records && records.length === 0 && <p className="muted">服务器尚无归属变更记录。</p>}
      {records?.map((record) => <article className="record" key={record.id}>
        <p><RecordTime value={record.createdAt} /> · {relationLabels[record.fromRelation]} → {relationLabels[record.toRelation]}</p>
        <p>原因：{record.reason}</p>
        <details className="audit-details">
          <summary>归属变更审计信息</summary>
          <p className="muted">操作人：{record.actor} · 归属记录：{record.id}</p>
          <p>来源创意：{record.fromIdeaId} → 目标创意：{record.toIdeaId}</p>
          {record.mergeId && <p className="muted">关联创意合并记录：{record.mergeId}</p>}
        </details>
      </article>)}
    </div>}
  </section>;
}

export function SubmissionRecord({ submission, canOperate, onSaved }: {
  submission: SubmissionDto;
  canOperate: boolean;
  onSaved: () => Promise<void>;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  return <Card className="panel record stack" role="article" aria-labelledby={`${id}-heading`}>
    <header className="panel-header">
      <h3 id={`${id}-heading`}>{submission.fields.title ?? '未填写标题的投稿'}</h3>
      <div className="inline-meta"><Badge variant="secondary">{sourceLabels[submission.source]}</Badge><Badge variant="outline">{relationLabels[submission.relation]}</Badge></div>
    </header>
    {submission.isSimulated && <p className="notice">此投稿为人工或示例输入，非真实抖音接入。</p>}
    <dl className="inline-meta">
      <div><dt>作者</dt><dd>{submission.authorName ?? '未提供'}</dd></div>
      <div><dt>接收时间</dt><dd><RecordTime value={submission.receivedAt} /></dd></div>
    </dl>
    <details className="audit-details">
      <summary>投稿标识与录入信息</summary>
      <dl className="parsed-fields">
        <div><dt>来源消息 ID</dt><dd>{submission.sourceMessageId ?? '未提供'}</dd></div>
        <div><dt>投稿 ID</dt><dd>{submission.id}</dd></div>
        <div><dt>当前创意 ID</dt><dd>{submission.ideaId}</dd></div>
        <div><dt>录入人</dt><dd>{submission.createdBy}</dd></div>
        <div><dt>录入时间</dt><dd><RecordTime value={submission.createdAt} /></dd></div>
        <div><dt>整理更新时间</dt><dd><RecordTime value={submission.updatedAt} /></dd></div>
      </dl>
    </details>
    <section className="stack"><h4>不可修改的原始投稿</h4><blockquote className="raw-quote">{submission.rawText}</blockquote></section>
    <section className="stack">
      <h4>当前整理字段</h4>
      <p className="muted">{parseLabels[submission.parseStatus]}。解析状态描述原文；缺失项以下方当前整理结果为准。</p>
      <p className={submission.missingFields.length ? 'notice danger' : 'muted'}>缺失必填项：{submission.missingFields.length ? submission.missingFields.map((field) => fieldLabels[field]).join('、') : '无'}</p>
      <dl className="parsed-fields">{fieldNames.map((field) => <div key={field}>
        <dt>{fieldLabels[field]}</dt>
        <dd>{Array.isArray(submission.fields[field])
          ? (submission.fields[field].length ? <ul className="feature-list">{submission.fields[field].map((item, index) => <li key={index}>{item}</li>)}</ul> : '未填写')
          : <span style={{ whiteSpace: 'pre-wrap' }}>{submission.fields[field] ?? '未填写'}</span>}</dd>
      </div>)}</dl>
      <p className="muted">观众优先项独立保留，不等于本次最终范围；全部期望功能不会按三个优先项截断。</p>
    </section>
    {canOperate || editing ? <>
      {!editing && <div className="actions"><Button type="button" variant="outline" aria-expanded={false} aria-controls={`${id}-editor`} onClick={() => setEditing(true)}>展开人工整理</Button></div>}
      {editing && <div id={`${id}-editor`}><FieldsEditor key={submission.id} submission={submission} canOperate={canOperate} onSaved={onSaved} onDiscard={() => setEditing(false)} /></div>}
    </> : <p className="muted">只有运营角色可以整理投稿字段。</p>}
    <AttributionHistory key={submission.id} submissionId={submission.id} />
  </Card>;
}
