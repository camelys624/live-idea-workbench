import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentOptionDto, ExecutionRunDto, PlatformOperationKind, ReadinessCheckDto } from '@workbench/contracts';
import type { MulticaSettings } from '../../integrations.ts';

const execFileAsync = promisify(execFile);

export interface GatewayPayload {
  marker: string;
  title?: string;
  description?: string;
  projectId?: string;
  issueId?: string;
  agentId?: string;
  repoPath?: string;
}

export interface GatewayTask {
  id: string;
  identifier: string;
  status: string;
  assigneeAgentId: string | null;
  projectId: string | null;
  checks: ReadinessCheckDto[];
  runs: ExecutionRunDto[];
}
type Reconciliation = { outcome: 'found' | 'absent' | 'ambiguous'; id: string | null };

export interface Gateway {
  readAgents(): Promise<AgentOptionDto[]>;
  readTask(issueId: string): Promise<GatewayTask>;
  perform(kind: PlatformOperationKind, payload: GatewayPayload): Promise<{ id: string }>;
  reconcile(kind: PlatformOperationKind, payload: GatewayPayload): Promise<Reconciliation>;
}

/** Messages are fixed application text: never expose CLI stderr, argv, tokens or remote errors. */
export class GatewayError extends Error {
  readonly knownNotWritten: boolean;

  constructor(message: string, knownNotWritten: boolean) {
    super(message);
    this.name = 'GatewayError';
    this.knownNotWritten = knownNotWritten;
  }
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE = /^[a-zA-Z0-9_-]+$/;
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const REPO_PATH = /^products\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_PAGES = 1000;
const AMBIGUOUS: Reconciliation = { outcome: 'ambiguous', id: null };
const ABSENT: Reconciliation = { outcome: 'absent', id: null };

function fail(message: string): never {
  throw new GatewayError(message, true);
}

function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError('Multica 返回的数据结构无法确认；请先对账', false);
  }
  return value as Row;
}

function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new GatewayError('Multica 列表格式无法确认；请先对账', false);
  return value.map(row);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayError('Multica 缺少必要字段；请先对账', false);
  }
  return value;
}

function id(value: unknown): string {
  const result = text(value);
  if (!UUID.test(result)) throw new GatewayError('Multica 对象标识无法确认；请先对账', false);
  return result;
}

function inputId(value: string | undefined): string {
  if (!value || !UUID.test(value)) fail('Multica 操作缺少有效的对象标识');
  return value;
}

function nullableId(value: unknown): string | null {
  return value === null ? null : id(value);
}

function check(key: string, ok: boolean, message: string): ReadinessCheckDto {
  return { key, ok, message };
}

function inert(content: string): string {
  // The documented trigger parser consumes mention://agent and mention://squad.
  // Neutralize the entire scheme (also inside Markdown/HTML) rather than trying
  // to reproduce the backend's Markdown matching or relying on escaping labels.
  return content.replace(/mention\s*:/gi, 'mention-disabled:').replace(/\u0000/g, '');
}

function markerLine(marker: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(marker)) fail('Multica 操作标记格式无效');
  return `[workbench-operation:${marker}]`;
}

function hasMarker(description: unknown, marker: string): boolean {
  return typeof description === 'string' && description.split(/\r?\n/).includes(marker);
}

function assertOutsideTask(): void {
  // Enforce this independently of settings validation and before *every* child,
  // so injecting settings or later changing the process environment cannot
  // turn a managed task into a host-profile escape hatch.
  const signals = ['MULTICA_TOKEN', 'MULTICA_TASK_ID', 'MULTICA_AGENT_ID', 'MULTICA_TASK_CONFIG_ROOT',
    'MULTICA_DAEMON_PORT', 'MULTICA_WORKSPACES_ROOT'];
  if (signals.some((key) => process.env[key] !== undefined)) {
    fail('Multica gateway 不得在 agent task 环境中使用；请部署到独立主机身份环境');
  }
}

