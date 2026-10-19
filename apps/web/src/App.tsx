import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { IdeaDetailDto, IdeaStatus, IdeaSummaryDto, MeDto, Page, SubmissionDto, WorkbenchEvent } from '@workbench/contracts';
import { errorMessage, request } from './api';
import { IntakeForm, SubmissionRecord } from './SubmissionPanels';
import { ScopePanel } from './ReviewPanels';
import { RelationshipPanel } from './RelationshipPanel';
import { IntegrationPanel } from './IntegrationPanel';
import { usePlatform } from './usePlatform';
import { ArrowLeft, ClipboardList, Clock3, FileText, Inbox, Info, Lightbulb, Menu, MessageSquare, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

const AiPanel = lazy(() => import('./AiPanel').then((module) => ({ default: module.AiPanel })));
const ExecutionPanel = lazy(() => import('./ExecutionPanel').then((module) => ({ default: module.ExecutionPanel })));

const statusLabels: Record<IdeaStatus, string> = { open: '待整理', pending_review: '待审核', returned: '已退回', approved: '已批准', rejected: '已拒绝', merged: '已合并' };
const sourceLabels = { manual: '人工录入', sample: '示例投稿', douyin: '抖音评论' };
const roleLabels: Record<MeDto['roles'][number], string> = { operator: '操作员', reviewer: '审核员', dispatcher: '调度员', launcher: '启动授权员' };

export function App() {
  const [mode, setMode] = useState<'inbox' | 'review'>('inbox');
  const [filter, setFilter] = useState('');
  const [activeTab, setActiveTab] = useState('scope');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [identity, setIdentity] = useState<MeDto | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionDto[]>([]);
  const [ideas, setIdeas] = useState<IdeaSummaryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IdeaDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [identityError, setIdentityError] = useState('');
  const [showIntake, setShowIntake] = useState(false);
  const [streamState, setStreamState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [platformEpoch, setPlatformEpoch] = useState(0);
  const streamRef = useRef<EventSource | null>(null);
  const [updatedAt, setUpdatedAt] = useState('');
  const selectedRef = useRef(selectedId);
  const listContext = useRef({ mode, filter });
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const identitySequence = useRef(0);
  const listLock = useRef(false);
  const mounted = useRef(true);
  selectedRef.current = selectedId;
  listContext.current = { mode, filter };
  const platformState = usePlatform(selectedId, platformEpoch);

  const loadIdentity = useCallback(async () => {
    const sequence = ++identitySequence.current;
    try {
      const result = await request<MeDto>('/me');
      if (!mounted.current || sequence !== identitySequence.current) return;
      setIdentity(result);
      setIdentityError('');
    } catch (error) {
      if (!mounted.current || sequence !== identitySequence.current) return;
      setIdentity(null);
      setIdentityError(errorMessage(error));
      setStreamState('disconnected');
      // Some proxies leave an upstream-aborted SSE socket open. A failed identity read is authoritative.
      streamRef.current?.close();
      streamRef.current = null;
    }
  }, []);

  const loadList = useCallback(async (nextCursor?: string) => {
    if (nextCursor && listLock.current) return;
    const sequence = ++listSequence.current;
    listLock.current = true;
    const context = listContext.current;
    const query = new URLSearchParams({ limit: '20' });
    if (nextCursor) query.set('cursor', nextCursor);
    if (context.filter) query.set(context.mode === 'inbox' ? 'source' : 'status', context.filter);
    setListLoading(true);
    setListError('');
    try {
      const result = context.mode === 'inbox'
        ? await request<Page<SubmissionDto>>(`/submissions?${query}`)
        : await request<Page<IdeaSummaryDto>>(`/ideas?${query}`);
      if (!mounted.current || sequence !== listSequence.current) return;
      if (context.mode === 'inbox') setSubmissions((old) => nextCursor ? [...old, ...result.items as SubmissionDto[]] : result.items as SubmissionDto[]);
      else setIdeas((old) => nextCursor ? [...old, ...result.items as IdeaSummaryDto[]] : result.items as IdeaSummaryDto[]);
      setCursor(result.nextCursor);
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN'));
    } catch (error) {
      if (mounted.current && sequence === listSequence.current) setListError(errorMessage(error));
    } finally {
      if (mounted.current && sequence === listSequence.current) {
        listLock.current = false;
        setListLoading(false);
      }
    }
  }, []);

  const loadDetail = useCallback(async () => {
    const id = selectedRef.current;
    const sequence = ++detailSequence.current;
    if (!id) return;
    setDetailLoading(true);
    setDetailError('');
    try {
      const result = await request<IdeaDetailDto>(`/ideas/${id}`);
      if (!mounted.current || sequence !== detailSequence.current || selectedRef.current !== id) return;
      setDetail(result);
    } catch (error) {
      if (mounted.current && sequence === detailSequence.current && selectedRef.current === id) setDetailError(errorMessage(error));
    } finally {
      if (mounted.current && sequence === detailSequence.current) setDetailLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setPlatformEpoch((epoch) => epoch + 1);
    await Promise.all([loadIdentity(), loadList(), loadDetail()]);
  }, [loadIdentity, loadList, loadDetail]);

  useEffect(() => {
    mounted.current = true;
    setStreamState('connecting');
    void refresh();
    const stream = new EventSource('/api/events');
    streamRef.current = stream;
    stream.onopen = () => {
      setStreamState('connected');
      // SSE does not replay missed events: refresh on every connection/reconnection.
      void refresh();
    };
    stream.onerror = () => setStreamState('disconnected');
    const onEvent = (event: MessageEvent<string>) => {
      let data: WorkbenchEvent;
      try { data = JSON.parse(event.data) as WorkbenchEvent; } catch { return; }
      void loadList();
      if (data.ideaId === selectedRef.current) setPlatformEpoch((epoch) => epoch + 1);
      if (data.ideaId === selectedRef.current || data.type === 'submission.updated' || data.type === 'idea.updated') void loadDetail();
    };
    for (const name of ['submission.created', 'submission.updated', 'idea.updated', 'platform.updated']) stream.addEventListener(name, onEvent as EventListener);
    return () => {
      mounted.current = false;
      stream.close();
      if (streamRef.current === stream) streamRef.current = null;
      ++listSequence.current;
      ++detailSequence.current;
      ++identitySequence.current;
    };
  }, [loadIdentity, loadList, loadDetail, refresh, streamEpoch]);

  useEffect(() => {
    setCursor(null);
    setSubmissions([]);
    setIdeas([]);
    void loadList();
  }, [mode, filter, loadList]);

  useEffect(() => {
    setDetail(null);
    setDetailError('');
    void loadDetail();
  }, [selectedId, loadDetail]);

  function selectIdea(id: string) {
    selectedRef.current = id;
    setSelectedId(id);
    setShowIntake(false);
    if (id !== selectedId) setActiveTab('scope');
    setMobileView('detail');
  }
  async function onCreated(id: string) {
    selectedRef.current = id;
    setSelectedId(id);
    setMobileView('detail');
    await Promise.all([loadList(), loadDetail()]);
  }

  const canOperate = identity?.roles.includes('operator') ?? false;
  const canReview = identity?.roles.includes('reviewer') ?? false;
  const freshDetail = !detailError && !identityError && !detailLoading && streamState === 'connected';
  const rows = mode === 'inbox' ? submissions : ideas;

  const currentScope = detail?.scopeVersions.find((scope) => scope.id === detail.currentScopeVersionId);
  const origin = detail?.submissions[0];
  const isCurrentDetail = detail?.id === selectedId;

  function openQueue(next: 'inbox' | 'review') {
    setMode(next);
    setFilter(next === 'review' ? 'pending_review' : '');
    setMobileView('list');
    setShowIntake(false);
    setNavigationOpen(false);
  }

  function openSection(next: string) {
    setActiveTab(next);
    setMobileView('detail');
    setShowIntake(false);
    setNavigationOpen(false);
  }

  const navigation = <nav className="primary-navigation" aria-label="工作台导航">
    <Button variant="ghost" className={mode === 'inbox' ? 'nav-item active' : 'nav-item'} aria-pressed={mode === 'inbox'} onClick={() => openQueue('inbox')}><Inbox />投稿收件箱</Button>
    <Button variant="ghost" className={mode === 'review' ? 'nav-item active' : 'nav-item'} aria-pressed={mode === 'review'} onClick={() => openQueue('review')}><Clock3 />待审队列</Button>
    <Button variant="ghost" className="nav-item" disabled={!isCurrentDetail} title="先选择创意，查看对应任务与执行" onClick={() => openSection('execution')}><FileText />项目与任务</Button>
    <Button variant="ghost" className="nav-item" disabled={!isCurrentDetail} title="先选择创意，查看对应合并与反馈" onClick={() => openSection('relationships')}><MessageSquare />反馈归属</Button>
  </nav>;

  const expectations = <Card className="panel expectations-panel">
    <details>
      <summary className="panel-header"><h3>全部期望功能 · {detail?.desiredFeatures.length ?? 0}</h3><Badge variant="outline">完整保留</Badge></summary>
      {detail?.desiredFeatures.length ? <ul className="feature-list">{detail.desiredFeatures.map((feature, index) => <li key={`${feature.submissionId}-${index}`}><span>{feature.text}</span><details className="audit-details"><summary>投稿来源</summary><small>{feature.submissionId}</small></details></li>)}</ul> : <p className="muted">尚未整理期望功能，可在原文卡片中补充整理。</p>}
    </details>
    <p className="muted">未入选的功能仍保留，后续可继续讨论；本次三个功能是独立范围。</p>
  </Card>;

  const aiStatus = detail && <Suspense fallback={<p role="status">正在加载 AI 判断面板…</p>}><AiPanel idea={detail} identity={identity} canWrite={canOperate && freshDetail} state={platformState} /></Suspense>;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳到工作区</a>
    <aside className="desktop-sidebar">
      <div className="brand"><span className="brand-mark"><Lightbulb aria-hidden="true" /></span><div><h1>直播创意工作台</h1><p>你出创意，我出 token</p></div></div>
      {navigation}
      <Card className="connection-card"><h3>接入状态</h3><p><span className="status-dot amber" />真实抖音未接通</p><p><span className="status-dot gray" /><a href="#integration-status">AI / 派单配置与授权</a></p></Card>
      <div className="sidebar-identity"><span className="avatar"><ClipboardList aria-hidden="true" /></span><div><strong>{identity?.actor ?? '身份待确认'}</strong><p>{identity?.roles.map((role) => roleLabels[role]).join(' / ') || '只读'}</p></div></div>
    </aside>
    <div className="app-body">
      <header className="app-header">
        <div className="mobile-brand">
          <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
            <SheetTrigger asChild><Button variant="ghost" size="icon" aria-label="打开工作台导航"><Menu /></Button></SheetTrigger>
            <SheetContent side="left" className="navigation-sheet">
              <SheetHeader><SheetTitle>直播创意工作台</SheetTitle><SheetDescription>收集投稿、人工审核与反馈归属</SheetDescription></SheetHeader>
              {navigation}
              <p className="muted">真实抖音尚未接通；AI 与派单状态以服务端配置和平台记录为准。</p>
            </SheetContent>
          </Sheet>
          <span className="brand-mark"><Lightbulb aria-hidden="true" /></span><strong>创意工作台</strong>
        </div>
        <p className="breadcrumb">工作台 <span>/</span> <strong>{mode === 'inbox' ? '投稿收件箱' : '待审队列'}</strong></p>
        <div className="header-actions">
          <Button variant="outline" aria-label="刷新数据" onClick={() => setStreamEpoch((epoch) => epoch + 1)}><RefreshCw /><span>刷新</span></Button>
          <Button onClick={() => { setShowIntake((shown) => !shown); setMobileView('detail'); }} disabled={!canOperate || !!identityError || streamState !== 'connected'} aria-label={showIntake ? '关闭录入' : '录入投稿'}><Plus /><span>{showIntake ? '关闭录入' : '录入投稿'}</span></Button>
        </div>
      </header>
      <Alert className="integration-banner"><Info /><AlertDescription>真实抖音尚未接通。人工与示例投稿均明确标记；AI 配置完整不代表已验证远端可用，批准不自动启动。</AlertDescription></Alert>
      <IntegrationPanel state={platformState} />
      <div className="status-strip" aria-label="连接与接入状态">
        <span className={`connection ${streamState}`} aria-hidden="true" />
        <span>{identityError ? '后端访问异常' : identity ? '后端已响应' : '正在连接后端'}</span>
        <span>{streamState === 'connected' ? '实时更新已连接' : streamState === 'disconnected' ? '实时更新断线 · 可手动刷新' : '实时更新连接中'}</span>
        {updatedAt && <span className="last-update">列表更新 {updatedAt}</span>}
      </div>
      <main id="main-content" className={`workspace mobile-${mobileView}`}>
        <aside id="inbox-navigation" className="inbox" aria-label="投稿导航">
          <div className="panel-header"><h2>{mode === 'inbox' ? '投稿收件箱' : '待审队列'}</h2><span className="muted">{rows.length} 条已加载</span></div>
          <label className="list-filter">{mode === 'inbox' ? '投稿来源' : '审核状态'}
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>{mode === 'inbox' ? <><option value="">全部来源</option><option value="manual">人工录入</option><option value="sample">示例投稿</option><option value="douyin">真实抖音评论</option></> : <><option value="">全部创意</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</>}</select>
          </label>
          {listError && <p className="notice danger" role="alert">{listError} 已保留的数据可能过期，请刷新核实。</p>}
          {listLoading && <p className="muted" role="status">正在读取列表…</p>}
          {!listLoading && !listError && rows.length === 0 && <div className="empty"><Inbox aria-hidden="true" /><h3>{mode === 'inbox' ? '暂无投稿' : '此队列暂无创意'}</h3><p>{mode === 'inbox' ? '录入人工或明确标记的示例投稿，开始收集创意。' : '提交本次范围后进入待审，也可切换状态查看。'}</p></div>}
          <ul className="inbox-list">
            {mode === 'inbox' ? submissions.map((submission) => <li key={submission.id}>
              <Button variant="ghost" className={`inbox-item ${selectedId === submission.ideaId ? 'selected' : ''}`} aria-pressed={selectedId === submission.ideaId} onClick={() => selectIdea(submission.ideaId)}>
                <strong>{submission.fields.title ?? '未命名投稿'}</strong>
                <span className="excerpt">{submission.fields.problem ?? submission.rawText}</span>
                <span className="inline-meta"><Badge variant="secondary">{sourceLabels[submission.source]}</Badge><time dateTime={submission.receivedAt}>{new Date(submission.receivedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></span>
                <small>{submission.authorName ?? '未署名'}{submission.isSimulated ? ' · 非真实抖音接入' : ''}</small>
              </Button>
            </li>) : ideas.map((idea) => <li key={idea.id}>
              <Button variant="ghost" className={`inbox-item ${selectedId === idea.id ? 'selected' : ''}`} aria-pressed={selectedId === idea.id} onClick={() => selectIdea(idea.id)}>
                <strong>{idea.title}</strong><span className="inline-meta"><Badge variant="secondary" className={`state-${idea.status}`}>{statusLabels[idea.status]}</Badge><small>{idea.submissionCount} 条投稿 · {idea.feedbackCount} 条反馈</small></span><small>{idea.hasSimulatedSubmissions ? '含非真实接入投稿' : '来源见详情'}</small>
              </Button>
            </li>)}
          </ul>
          {cursor && <Button variant="outline" className="load-more" disabled={listLoading} onClick={() => void loadList(cursor)}>加载更多</Button>}
          <p className="list-hint">先选创意，再确认本次范围。</p>
        </aside>
        <div className="detail-column">
          <Button variant="ghost" className="return-to-list" onClick={() => { setMobileView('list'); setShowIntake(false); }}><ArrowLeft />返回投稿列表</Button>
          {identityError && <p className="notice danger" role="alert">{identityError} 操作已停用；客户端不持有代理密钥。</p>}
          {showIntake && <IntakeForm canOperate={canOperate && !identityError && streamState === 'connected'} onCreated={onCreated} />}
          {detailError && <p className="notice danger" role="alert">{detailError} 详情尚未核实，操作已停用；刷新不会自动重放写操作。</p>}
          {detailLoading && <p className="notice" role="status">正在核实创意详情…</p>}
          {!selectedId && !showIntake && <Card className="panel welcome"><Lightbulb className="welcome-icon" aria-hidden="true" /><p className="eyebrow">把一个想法，做成一个小作品</p><h2>选择投稿，开始人工选题</h2><p>完整保留观众期望，只批准本次三个功能。建任务、审核、分配、执行分开确认。</p><div className="welcome-flow"><span>收集投稿</span><span>确认三项</span><span>人工审核</span><span>人工派单</span></div></Card>}
          {detail && isCurrentDetail && <div className="idea-content stack" key={detail.id} hidden={showIntake}>
            <section className="detail-heading">
              <div><h2>{detail.title}</h2><p className="muted">目标用户：{origin?.fields.targetUsers ?? '尚未整理'} · 问题：{origin?.fields.problem ?? '尚未整理'}</p><div className="inline-meta">{detail.hasSimulatedSubmissions && <Badge variant="secondary">含示例 / 非真实接入投稿</Badge>}{currentScope && <Badge variant="outline">范围 v{currentScope.versionNo}</Badge>}</div></div>
              <Badge variant="secondary" className={`state-${detail.status}`}>{statusLabels[detail.status]}</Badge>
            </section>
            <Tabs value={activeTab} onValueChange={setActiveTab} className="detail-tabs">
              <TabsList className="detail-tab-list" aria-label="创意详情章节">
                <TabsTrigger value="original">原文与整理</TabsTrigger><TabsTrigger value="scope">三功能与审核</TabsTrigger><TabsTrigger value="relationships">合并与反馈</TabsTrigger><TabsTrigger value="execution">任务与执行</TabsTrigger>
              </TabsList>
              <TabsContent value="scope" forceMount className="detail-tab-content stack">
                <ScopePanel idea={detail} canOperate={canOperate && freshDetail} canReview={canReview && freshDetail} onSaved={refresh}>{expectations}{aiStatus}</ScopePanel>
              </TabsContent>
              <TabsContent value="original" forceMount className="detail-tab-content stack">
                {expectations}
                <Card id="original-records" className="panel"><div className="panel-header"><h2>原文与整理结果</h2><Badge variant="outline">{detail.submissions.length} 条来源</Badge></div><div className="stack">{detail.submissions.map((submission) => <SubmissionRecord key={submission.id} submission={submission} canOperate={canOperate && freshDetail && !['merged', 'rejected'].includes(detail.status)} onSaved={refresh} />)}</div></Card>
              </TabsContent>
              <TabsContent value="relationships" forceMount className="detail-tab-content stack">
                <RelationshipPanel idea={detail} canOperate={canOperate && freshDetail} onSaved={refresh} />
                {detail.feedback.length > 0 && <Card id="feedback-records" className="panel"><h2>补充反馈</h2><p className="muted">反馈归属此创意，不自动改变已批准范围。</p><div className="stack">{detail.feedback.map((submission) => <SubmissionRecord key={submission.id} submission={submission} canOperate={canOperate && freshDetail && !['merged', 'rejected'].includes(detail.status)} onSaved={refresh} />)}</div></Card>}
              </TabsContent>
              <TabsContent value="execution" forceMount className="detail-tab-content stack"><Suspense fallback={<p role="status">正在加载任务与执行面板…</p>}><ExecutionPanel idea={detail} identity={identity} canWrite={freshDetail} state={platformState} /></Suspense></TabsContent>
            </Tabs>
          </div>}
        </div>
      </main>
      <footer className="app-footer">批准不默认分配 agent；分配与确认启动分别进行。</footer>
    </div>
  </div>;
}
