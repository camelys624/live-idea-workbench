import type {
  AiIntegrationDto,
  IntegrationState,
  IntegrationStatusDto,
  MulticaIntegrationDto,
  ReadinessCheckDto,
} from '@workbench/contracts';

/**
 * AI 与 Multica 集成的部署配置（ROBB-11）。
 *
 * 只读取环境变量，不访问网络：这里回答“部署方配置了什么”，不回答“远端是否可用”。
 * 配置缺失或无效不阻止工作台启动；核心投稿/审核流程照常可用，相关操作返回 503。
 * 密钥只保存在本模块返回的 settings 中，绝不进入 IntegrationStatusDto 或日志。
 */

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface MulticaSettings {
  /** 部署主机上用 `multica --profile <name> login --token` 写入的独立身份配置名。 */
  profile: string;
  serverUrl: string;
  workspaceId: string;
  workbenchProjectId: string;
  productRepoUrl: string;
  writesEnabled: boolean;
  executionEnabled: boolean;
}

export interface Integrations {
  status: IntegrationStatusDto;
  /** 仅 state=configured 时非 null。 */
  ai: AiSettings | null;
  multica: MulticaSettings | null;
}

type Env = Record<string, string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GITHUB_REPO = /^(?:git@github\.com:|https:\/\/github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?$/;
const DEFAULT_MULTICA_SERVER = 'https://api.multica.ai';

const AI_KEYS = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'] as const;
const MULTICA_KEYS = [
  'WORKBENCH_MULTICA_PROFILE',
  'WORKBENCH_MULTICA_WORKSPACE_ID',
  'WORKBENCH_MULTICA_PROJECT_ID',
  'WORKBENCH_PRODUCT_REPO_URL',
] as const;

function value(env: Env, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

function check(key: string, ok: boolean, okMessage: string, failMessage: string): ReadinessCheckDto {
  return { key, ok, message: ok ? okMessage : failMessage };
}

function stateOf(anySet: boolean, checks: ReadinessCheckDto[]): IntegrationState {
  if (!anySet) return 'not_configured';
  return checks.every((c) => c.ok) ? 'configured' : 'invalid';
}

/** https，或仅限本机的 http（本地模型网关）。 */
function isAllowedEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

function flag(env: Env, key: string): boolean | 'invalid' {
  const v = value(env, key);
  if (v === undefined || v === 'false') return false;
  if (v === 'true') return true;
  return 'invalid';
}

function loadAi(env: Env): { dto: AiIntegrationDto; settings: AiSettings | null } {
  const baseUrl = value(env, 'AI_BASE_URL');
  const apiKey = value(env, 'AI_API_KEY');
  const model = value(env, 'AI_MODEL');
  const anySet = AI_KEYS.some((k) => value(env, k) !== undefined);

  const checks = anySet
    ? [
        check('ai.base_url', !!baseUrl && isAllowedEndpoint(baseUrl), '模型接口地址已配置',
          baseUrl ? 'AI_BASE_URL 须为 https 地址（仅本机可用 http），且不得内嵌账号' : '缺少 AI_BASE_URL'),
        check('ai.api_key', !!apiKey, '模型密钥已配置', '缺少 AI_API_KEY'),
        check('ai.model', !!model, '模型已指定', '缺少 AI_MODEL'),
      ]
    : [check('ai.configured', false, '', '未配置模型服务：AI 判断不可用，投稿仍可人工审核')];

  const state = stateOf(anySet, checks);
  return {
    dto: {
      state,
      provider: state === 'configured' ? 'openai-compatible' : null,
      model: model ?? null,
      dataScope: 'simulated_only',
      checks,
    },
    settings: state === 'configured' ? { baseUrl: baseUrl!, apiKey: apiKey!, model: model! } : null,
  };
}

function loadMultica(env: Env): { dto: MulticaIntegrationDto; settings: MulticaSettings | null } {
  const profile = value(env, 'WORKBENCH_MULTICA_PROFILE');
  const workspaceId = value(env, 'WORKBENCH_MULTICA_WORKSPACE_ID');
  const projectId = value(env, 'WORKBENCH_MULTICA_PROJECT_ID');
  const repoUrl = value(env, 'WORKBENCH_PRODUCT_REPO_URL');
  const serverUrl = value(env, 'WORKBENCH_MULTICA_SERVER_URL') ?? DEFAULT_MULTICA_SERVER;
  const writes = flag(env, 'WORKBENCH_MULTICA_WRITES_ENABLED');
  const execution = flag(env, 'WORKBENCH_MULTICA_EXECUTION_ENABLED');
  const anySet = MULTICA_KEYS.some((k) => value(env, k) !== undefined) || writes !== false || execution !== false;

  // 工作台进程若运行在 Multica agent run 内，CLI 会改用 run 的任务凭据；部署身份必须独立。
  const insideAgentRun = [
    'MULTICA_TOKEN', 'MULTICA_TASK_ID', 'MULTICA_AGENT_ID', 'MULTICA_TASK_CONFIG_ROOT',
    'MULTICA_DAEMON_PORT', 'MULTICA_WORKSPACES_ROOT',
  ].some(key => env[key] !== undefined);
  const validServer = isAllowedEndpoint(serverUrl) && new URL(serverUrl).protocol === 'https:';

  const checks = anySet
    ? [
        check('multica.isolated_identity', !insideAgentRun, '未检测到 agent run 凭据',
          '检测到 Multica agent run 环境（MULTICA_TASK_ID / mat_ 任务凭据）；部署身份不得复用 run 凭据'),
        check('multica.profile', !!profile && PROFILE.test(profile) && profile.toLowerCase() !== 'default', '独立部署身份配置名已指定',
          profile ? 'WORKBENCH_MULTICA_PROFILE 须为非 default 的独立配置名，只含字母、数字、- 和 _' : '缺少 WORKBENCH_MULTICA_PROFILE（部署主机上独立登录的 CLI 配置名）'),
        check('multica.server_url', validServer, 'Multica 服务地址有效', 'WORKBENCH_MULTICA_SERVER_URL 须为无查询参数、无凭据的 https 地址'),
        check('multica.workspace', !!workspaceId && UUID.test(workspaceId), '目标 workspace 已指定',
          workspaceId ? 'WORKBENCH_MULTICA_WORKSPACE_ID 须为 UUID' : '缺少 WORKBENCH_MULTICA_WORKSPACE_ID'),
        check('multica.workbench_project', !!projectId && UUID.test(projectId), '工作台项目已指定',
          projectId ? 'WORKBENCH_MULTICA_PROJECT_ID 须为 UUID' : '缺少 WORKBENCH_MULTICA_PROJECT_ID'),
        check('multica.product_repo', !!repoUrl && GITHUB_REPO.test(repoUrl), '小产品交付仓库已指定',
          repoUrl ? 'WORKBENCH_PRODUCT_REPO_URL 须为 GitHub 仓库地址' : '缺少 WORKBENCH_PRODUCT_REPO_URL'),
        check('multica.writes_flag', writes !== 'invalid', '写入开关取值有效', 'WORKBENCH_MULTICA_WRITES_ENABLED 只能是 true 或 false'),
        check('multica.execution_flag', execution !== 'invalid' && !(execution === true && writes !== true),
          '启动开关取值有效',
          execution === 'invalid'
            ? 'WORKBENCH_MULTICA_EXECUTION_ENABLED 只能是 true 或 false'
            : '开启启动授权前须先开启 WORKBENCH_MULTICA_WRITES_ENABLED'),
      ]
    : [check('multica.configured', false, '', '未配置 Multica 部署身份：建任务、立项、分配和启动不可用')];

  const state = stateOf(anySet, checks);
  const writesEnabled = state === 'configured' && writes === true;
  const executionEnabled = writesEnabled && execution === true;
  if (state === 'configured') {
    checks.push(
      check('multica.writes_enabled', writesEnabled, '已授权 Multica 写入', '未开启 Multica 写入授权（WORKBENCH_MULTICA_WRITES_ENABLED）'),
      check('multica.execution_enabled', executionEnabled, '已授权启动 agent', '未开启启动授权（WORKBENCH_MULTICA_EXECUTION_ENABLED）'),
    );
  }

  return {
    dto: {
      state,
      workspaceId: workspaceId ?? null,
      workbenchProjectId: projectId ?? null,
      productRepoUrl: repoUrl ?? null,
      writesEnabled,
      executionEnabled,
      checks,
    },
    settings:
      state === 'configured'
        ? {
            profile: profile!,
            serverUrl,
            workspaceId: workspaceId!,
            workbenchProjectId: projectId!,
            productRepoUrl: repoUrl!,
            writesEnabled,
            executionEnabled,
          }
        : null,
  };
}

export function loadIntegrations(env: Env = process.env): Integrations {
  const ai = loadAi(env);
  const multica = loadMultica(env);
  return {
    status: { ai: ai.dto, multica: multica.dto },
    ai: ai.settings,
    multica: multica.settings,
  };
}