function childEnv(): NodeJS.ProcessEnv {
  // Deliberately no spread of process.env: this excludes ALL MULTICA_* vars,
  // provider credentials, proxy credentials, NODE_OPTIONS, and workspace vars.
  // HOME/XDG are needed only to locate the explicitly named independent profile.
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_STATE_HOME', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

/**
 * CLI contract: installed `multica ... --help` plus public command/response
 * schemas at https://github.com/multica-ai/multica/tree/e752b971b8c661ad7b2dfe1a049442d7c40f359a/server
 * (cmd/multica/cmd_{agent,issue,project,runtime,user}.go and internal/handler).
 * No speculative JSON aliases or undocumented CLI flags are accepted.
 */
export class CliGateway implements Gateway {
  readonly #settings: Readonly<MulticaSettings>;

  constructor(settings: MulticaSettings) {
    assertOutsideTask();
    const productRepoUrl = settings.productRepoUrl.replace(/^git@github\.com:/, 'https://github.com/');
    if (!PROFILE.test(settings.profile) || settings.profile.toLowerCase() === 'default' ||
      !UUID.test(settings.workspaceId) || !UUID.test(settings.workbenchProjectId) || !REPO.test(productRepoUrl)) {
      fail('Multica 独立配置身份、workspace、项目或交付仓库配置无效');
    }
    let endpoint: URL;
    try { endpoint = new URL(settings.serverUrl); } catch { fail('Multica 服务地址无效'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      fail('Multica 服务地址必须是不含凭据的 HTTPS 地址');
    }
    this.#settings = Object.freeze({ ...settings, productRepoUrl });
  }

  async #command(args: string[], cwd = tmpdir()): Promise<unknown> {
    assertOutsideTask();
    const scope = ['--profile', this.#settings.profile, '--server-url', this.#settings.serverUrl,
      '--workspace-id', this.#settings.workspaceId];
    // Only private call sites below construct subcommands. execFile never invokes
    // a shell; text, UUIDs and paths are separate argv entries, never commands.
    try {
      const { stdout, stderr } = await execFileAsync('multica', [...scope, ...args, '--output', 'json'], {
        cwd, env: childEnv(), shell: false, windowsHide: true,
        timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
      });
      // assign/status deliberately emit success confirmations on stderr even
      // with --output json. Read commands still fail closed on warnings (for
      // example server-capped run history); never merge stderr into JSON.
      const confirmsMutation = args[0] === 'issue' && (args[1] === 'assign' || args[1] === 'status');
      if (stderr.trim() && !confirmsMutation) {
        throw new GatewayError('Multica 输出包含警告，无法确认结果完整；请先对账', false);
      }
      return JSON.parse(stdout) as unknown;
    } catch {
      // Once execution is attempted even timeout, malformed JSON or a CLI-side
      // error may follow a successful remote write. Never classify it retryable.
      throw new GatewayError('Multica 命令未得到可确认的完整结果；写入可能已生效，请先对账', false);
    }
  }

  #workspace(value: Row): void {
    if (value.workspace_id !== this.#settings.workspaceId) {
      throw new GatewayError('Multica 返回的对象不属于配置的 workspace', false);
    }
  }

  async readAgents(): Promise<AgentOptionDto[]> {
    const agents = rows(await this.#command(['agent', 'list', '--include-archived']));
    let runtimes: Row[] = [];
    let viewerId: string | null = null;
    try { runtimes = rows(await this.#command(['runtime', 'list'])); } catch { /* Runtime proof stays false. */ }
    try { viewerId = id(row(await this.#command(['user', 'profile', 'get'])).id); } catch { /* No owner/member permission proof. */ }
    const runtimeMap = new Map<string, Row>();
    for (const runtime of runtimes) {
      this.#workspace(runtime);
      const runtimeId = id(runtime.id);
      if (runtimeMap.has(runtimeId)) throw new GatewayError('Multica runtime 列表出现重复对象', false);
      runtimeMap.set(runtimeId, runtime);
    }
    const seen = new Set<string>();
    return agents.map((agent) => {
      this.#workspace(agent);
      const agentId = id(agent.id);
      if (seen.has(agentId)) throw new GatewayError('Multica agent 列表出现重复对象', false);
      seen.add(agentId);
      const runtimeId = agent.runtime_id === '' || agent.runtime_id === null ? null : id(agent.runtime_id);
      const runtime = runtimeId ? runtimeMap.get(runtimeId) : undefined;
      const runtimeOnline = runtime?.status === 'online';
      // Missing archived_at is not equivalent to an authoritative null.
      const archived = agent.archived_at !== null;
      const owner = viewerId !== null && agent.owner_id === viewerId;
      const targets = Array.isArray(agent.invocation_targets) ? agent.invocation_targets.map(row) : [];
      const invocable = (agent.permission_mode === 'private' && owner) ||
        (agent.permission_mode === 'public_to' && (owner || targets.some((target) =>
          (target.target_type === 'workspace' && target.target_id === this.#settings.workspaceId) ||
          (target.target_type === 'member' && viewerId !== null && target.target_id === viewerId))));
      return {
        id: agentId, name: inert(text(agent.name)), runtimeId,
        runtimeName: runtime && typeof runtime.name === 'string' ? inert(runtime.name) : null,
        runtimeOnline, archived, invocable,
        checks: [
          check('agent.active', !archived, archived ? 'Agent 已归档或归档状态无法确认' : 'Agent 未归档'),
          check('agent.runtime_bound', runtimeId !== null, runtimeId ? 'Agent 已绑定 runtime' : 'Agent 未绑定 runtime'),
          check('agent.runtime_online', runtimeOnline, runtimeOnline ? 'Runtime 在线' : 'Runtime 离线或当前身份无法确认其在线状态'),
          check('agent.invocable', invocable, invocable ? '独立部署身份具有调用权限' : '无法确认独立部署身份的调用权限（不以可见性代替权限）'),
        ],
      };
    });
  }

  async #issue(issueId: string): Promise<Row> {
    const issue = row(await this.#command(['issue', 'get', inputId(issueId)]));
    this.#workspace(issue);
    if (id(issue.id) !== issueId) throw new GatewayError('Multica 返回了不同的 issue', false);
    return issue;
  }

  async #runs(issueId: string): Promise<ExecutionRunDto[]> {
    const seen = new Set<string>();
    return rows(await this.#command(['issue', 'runs', issueId])).map((run) => {
      const runId = id(run.id);
      if (seen.has(runId)) throw new GatewayError('Multica 运行历史出现重复对象', false);
      seen.add(runId);
      return {
        id: runId, agentId: id(run.agent_id), status: text(run.status),
        startedAt: run.started_at === null ? null : text(run.started_at),
        completedAt: run.completed_at === null ? null : text(run.completed_at),
        error: run.error === null || run.error === '' ? null : '平台运行报告错误；详情请在 Multica 查看',
      };
    });
  }

  async readTask(issueId: string): Promise<GatewayTask> {
    const issue = await this.#issue(issueId);
    const runs = await this.#runs(issueId);
    const projectId = nullableId(issue.project_id);
    const assigneeId = nullableId(issue.assignee_id);
    const assigneeAgentId = issue.assignee_type === 'agent' ? assigneeId : null;
    const independent = issue.parent_issue_id === null && issue.stage === null;
    return {
      id: id(issue.id), identifier: text(issue.identifier), status: text(issue.status),
      assigneeAgentId, projectId, runs,
      checks: [
        check('task.project', projectId !== null, projectId ? '任务已绑定项目' : '任务未绑定项目'),
        check('task.backlog', issue.status === 'backlog', issue.status === 'backlog' ? '任务保持 backlog，尚未启动' : '任务不在 backlog，不能按首次启动处理'),
        check('task.assignee', assigneeAgentId !== null, assigneeAgentId ? '任务已分配给 agent' : '任务尚未分配给 agent'),
        // The documented platform dependency model is parent/stage barriers,
        // advanced explicitly by a parent agent, not an implicit dependency graph.
        // This gateway creates only independent issues. Missing schema fields or
        // subsequently added parent/stage relationships fail closed.
        check('task.dependencies', independent, independent ? '独立任务，无父任务或阶段依赖' : '任务存在父任务/阶段依赖或字段缺失；不能确认依赖已完成'),
        check('task.no_runs', runs.length === 0, runs.length === 0 ? '未发现已有执行记录' : '已有执行记录，不允许作为首次启动重复执行'),
      ],
    };
  }

  async perform(kind: PlatformOperationKind, payload: GatewayPayload): Promise<{ id: string }> {
    assertOutsideTask();
    if (!this.#settings.writesEnabled) fail('Multica 写入尚未授权');
    const marker = markerLine(payload.marker);
    if (kind === 'create_product_project') {
      if (!payload.repoPath || !REPO_PATH.test(payload.repoPath)) fail('产品目录必须是 products 下的独立目录');
      if (!payload.title?.trim()) fail('Multica 项目缺少标题');
      // Installed project create has no description-file/stdin flag. This one
      // explicitly authorized inline exception contains ONLY fixed trusted
      // metadata, never the human/untrusted issue body or description payload.
      const description = `${marker}\nDelivery directory: ${payload.repoPath}`;
      const result = row(await this.#command(['project', 'create', '--title', inert(payload.title),
        '--description', description, '--repo', this.#settings.productRepoUrl]));
      this.#workspace(result);
      return { id: id(result.id) };
    }
    if (kind === 'create_review_task' || kind === 'create_dev_task') {
      if (!payload.title?.trim()) fail('Multica 任务缺少标题');
      const projectId = kind === 'create_review_task' ? this.#settings.workbenchProjectId : inputId(payload.projectId);
      let directory: string | undefined;
      let attempted = false;
      try {
        directory = await mkdtemp(join(tmpdir(), 'workbench-multica-'));
        await chmod(directory, 0o700);
        const file = join(directory, 'description.txt');
        await writeFile(file, `${inert(payload.description ?? '')}\n\n${marker}\n`, { mode: 0o600, flag: 'wx' });
        await chmod(file, 0o600);
        attempted = true;
        const result = row(await this.#command(['issue', 'create', '--title', inert(payload.title),
          '--description-file', file, '--project', projectId, '--status', 'backlog'], directory));
        this.#workspace(result);
        if (result.project_id !== projectId || result.status !== 'backlog' ||
          result.assignee_id !== null || result.assignee_type !== null) {
          throw new GatewayError('平台创建结果未确认是目标项目下的未分配 backlog；请先对账', false);
        }
        // No assignee flag, no parent/stage, no subsequent assignment or launch.
        return { id: id(result.id) };
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError('Multica 私有描述文件无法安全准备或读取', !attempted);
      } finally {
        if (directory) {
          try { await rm(directory, { recursive: true, force: true }); }
          catch { throw new GatewayError('Multica 私有描述文件清理失败；请先对账并检查主机临时目录权限', !attempted); }
        }
      }
    }
    if (kind !== 'assign_agent' && kind !== 'launch') fail('不支持的 Multica 操作');
    if (kind === 'launch' && !this.#settings.executionEnabled) fail('Multica 启动尚未授权');
    const issueId = inputId(payload.issueId);
    const agentId = inputId(payload.agentId);
    const projectId = inputId(payload.projectId);
    // Fresh reads directly before the mutation, never a cached readiness DTO.
    const agents = await this.readAgents();
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent || !agent.checks.every((entry) => entry.ok)) fail('Agent 调用权限、归档或 runtime 就绪检查未通过');
    const issue = await this.#issue(issueId);
    if (issue.project_id !== projectId || issue.status !== 'backlog') fail('任务项目或 backlog 状态已变化；请刷新后再操作');
    const runs = await this.#runs(issueId);
    if (runs.length !== 0) fail('任务已有执行记录，不能重复分配或启动');
    if (kind === 'assign_agent') {
      await this.#command(['issue', 'assign', issueId, '--to-id', agentId, '--no-start']);
    } else {
      if (issue.assignee_type !== 'agent' || issue.assignee_id !== agentId) fail('任务当前 agent 分配已变化；请刷新后再操作');
      if (issue.parent_issue_id !== null || issue.stage !== null) fail('无法确认任务的父任务/阶段依赖已完成');
      await this.#command(['issue', 'status', issueId, 'todo']);
    }
    return { id: issueId };
  }

  async reconcile(kind: PlatformOperationKind, payload: GatewayPayload): Promise<Reconciliation> {
    assertOutsideTask();
    const marker = markerLine(payload.marker);
    try {
      if (kind === 'assign_agent' || kind === 'launch') {
        const issueId = inputId(payload.issueId);
        const agentId = inputId(payload.agentId);
        const issue = await this.#issue(issueId);
        if (issue.project_id !== inputId(payload.projectId)) return AMBIGUOUS;
        const runs = await this.#runs(issueId);
        if (kind === 'assign_agent') {
          if (issue.status === 'backlog' && issue.assignee_type === 'agent' && issue.assignee_id === agentId && runs.length === 0) {
            return { outcome: 'found', id: issueId };
          }
          // A different assignee may be a later human edit, not proof our write
          // never happened. No assignment result can safely be called absent.
          return AMBIGUOUS;
        }
        if (issue.assignee_type === 'agent' && issue.assignee_id === agentId && issue.status !== 'backlog' &&
          runs.some((run) => run.agentId === agentId)) return { outcome: 'found', id: issueId };
        // A delayed queue, rollback, or older run cannot prove a launch absent.
        return AMBIGUOUS;
      }
      if (kind === 'create_product_project') {
        // Public ListProjects is unpaginated and returns every workspace row;
        // CLI prints that full array. Any stderr, malformed/duplicate row or
        // unsupported response aborts the scan rather than proving absence.
        const projects = rows(await this.#command(['project', 'list']));
        const seen = new Set<string>();
        const matches: string[] = [];
        for (const project of projects) {
          this.#workspace(project);
          const projectId = id(project.id);
          if (seen.has(projectId)) return AMBIGUOUS;
          seen.add(projectId);
          if (project.description !== null && typeof project.description !== 'string') return AMBIGUOUS;
          if (hasMarker(project.description, marker)) matches.push(projectId);
        }
        if (matches.length > 1) return AMBIGUOUS;
        return matches.length === 1 ? { outcome: 'found', id: matches[0]! } : ABSENT;
      }
      if (kind !== 'create_review_task' && kind !== 'create_dev_task') return AMBIGUOUS;
      const projectId = kind === 'create_review_task' ? this.#settings.workbenchProjectId : inputId(payload.projectId);
      const seen = new Set<string>();
      const matches: string[] = [];
      let offset = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = row(await this.#command(['issue', 'list', '--project', projectId,
          '--limit', '100', '--offset', String(offset), '--sort', 'created_at', '--direction', 'asc']));
        const issues = rows(response.issues);
        if (issues.length > 100) return AMBIGUOUS;
        for (const issue of issues) {
          this.#workspace(issue);
          const issueId = id(issue.id);
          if (seen.has(issueId) || issue.project_id !== projectId) return AMBIGUOUS;
          seen.add(issueId);
          if (issue.description !== null && typeof issue.description !== 'string') return AMBIGUOUS;
          if (hasMarker(issue.description, marker)) matches.push(issueId);
        }
        // Read through an EMPTY page, never stop at has_more=false or total:
        // older servers substitute a page length after a failed count query.
        if (issues.length === 0) {
          if (response.has_more === true) return AMBIGUOUS;
          if (matches.length > 1) return AMBIGUOUS;
          return matches.length === 1 ? { outcome: 'found', id: matches[0]! } : ABSENT;
        }
        offset += issues.length;
      }
      return AMBIGUOUS;
    } catch {
      // Permission errors, truncated CLI output, unsupported schema and failed
      // reads never authorize retrying an operation whose result was unknown.
      return AMBIGUOUS;
    }
  }
}
